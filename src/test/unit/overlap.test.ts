import { describe, expect, it } from 'vitest';
import { overlapLength } from '../../overlap';

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

  it('does not count a mismatch behind a common prefix', () => {
    // "abc" vs "abd": only "ab" matches, "c" ≠ "d" stops the scan.
    expect(overlapLength('abc', 'abd')).toBe(2);
  });
});
