import { describe, expect, it } from 'vitest';
import { truncateToLine } from '../../line_truncation';

describe('truncateToLine', () => {
  it('cuts multi-line output at the first newline, preserving leading whitespace', () => {
    expect(truncateToLine('  hello\nworld')).toEqual({ text: '  hello', toLineEnd: true });
    expect(truncateToLine('x\r\ny')).toEqual({ text: 'x', toLineEnd: true });
  });

  it('returns normal single-line output unchanged', () => {
    expect(truncateToLine('foo()')).toEqual({ text: 'foo()', toLineEnd: false });
  });

  it('maps whitespace-only output to empty text', () => {
    expect(truncateToLine('   \n')).toEqual({ text: '', toLineEnd: true });
    expect(truncateToLine('')).toEqual({ text: '', toLineEnd: true });
  });
});
