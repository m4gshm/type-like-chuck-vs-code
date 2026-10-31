import { describe, expect, it } from 'vitest';
import { ExtensionConfig, fitContext } from '../../config';
import { extractModelContextLength } from '../../completions_client';

function config(overrides: Partial<ExtensionConfig> = {}): ExtensionConfig {
  return {
    baseUrl: 'http://stub/v1',
    model: 'm',
    apiKey: '',
    mode: 'local',
    localEngineKind: 'llama.cpp',
    localModel: '1.5b',
    localDevice: 'npu',
    localNpuContextMaxLength: 8192,
    localLlamaCppRelease: 'b11935',
    localEngineDir: '',
    localEngineBinary: '',
    localDistroDir: '',
    localModelDir: '',
    localModelCacheDir: '',
    localHuggingfaceUrl: 'https://huggingface.co',
    localGithubUrl: 'https://github.com',
    localOpenvinoUrl: 'https://storage.openvinotoolkit.org',
    localModelPath: '',
    localModelUrls: {},
    localApiKeyEnabled: true,
    promptTemplate: undefined,
    customTemplate: undefined,
    prefixMaxLength: 8000,
    suffixMaxLength: 2000,
    contextMaxLength: 8192,
    maxTokens: 256,
    debounceMs: 250,
    pendingGraceMs: 150,
    autoTrigger: true,
    cacheEnabled: true,
    cacheTtlMs: 10_000,
    yieldToCopilot: true,
    forbiddenFileNames: ['.env'],
    ...overrides,
  };
}

describe('fitContext', () => {
  it('keeps both sides in full for a small file', () => {
    const r = fitContext(256, 100, config());
    expect(r).toEqual({ prefix: 256, suffix: 100 });
  });

  it('caps each side by its own budget', () => {
    const r = fitContext(50_000, 50_000, config({ contextMaxLength: 0 }));
    expect(r).toEqual({ prefix: 8000, suffix: 2000 });
  });

  it('keeps the full prefix and gives the suffix the remainder (prefix priority)', () => {
    const r = fitContext(50_000, 50_000, config());
    expect(r).toEqual({ prefix: 8000, suffix: 192 });
  });

  it('shrinks the prefix when it alone exceeds the limit', () => {
    const r = fitContext(50_000, 50_000, config({ contextMaxLength: 500 }));
    expect(r).toEqual({ prefix: 500, suffix: 0 });
  });

  it('keeps a small suffix together with a big prefix when they fit', () => {
    const r = fitContext(8000, 100, config());
    expect(r).toEqual({ prefix: 8000, suffix: 100 });
  });

  it('no caps at all when every limit is zero', () => {
    const r = fitContext(10_000, 10_000, config({ contextMaxLength: 0, prefixMaxLength: 0, suffixMaxLength: 0 }));
    expect(r).toEqual({ prefix: 10_000, suffix: 10_000 });
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
