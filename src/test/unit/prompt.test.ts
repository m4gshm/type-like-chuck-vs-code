import { describe, expect, it } from 'vitest';
import { extractContext, maskReservedTokens } from '../../prompt';

describe('extractContext', () => {
  const text = '0123456789';

  it('returns full text when within limits', () => {
    const ctx = extractContext(text, 4, 100, 100);
    expect(ctx.prefix).toBe('0123');
    expect(ctx.suffix).toBe('456789');
  });

  it('truncates prefix and suffix to configured maxima', () => {
    const long = 'a'.repeat(50) + 'X' + 'b'.repeat(50);
    const ctx = extractContext(long, 50, 10, 5);
    expect(ctx.prefix).toBe('a'.repeat(10));
    expect(ctx.suffix).toBe('X' + 'b'.repeat(4));
  });

  it('handles zero limits and clamps at document edges', () => {
    expect(extractContext(text, 0, 10, 10).prefix).toBe('');
    expect(extractContext(text, text.length, 10, 10).suffix).toBe('');
    expect(extractContext(text, 4, 0, 0)).toEqual({ prefix: '', suffix: '' });
  });
});

describe('maskReservedTokens', () => {
  it('masks reserved tokens in user code', () => {
    const code = 'const s = "<|fim_prefix|>";';
    const masked = maskReservedTokens(code, ['<|fim_prefix|>', '<|fim_suffix|>']);
    expect(masked).toBe('const s = "< |fim_prefix|>";');
  });

  it('leaves text without reserved tokens untouched', () => {
    const code = 'plain code';
    expect(maskReservedTokens(code, ['<|fim_prefix|>'])).toBe(code);
  });
});
