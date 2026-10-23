import * as vscode from 'vscode';
import { CustomTemplateDefinition } from './templates/types';

export interface ExtensionConfig {
  baseUrl: string;
  model: string;
  /** Plaintext API key from the tlc.apiKey setting; takes precedence over secret storage when non-empty. */
  apiKey: string;
  promptTemplate: string | undefined;
  /** The custom template compiled from the tlc.prefix / tlc.suffix / tlc.middle / tlc.stop fields, if usable. */
  customTemplate: CustomTemplateDefinition | undefined;
  prefixMaxLength: number;
  suffixMaxLength: number;
  /** Maximum combined prefix+suffix context; 0 = unlimited. Filled from /v1/models on model update. */
  contextMaxLength: number;
  maxTokens: number;
  debounceMs: number;
  /** How long a typing invocation waits for an in-flight pending request; 0 disables the wait. */
  pendingGraceMs: number;
  autoTrigger: boolean;
  cacheEnabled: boolean;
  cacheTtlMs: number;
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

  return {
    baseUrl: c.get<string>('baseUrl', 'http://127.0.0.1:1234/v1'),
    model: c.get<string>('model', 'Qwen2.5-Coder-1.5B'),
    apiKey: c.get<string>('apiKey', ''),
    promptTemplate: c.get<string>('promptTemplate'),
    customTemplate: hasMarkers
      ? { id: 'custom', prefix, suffix, middle, stop }
      : undefined,
    prefixMaxLength: c.get<number>('prefixContextMaxLength', 8000),
    suffixMaxLength: c.get<number>('suffixContextMaxLength', 2000),
    contextMaxLength: c.get<number>('contextMaxLength', 0),
    maxTokens: c.get<number>('maxTokens', 256),
    debounceMs: c.get<number>('debounceMs', 250),
    pendingGraceMs: c.get<number>('pendingGraceMs', 150),
    autoTrigger: c.get<boolean>('autoTrigger', true),
    cacheEnabled: c.get<boolean>('cacheEnabled', true),
    cacheTtlMs: c.get<number>('cacheTtlMs', 10_000),
    forbiddenFileNames: c.get<string[]>('forbiddenFileNames', ['.env']),
  };
}

/**
 * Clamps the prefix/suffix budgets to contextMaxLength (when set): the total
 * is scaled proportionally to the current sizes, with the rounding (and thus
 * the priority) in favor of tlc.prefixContextMaxLength.
 */
export function effectiveContextLengths(config: ExtensionConfig): { prefix: number; suffix: number } {
  const p = config.prefixMaxLength;
  const s = config.suffixMaxLength;
  const max = config.contextMaxLength;
  if (max <= 0 || p + s <= max) {
    return { prefix: p, suffix: s };
  }
  const prefix = Math.min(max, Math.max(0, Math.ceil((max * p) / (p + s))));
  return { prefix, suffix: Math.max(0, max - prefix) };
}
