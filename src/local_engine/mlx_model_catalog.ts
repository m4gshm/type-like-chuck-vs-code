import { DEFAULT_HF_BASE } from './model_catalog';
import { LocalModelId } from './model_catalog';

export interface MlxModelSpec {
  id: LocalModelId;
  label: string;
  repo: string;
  /** Files that must be present in the model directory for the runner to load. */
  files: string[];
  /** Built-in FIM template id matching the model family. */
  template: string;
  approximateBytes: number;
  contextLength: number;
}

const MLX_FILES = [
  'config.json',
  'model.safetensors',
  'tokenizer.json',
  'tokenizer_config.json',
];

const MLX_CATALOG: Record<LocalModelId, MlxModelSpec> = {
  'Qwen2.5-Coder 0.5B': {
    id: 'Qwen2.5-Coder 0.5B',
    label: 'Qwen2.5-Coder 0.5B (MLX 4-bit)',
    repo: 'mlx-community/Qwen2.5-Coder-0.5B-4bit',
    files: MLX_FILES,
    template: 'qwen2',
    approximateBytes: 280_000_000,
    contextLength: 32_768,
  },
  'Qwen2.5-Coder 1.5B': {
    id: 'Qwen2.5-Coder 1.5B',
    label: 'Qwen2.5-Coder 1.5B (MLX 4-bit)',
    repo: 'mlx-community/Qwen2.5-Coder-1.5B-4bit',
    files: MLX_FILES,
    template: 'qwen2',
    approximateBytes: 870_000_000,
    contextLength: 32_768,
  },
  'Qwen2.5-Coder 3B': {
    id: 'Qwen2.5-Coder 3B',
    label: 'Qwen2.5-Coder 3B (MLX 4-bit)',
    repo: 'mlx-community/Qwen2.5-Coder-3B-4bit',
    files: MLX_FILES,
    template: 'qwen2',
    approximateBytes: 1_740_000_000,
    contextLength: 32_768,
  },
};

export function mlxModel(id: LocalModelId): MlxModelSpec {
  return MLX_CATALOG[id];
}

export function mlxModelFileUrl(spec: MlxModelSpec, fileName: string, hfBase: string = DEFAULT_HF_BASE): string {
  return `${hfBase.replace(/\/+$/, '')}/${spec.repo}/resolve/main/${fileName}`;
}
