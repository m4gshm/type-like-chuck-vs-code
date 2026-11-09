import { describe, expect, it } from 'vitest';
import { modelIdsKey } from '../../model_polling';

describe('modelIdsKey', () => {
  it('is insensitive to the list order', () => {
    expect(modelIdsKey([{ id: 'a' }, { id: 'b' }])).toBe(modelIdsKey([{ id: 'b' }, { id: 'a' }]));
  });

  it('changes when a model is replaced', () => {
    expect(modelIdsKey([{ id: 'qwen2.5-coder' }])).not.toBe(modelIdsKey([{ id: 'qwen3-coder' }]));
  });

  it('is stable for identical lists', () => {
    expect(modelIdsKey([{ id: 'a' }, { id: 'b' }])).toBe(modelIdsKey([{ id: 'a' }, { id: 'b' }]));
  });

  it('distinguishes an empty list from any model', () => {
    expect(modelIdsKey([])).not.toBe(modelIdsKey([{ id: 'a' }]));
  });
});
