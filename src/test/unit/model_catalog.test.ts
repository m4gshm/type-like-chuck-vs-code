import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCAL_MODEL, isLocalModelId, LOCAL_MODEL_IDS, localModel, localModelUrl } from '../../local_engine/model_catalog';

describe('local model catalog', () => {
  it('offers 0.5B, 1.5B and 3B', () => {
    expect(LOCAL_MODEL_IDS).toEqual(['Qwen2.5-Coder 0.5B', 'Qwen2.5-Coder 1.5B', 'Qwen2.5-Coder 3B']);
    expect(DEFAULT_LOCAL_MODEL).toBe('Qwen2.5-Coder 1.5B');
  });

  it('builds huggingface urls matching the file names', () => {
    for (const id of LOCAL_MODEL_IDS) {
      const model = localModel(id);
      const url = localModelUrl(id);
      expect(url).toContain(`/${model.fileName}`);
      expect(url).toContain(`${model.repo}/resolve/main`);
      expect(url.startsWith('https://huggingface.co/')).toBe(true);
    }
  });

  it('supports mirror base urls', () => {
    expect(localModelUrl('Qwen2.5-Coder 0.5B', 'https://hf-mirror.internal/')).toBe(
      'https://hf-mirror.internal/bartowski/Qwen2.5-Coder-0.5B-GGUF/resolve/main/Qwen2.5-Coder-0.5B-Q4_K_M.gguf',
    );
  });

  it('fills approximate size and context for every entry', () => {
    for (const id of LOCAL_MODEL_IDS) {
      const model = localModel(id);
      expect(model.approximateBytes).toBeGreaterThan(0);
      expect(model.contextLength).toBeGreaterThan(0);
      expect(model.label).toContain(id);
    }
  });

  it('guards arbitrary strings', () => {
    expect(isLocalModelId('Qwen2.5-Coder 1.5B')).toBe(true);
    expect(isLocalModelId('7b')).toBe(false);
  });
});
