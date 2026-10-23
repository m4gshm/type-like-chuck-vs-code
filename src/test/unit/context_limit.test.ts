import { describe, expect, it } from 'vitest';
import { ExtensionConfig, effectiveContextLengths } from '../../config';
import { extractModelContextLength } from '../../completions_client';

function config(overrides: Partial<ExtensionConfig> = {}): ExtensionConfig {
  return {
    baseUrl: 'http://stub/v1',
    model: 'm',
    apiKey: '',
    promptTemplate: undefined,
    customTemplate: undefined,
    prefixMaxLength: 8000,
    suffixMaxLength: 2000,
    contextMaxLength: 0,
    maxTokens: 256,
    debounceMs: 250,
    pendingGraceMs: 150,
    autoTrigger: true,
    cacheEnabled: true,
    cacheTtlMs: 10_000,
    forbiddenFileNames: ['.env'],
    ...overrides,
  };
}

describe('effectiveContextLengths', () => {
  it('passes the budgets through when no limit is set', () => {
    const r = effectiveContextLengths(config({ prefixMaxLength: 8000, suffixMaxLength: 2000, contextMaxLength: 0 }));
    expect(r).toEqual({ prefix: 8000, suffix: 2000 });
  });

  it('passes the budgets through when the total fits the limit', () => {
    const r = effectiveContextLengths(config({ prefixMaxLength: 600, suffixMaxLength: 400, contextMaxLength: 1000 }));
    expect(r).toEqual({ prefix: 600, suffix: 400 });
  });

  it('scales proportionally when the total exceeds the limit', () => {
    const r = effectiveContextLengths(config({ prefixMaxLength: 8000, suffixMaxLength: 2000, contextMaxLength: 5000 }));
    expect(r.prefix + r.suffix).toBeLessThanOrEqual(5000);
    // 8000:2000 → 4:1 split of 5000
    expect(r.prefix).toBe(4000);
    expect(r.suffix).toBe(1000);
  });

  it('favors the prefix in rounding', () => {
    const r = effectiveContextLengths(config({ prefixMaxLength: 1000, suffixMaxLength: 1000, contextMaxLength: 999 }));
    expect(r.prefix).toBe(500);
    expect(r.suffix).toBe(499);
  });

  it('keeps the prefix dominant when the limit is tiny', () => {
    const r = effectiveContextLengths(config({ prefixMaxLength: 8000, suffixMaxLength: 2000, contextMaxLength: 500 }));
    expect(r.prefix + r.suffix).toBe(500);
    expect(r.prefix).toBeGreaterThan(r.suffix);
  });
});

describe('extractModelContextLength', () => {
  it('reads llama.cpp-style meta fields', () => {
    expect(extractModelContextLength({ id: 'm', meta: { n_ctx_train: 32768 } })).toBe(32768);
    expect(extractModelContextLength({ id: 'm', meta: { n_ctx: 4096 } })).toBe(4096);
  });

  it('reads common flat field names', () => {
    expect(extractModelContextLength({ id: 'm', max_context: 8192 })).toBe(8192);
    expect(extractModelContextLength({ id: 'm', max_model_len: 16384 })).toBe(16384);
    expect(extractModelContextLength({ id: 'm', context_length: 2048 })).toBe(2048);
  });

  it('returns undefined for unknown or invalid values', () => {
    expect(extractModelContextLength({ id: 'm' })).toBeUndefined();
    expect(extractModelContextLength({ id: 'm', max_context: 0 })).toBeUndefined();
    expect(extractModelContextLength({ id: 'm', max_context: 'big' })).toBeUndefined();
  });
});
