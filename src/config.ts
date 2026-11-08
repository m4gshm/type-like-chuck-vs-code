import * as vscode from 'vscode';
import { cpus } from 'os';
import { CustomTemplateDefinition } from './templates/types';
import { defaultEngineKind } from './local_engine/capability';
import { NPU_CONTEXT_LENGTH } from './local_engine/device';
import { DEFAULT_HF_BASE } from './local_engine/model_catalog';
import { DEFAULT_GITHUB_BASE, DEFAULT_RELEASE_TAG } from './local_engine/release_assets';
import { DEFAULT_OPENVINO_URL } from './local_engine/ov_runtime';

export type TlcMode = 'remote' | 'local';
export type LocalDevice = 'auto' | 'cpu' | 'gpu' | 'npu';
export type LocalEngineKind = 'llama.cpp' | 'ovgenai' | 'mlx';

export interface ExtensionConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  mode: TlcMode;
  localEngineKind: LocalEngineKind;
  localModel: string;
  localModelExplicit: boolean;
  localDevice: LocalDevice;
  localNpuContextMaxLength: number;
  localLlamaCppRelease: string;
  localEngineDir: string;
  localDistroDir: string;
  localDownloadedModelsDir: string;
  localModelCacheDir: string;
  localHuggingfaceUrl: string;
  localGithubUrl: string;
  localOpenvinoUrl: string;
  localCustomModelPath: string;
  localApiKeyEnabled: boolean;
  promptTemplate: string | undefined;
  customTemplate: CustomTemplateDefinition | undefined;
  prefixMaxLength: number;
  suffixMaxLength: number;
  contextMaxLength: number;
  maxTokens: number;
  debounceMs: number;
  pendingGraceMs: number;
  autoTrigger: boolean;
  cacheEnabled: boolean;
  cacheTtlMs: number;
  yieldToCopilot: boolean;
  forbiddenFileNames: string[];
}

const SECTION = 'tlc';

export function readConfig(): ExtensionConfig {
  const c = vscode.workspace.getConfiguration(SECTION);
  const prefix = c.get<string>('prefix', '');
  const suffix = c.get<string>('suffix', '');
  const middle = c.get<string>('middle', '');
  const hasMarkers = prefix.length > 0 || suffix.length > 0 || middle.length > 0;
  const stop = c
    .get<string>('stop', '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const rawMode = c.get<string>('mode', 'local');
  const rawDevice = c.get<string>('local.device', 'auto');
  // On the NPU the compiled graph is built for the context window: a smaller
  // window compiles faster and generates faster. The NPU limit caps the
  // prompt budgets in local mode when the NPU is explicitly selected.
  const mode = rawMode === 'remote' ? 'remote' : 'local';
  const device = rawDevice === 'gpu' || rawDevice === 'npu' || rawDevice === 'cpu' ? rawDevice : 'auto';
  const rawKind = c.get<string>('local.engineKind', 'auto');
  const engineKind: LocalEngineKind = rawKind === 'ovgenai' ? 'ovgenai' : rawKind === 'mlx' ? 'mlx' : 'llama.cpp';
  // "auto" (the default) resolves to the capability matrix: mlx on Apple
  // Silicon, ovgenai on Intel x64, llama.cpp elsewhere.
  const effectiveKind: LocalEngineKind = rawKind === 'auto' && engineKind === 'llama.cpp'
    ? defaultEngineKind(process.platform, process.arch, cpus()[0]?.model ?? '')
    : engineKind;
  const npuLimitRaw = c.get<number>('local.npuContextMaxLength', NPU_CONTEXT_LENGTH);
  // Only the ovgenai runner actually runs on the NPU (llama.cpp redirects an
  // explicit npu to GPU), so the NPU context cap applies there only.
  const npuEligible = mode === 'local' && npuLimitRaw > 0 && device === 'npu' && effectiveKind === 'ovgenai';
  let contextMaxLength = c.get<number>('contextMaxLength', 0);
  if (npuEligible && (contextMaxLength <= 0 || contextMaxLength > npuLimitRaw)) {
    contextMaxLength = npuLimitRaw;
  }
  return {
    baseUrl: c.get<string>('openai.baseUrl', c.get<string>('baseUrl', 'http://127.0.0.1:1234/v1')),
    model: c.get<string>('openai.model', c.get<string>('model', 'Qwen2.5-Coder-1.5B')),
    apiKey: c.get<string>('openai.apiKey', c.get<string>('apiKey', '')),
    mode,
    localEngineKind: effectiveKind,
    localModel: c.get<string>('local.model', 'Qwen2.5-Coder 1.5B'),
    localModelExplicit: c.get<string>('local.model', '').length > 0,
    localDevice: device,
    localNpuContextMaxLength: npuLimitRaw,
    localLlamaCppRelease: c.get<string>('local.llamaCppRelease', DEFAULT_RELEASE_TAG),
    localEngineDir: c.get<string>('local.engineDir', ''),
    localDistroDir: c.get<string>('local.distroDir', ''),
    localDownloadedModelsDir: c.get<string>('local.downloadedModelsDir', ''),
    localModelCacheDir: c.get<string>('local.modelCacheDir', ''),
    localHuggingfaceUrl: c.get<string>('local.huggingfaceUrl', DEFAULT_HF_BASE),
    localGithubUrl: c.get<string>('local.githubUrl', DEFAULT_GITHUB_BASE),
    localOpenvinoUrl: c.get<string>('local.openvinoUrl', DEFAULT_OPENVINO_URL),
    localCustomModelPath: c.get<string>('local.customModelPath', ''),
    localApiKeyEnabled: c.get<boolean>('local.apiKeyEnabled', true),
    promptTemplate: c.get<string>('promptTemplate'),
    customTemplate: hasMarkers
      ? { id: 'custom', prefix, suffix, middle, stop }
      : undefined,
    prefixMaxLength: c.get<number>('prefixContextMaxLength', 8000),
    suffixMaxLength: c.get<number>('suffixContextMaxLength', 2000),
    contextMaxLength,
    maxTokens: c.get<number>('maxTokens', 256),
    debounceMs: c.get<number>('debounceMs', 250),
    pendingGraceMs: c.get<number>('pendingGraceMs', 150),
    autoTrigger: c.get<boolean>('autoTrigger', true),
    cacheEnabled: c.get<boolean>('cacheEnabled', true),
    cacheTtlMs: c.get<number>('cacheTtlMs', 10_000),
    yieldToCopilot: c.get<boolean>('yieldToCopilot', true),
    forbiddenFileNames: c.get<string[]>('forbiddenFileNames', ['.env']),
  };
}

/**
 * Fits the actually available prefix/suffix text into the configured caps
 * (prefixMaxLength / suffixMaxLength) and the combined contextMaxLength: the
 * prefix keeps as much as fits (priority), the suffix gets the remainder.
 * Small files keep both sides in full.
 */
export function fitContext(prefixAvailable: number, suffixAvailable: number, config: ExtensionConfig): { prefix: number; suffix: number } {
  let prefix = config.prefixMaxLength > 0 ? Math.min(prefixAvailable, config.prefixMaxLength) : prefixAvailable;
  let suffix = config.suffixMaxLength > 0 ? Math.min(suffixAvailable, config.suffixMaxLength) : suffixAvailable;
  const max = config.contextMaxLength;
  if (max > 0 && prefix + suffix > max) {
    suffix = Math.min(suffix, Math.max(0, max - prefix));
    prefix = Math.min(prefix, Math.max(0, max - suffix));
  }
  return { prefix, suffix };
}
