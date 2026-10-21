import { describe, expect, it } from 'vitest';
import { pickSupportedModel, pickTemplateForModel } from '../../model_selection';

describe('pickSupportedModel', () => {
  it('prefers coder variants of supported families in order', () => {
    expect(
      pickSupportedModel(['llama-3b', 'qwen3-chat', 'Qwen2.5-Coder-1.5B', 'mellum-4b']),
    ).toBe('Qwen2.5-Coder-1.5B');
    expect(pickSupportedModel(['qwen3-chat', 'mellum-4b'])).toBe('mellum-4b');
    expect(pickSupportedModel(['lfm2-8b-a1b', 'llama-3b'])).toBe('lfm2-8b-a1b');
  });

  it('matches case-insensitively', () => {
    expect(pickSupportedModel(['QWEN2-CODER-7B'])).toBe('QWEN2-CODER-7B');
  });

  it('suggests templates by model name', () => {
    expect(pickTemplateForModel('Qwen2.5-Coder-1.5B-nf4-sym-g-1-se-awq')).toBe('qwen2');
    expect(pickTemplateForModel('qwen3-coder-30b')).toBe('qwen3');
    expect(pickTemplateForModel('mellum-4b')).toBe('mellum');
    expect(pickTemplateForModel('LFM2-1.2B')).toBe('lfm2');
    expect(pickTemplateForModel('llama-3b')).toBeUndefined();
  });

  it('returns undefined when nothing is supported', () => {
    expect(pickSupportedModel(['llama-3b', 'mistral-7b'])).toBeUndefined();
    expect(pickSupportedModel([])).toBeUndefined();
  });
});
