import { describe, expect, it } from 'vitest';
import { duplicatesFollowingLine, lineAfterCursor, overlapLength, partialLineDelta, seamOverlap, trailingOverlapLength } from '../../overlap';

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

describe('seamOverlap', () => {
  it('drops a completion differing from the document only by a space at the seam', () => {
    expect(seamOverlap(');', ' );')).toEqual({ replaceCount: 3, insert: ');', duplicate: true });
    expect(seamOverlap(';', '  ;')).toEqual({ replaceCount: 3, insert: ';', duplicate: true });
  });

  it('replaces the whitespace-shifted text when the completion extends the match', () => {
    expect(seamOverlap('); // done', ' );')).toEqual({ replaceCount: 3, insert: '); // done', duplicate: false });
  });

  it('preserves indentation when there is no whitespace-shifted match', () => {
    expect(seamOverlap('  x', 'y')).toEqual({ replaceCount: 0, insert: '  x', duplicate: false });
    // The spaces at the seam match each other: replacing one space with " x"
    // still yields a single space before "y".
    expect(seamOverlap(' x', ' y')).toEqual({ replaceCount: 1, insert: ' x', duplicate: false });
  });

  it('absorbs the completion\'s leading whitespace when the document already has the text', () => {
    expect(seamOverlap(' x', 'x')).toEqual({ replaceCount: 1, insert: 'x', duplicate: true });
  });

  it('keeps the strict result when whitespace absorption does not help', () => {
    expect(seamOverlap(' = 1; // done', ' = 1;')).toEqual({ replaceCount: 5, insert: ' = 1; // done', duplicate: false });
    expect(seamOverlap('foo', 'bar')).toEqual({ replaceCount: 0, insert: 'foo', duplicate: false });
  });
});

describe('lineAfterCursor', () => {
  it('returns the line following the cursor line', () => {
    expect(lineAfterCursor('a\nbc\nd', 0)).toBe('bc');
    expect(lineAfterCursor('a\nbc\nd', 2)).toBe('d');
  });

  it('returns the last line when the cursor is on it', () => {
    expect(lineAfterCursor('a\nbc', 1)).toBe('bc');
    expect(lineAfterCursor('ab', 0)).toBe('');
  });
});

describe('duplicatesFollowingLine', () => {
  it('detects a repeated line ignoring indentation', () => {
    expect(duplicatesFollowingLine('\tentities = []', '\tentities = []')).toBe(true);
    expect(duplicatesFollowingLine('  x = 1', '\tx = 1')).toBe(true);
  });

  it('does not fire on different or empty suggestions', () => {
    expect(duplicatesFollowingLine('x = 1', 'x = 2')).toBe(false);
    expect(duplicatesFollowingLine('   ', 'x')).toBe(false);
    expect(duplicatesFollowingLine('x = 1', '')).toBe(false);
  });
});

describe('partialLineDelta', () => {
  it('returns the completion remainder when the next line is mostly restated', () => {
    expect(partialLineDelta(
      '\tentities = []*entity{&first, &second, &third, &fourth}',
      '\tentities = []*entity{&first, &second, &third}',
    )).toEqual({ prefixLength: 44, insert: ', &fourth}' });
  });

  it('accepts the next line as a strict prefix of the completion', () => {
    expect(partialLineDelta('return a + b // sum', 'return a + b')).toEqual({ prefixLength: 12, insert: ' // sum' });
  });

  it('rejects short accidental common prefixes', () => {
    expect(partialLineDelta('\tfoo = computeBar()', '\tbaz = computeQux()')).toBeUndefined();
  });

  it('rejects exact and empty matches', () => {
    expect(partialLineDelta('\tx = 1', '\tx = 1')).toBeUndefined();
    expect(partialLineDelta('x = 1', '')).toBeUndefined();
    expect(partialLineDelta('', 'x = 1')).toBeUndefined();
  });
});
