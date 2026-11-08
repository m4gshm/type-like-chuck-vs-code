import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { vi } from 'vitest';
import { ExtensionConfig } from '../../config';
import { EngineManagerSettings, EngineStatus } from '../../local_engine/engine_manager';

export class FakeRunnerChild extends EventEmitter {
  stdin = {
    write: vi.fn(() => true),
    end: vi.fn(),
  };
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  constructor(public args: string[], public env: NodeJS.ProcessEnv) {
    super();
  }

  kill(): void {
    this.killed = true;
    this.emit('close', 0);
  }
}

export const last = (statuses: EngineStatus[]): EngineStatus => statuses[statuses.length - 1];

export const defaultEngineManagerSettings = (overrides: Partial<EngineManagerSettings> = {}): EngineManagerSettings => ({
  modelId: 'Qwen2.5-Coder 1.5B',
  modelIdExplicit: true,
  device: 'auto',
  engineKind: 'llama.cpp',
  npuContextLength: 8192,
  releaseTag: 'b1',
  distroDir: '',
  huggingfaceUrl: 'https://huggingface.co',
  githubUrl: 'https://github.com',
  openvinoUrl: 'https://storage.openvinotoolkit.org',
  modelPath: '',
  apiKeyEnabled: true,
  ...overrides,
});

export const defaultExtensionConfig = (overrides: Partial<ExtensionConfig> = {}): ExtensionConfig => ({
  baseUrl: 'http://stub/v1',
  model: 'm',
  apiKey: '',
  mode: 'local',
  localEngineKind: 'llama.cpp',
  localModel: 'Qwen2.5-Coder 1.5B',
  localModelExplicit: true,
  localDevice: 'npu',
  localNpuContextMaxLength: 8192,
  localLlamaCppRelease: 'b11935',
  localEngineDir: '',
  localDistroDir: '',
  localDownloadedModelsDir: '',
  localModelCacheDir: '',
  localHuggingfaceUrl: 'https://huggingface.co',
  localGithubUrl: 'https://github.com',
  localOpenvinoUrl: 'https://storage.openvinotoolkit.org',
  localCustomModelPath: '',
  localApiKeyEnabled: true,
  promptTemplate: undefined,
  customTemplate: undefined,
  prefixMaxLength: 8000,
  suffixMaxLength: 2000,
  contextMaxLength: 8192,
  maxTokens: 256,
  debounceMs: 250,
  pendingGraceMs: 150,
  autoTrigger: true,
  cacheEnabled: true,
  cacheTtlMs: 10_000,
  yieldToCopilot: true,
  forbiddenFileNames: ['.env'],
  ...overrides,
});
