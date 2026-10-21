import * as vscode from 'vscode';
import { CustomTemplateDefinition } from './templates/types';

export interface ExtensionConfig {
  baseUrl: string;
  model: string;
  promptTemplate: string | undefined;
  /** The custom template compiled from the tlc.prefix / tlc.suffix / tlc.middle / tlc.stop fields, if usable. */
  customTemplate: CustomTemplateDefinition | undefined;
  prefixMaxLength: number;
  suffixMaxLength: number;
  maxTokens: number;
  debounceMs: number;
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
    promptTemplate: c.get<string>('promptTemplate'),
    customTemplate: hasMarkers
      ? { id: 'custom', prefix, suffix, middle, stop }
      : undefined,
    prefixMaxLength: c.get<number>('prefixContextMaxLength', 8000),
    suffixMaxLength: c.get<number>('suffixContextMaxLength', 2000),
    maxTokens: c.get<number>('maxTokens', 256),
    debounceMs: c.get<number>('debounceMs', 250),
    forbiddenFileNames: c.get<string[]>('forbiddenFileNames', ['.env']),
  };
}
