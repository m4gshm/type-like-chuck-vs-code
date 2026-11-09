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

  it('never splits a surrogate pair at a truncation boundary', () => {
    const emoji = '😀'; // one astral character = two UTF-16 code units
    const doc = 'x'.repeat(9) + emoji + emoji + emoji + 'y'.repeat(9);
    const offset = 9 + emoji.length; // cursor right after the first emoji
    // prefixMaxLength=1 lands between the first emoji's halves; the boundary
    // shifts back so the whole emoji stays in the prefix. suffixMaxLength=3
    // lands between the third emoji's halves; it shifts back to its start.
    const ctx = extractContext(doc, offset, 1, 3);
    expect(ctx.prefix).toBe(emoji);
    expect(ctx.suffix).toBe(emoji);
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

  it('masks independently of the token order (longest tokens first)', () => {
    const code = 'const a = "<|fim_prefix|>"; const b = "<|fim_pad|>";';
    const one = maskReservedTokens(code, ['<|fim_prefix|>', '<|fim_pad|>']);
    const other = maskReservedTokens(code, ['<|fim_pad|>', '<|fim_prefix|>']);
    expect(one).toBe(other);
    expect(one).toBe('const a = "< |fim_prefix|>"; const b = "< |fim_pad|>";');
  });
});
