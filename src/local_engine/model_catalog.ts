export type LocalModelId = 'Qwen2.5-Coder 0.5B' | 'Qwen2.5-Coder 1.5B' | 'Qwen2.5-Coder 3B';

export interface LocalModelSpec {
  id: LocalModelId;
  label: string;
  repo: string;
  fileName: string;
  /** Built-in FIM template id matching the model family. */
  template: string;
  approximateBytes: number;
  contextLength: number;
}

export const DEFAULT_LOCAL_MODEL: LocalModelId = 'Qwen2.5-Coder 1.5B';
export const DEFAULT_HF_BASE = 'https://huggingface.co';

const CATALOG: Record<LocalModelId, LocalModelSpec> = {
  'Qwen2.5-Coder 0.5B': {
    id: 'Qwen2.5-Coder 0.5B',
    label: 'Qwen2.5-Coder 0.5B',
    repo: 'bartowski/Qwen2.5-Coder-0.5B-GGUF',
    fileName: 'Qwen2.5-Coder-0.5B-Q4_K_M.gguf',
    template: 'qwen2',
    approximateBytes: 400_000_000,
    contextLength: 32_768,
  },
  'Qwen2.5-Coder 1.5B': {
    id: 'Qwen2.5-Coder 1.5B',
    label: 'Qwen2.5-Coder 1.5B',
    repo: 'Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF',
    fileName: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
    template: 'qwen2',
    approximateBytes: 1_100_000_000,
    contextLength: 32_768,
  },
  'Qwen2.5-Coder 3B': {
    id: 'Qwen2.5-Coder 3B',
    label: 'Qwen2.5-Coder 3B',
    repo: 'bartowski/Qwen2.5-Coder-3B-GGUF',
    fileName: 'Qwen2.5-Coder-3B-Q4_K_M.gguf',
    template: 'qwen2',
    approximateBytes: 1_950_000_000,
    contextLength: 32_768,
  },
};

export const LOCAL_MODEL_IDS: LocalModelId[] = ['Qwen2.5-Coder 0.5B', 'Qwen2.5-Coder 1.5B', 'Qwen2.5-Coder 3B'];

export function isLocalModelId(value: string): value is LocalModelId {
  return Object.prototype.hasOwnProperty.call(CATALOG, value);
}

export function localModel(id: LocalModelId): LocalModelSpec {
  return CATALOG[id];
}

export function localModelUrl(id: LocalModelId, hfBase: string = DEFAULT_HF_BASE): string {
  const model = CATALOG[id];
  return `${hfBase.replace(/\/+$/, '')}/${model.repo}/resolve/main/${model.fileName}`;
}
