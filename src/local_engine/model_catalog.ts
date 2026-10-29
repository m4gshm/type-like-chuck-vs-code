export type LocalModelId = '0.5b' | '1.5b' | '3b';

export interface LocalModelSpec {
  id: LocalModelId;
  label: string;
  repo: string;
  fileName: string;
  approximateBytes: number;
  contextLength: number;
}

export const DEFAULT_LOCAL_MODEL: LocalModelId = '1.5b';
export const DEFAULT_HF_BASE = 'https://huggingface.co';

const CATALOG: Record<LocalModelId, LocalModelSpec> = {
  '0.5b': {
    id: '0.5b',
    label: 'Qwen2.5-Coder 0.5B',
    repo: 'bartowski/Qwen2.5-Coder-0.5B-GGUF',
    fileName: 'Qwen2.5-Coder-0.5B-Q4_K_M.gguf',
    approximateBytes: 400_000_000,
    contextLength: 32_768,
  },
  '1.5b': {
    id: '1.5b',
    label: 'Qwen2.5-Coder 1.5B',
    repo: 'Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF',
    fileName: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
    approximateBytes: 1_100_000_000,
    contextLength: 32_768,
  },
  '3b': {
    id: '3b',
    label: 'Qwen2.5-Coder 3B',
    repo: 'bartowski/Qwen2.5-Coder-3B-GGUF',
    fileName: 'Qwen2.5-Coder-3B-Q4_K_M.gguf',
    approximateBytes: 1_950_000_000,
    contextLength: 32_768,
  },
};

export const LOCAL_MODEL_IDS: LocalModelId[] = ['0.5b', '1.5b', '3b'];

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
