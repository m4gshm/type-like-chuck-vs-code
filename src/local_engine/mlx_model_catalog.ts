import { DEFAULT_HF_BASE } from './model_catalog';
import { LocalModelId } from './model_catalog';

export interface MlxModelSpec {
  id: LocalModelId;
  label: string;
  repo: string;
  /** Files that must be present in the model directory for the runner to load. */
  files: string[];
  approximateBytes: number;
  contextLength: number;
}

const MLX_FILES = [
  'config.json',
  'model.safetensors',
  'tokenizer.json',
  'tokenizer_config.json',
  'generation_config.json',
];

const MLX_CATALOG: Record<LocalModelId, MlxModelSpec> = {
  '0.5b': {
    id: '0.5b',
    label: 'Qwen2.5-Coder 0.5B (MLX 4-bit)',
    repo: 'mlx-community/Qwen2.5-Coder-0.5B-Instruct-4bit',
    files: MLX_FILES,
    approximateBytes: 400_000_000,
    contextLength: 32_768,
  },
  '1.5b': {
    id: '1.5b',
    label: 'Qwen2.5-Coder 1.5B (MLX 4-bit)',
    repo: 'mlx-community/Qwen2.5-Coder-1.5B-Instruct-4bit',
    files: MLX_FILES,
    approximateBytes: 1_000_000_000,
    contextLength: 32_768,
  },
  '3b': {
    id: '3b',
    label: 'Qwen2.5-Coder 3B (MLX 4-bit)',
    repo: 'mlx-community/Qwen2.5-Coder-3B-Instruct-4bit',
    files: MLX_FILES,
    approximateBytes: 1_900_000_000,
    contextLength: 32_768,
  },
};

export function mlxModel(id: LocalModelId): MlxModelSpec {
  return MLX_CATALOG[id];
}

export function mlxModelFileUrl(spec: MlxModelSpec, fileName: string, hfBase: string = DEFAULT_HF_BASE): string {
  return `${hfBase.replace(/\/+$/, '')}/${spec.repo}/resolve/main/${fileName}`;
}
