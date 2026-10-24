import { describe, expect, it } from 'vitest';
import { overlapLength, trailingOverlapLength } from '../../overlap';

describe('overlapLength', () => {
  it('returns 0 when nothing matches', () => {
    expect(overlapLength('foo', 'bar')).toBe(0);
    expect(overlapLength('foo', '')).toBe(0);
    expect(overlapLength('', 'foo')).toBe(0);
  });

  it('returns the full completion length when it duplicates the following text', () => {
    expect(overlapLength(' = 1;', ' = 1; more')).toBe(5);
    expect(overlapLength('ab', 'ab')).toBe(2);
  });

  it('returns the length of the partial match', () => {
    expect(overlapLength(' = 1; // done', ' = 1;')).toBe(5);
    expect(overlapLength('const', 'consolidate')).toBe(4);
  });

  it('trailing newline in following is ignored (model generated "ur", user typed "u\\n")', () => {
    expect(overlapLength('ur', 'u\n')).toBe(1);
  });

  it('strips Windows \\r\\n and bare \\r', () => {
    expect(overlapLength('abc', 'abc\r\n')).toBe(3);
    expect(overlapLength('ab', 'ab\r')).toBe(2);
  });
});

describe('trailingOverlapLength', () => {
  it('returns 0 when the completion does not continue into the following text', () => {
    expect(trailingOverlapLength('foo', 'bar')).toBe(0);
    expect(trailingOverlapLength('', 'foo')).toBe(0);
    expect(trailingOverlapLength('foo', '')).toBe(0);
  });

  it('trims a tail duplicating the start of the following text', () => {
    // The model generated the suffix's "}" itself: "&fourth, &fifth" remains.
    expect(trailingOverlapLength('&fourth, &fifth}', '}\n\tc = clone.Deep(entities)')).toBe(1);
    expect(trailingOverlapLength(' = 1;', '; // done')).toBe(1);
  });

  it('prefers the longest matching tail', () => {
    expect(trailingOverlapLength('a, &b, &c', ', &c, &d)')).toBe(4);
  });

  it('returns the full length when the whole completion duplicates the following text', () => {
    expect(trailingOverlapLength('ab', 'ab')).toBe(2);
    expect(trailingOverlapLength(' = 1;', ' = 1; more')).toBe(5);
  });
});
