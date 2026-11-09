export function overlapLength(completion: string, following: string): number {
  const max = Math.min(completion.length, following.length);
  let k = 0;
  while (k < max && completion[k] === following[k]) {
    k += 1;
  }
  return k;
}

export function trailingOverlapLength(completion: string, following: string): number {
  const max = Math.min(completion.length, following.length);
  for (let k = max; k > 0; k -= 1) {
    if (completion.slice(completion.length - k) === following.slice(0, k)) {
      return k;
    }
  }
  return 0;
}

export interface SeamOverlap {
  replaceCount: number;
  insert: string;
  duplicate: boolean;
}

/** The line following the cursor's line; empty when the cursor is on the last line. */
export function lineAfterCursor(text: string, offset: number): string {
  const lineStart = text.indexOf('\n', offset);
  if (lineStart === -1) {
    return '';
  }
  const lineEnd = text.indexOf('\n', lineStart + 1);
  return text.slice(lineStart + 1, lineEnd === -1 ? text.length : lineEnd);
}

/** A suggestion repeating the line right below the cursor duplicates existing code on accept. */
export function duplicatesFollowingLine(completion: string, nextLine: string): boolean {
  const trimmed = completion.trim();
  return trimmed.length > 0 && trimmed === nextLine.trim();
}

export interface PartialLineDelta {
  /** Common prefix length of the trimmed strings. */
  prefixLength: number;
  /** The completion's remainder after the shared prefix — the delta to insert into the next line. */
  insert: string;
}

/**
 * The completion mostly re-states the line right below the cursor but extends
 * (or diverges from) it near the end: `nextLine` + `insert` ≈ `completion`.
 * Guarded by a match ratio on both sides so short accidental common prefixes
 * (e.g. shared indentation) do not qualify.
 */
export function partialLineDelta(completion: string, nextLine: string, minMatchRatio = 0.6): PartialLineDelta | undefined {
  const target = completion.trim();
  const existing = nextLine.trim();
  if (target.length === 0 || existing.length === 0 || target === existing) {
    return undefined;
  }
  const prefixLength = overlapLength(target, existing);
  if (prefixLength < target.length * minMatchRatio || prefixLength < existing.length * minMatchRatio) {
    return undefined;
  }
  const insert = target.slice(prefixLength);
  if (insert.trim().length === 0) {
    return undefined;
  }
  return { prefixLength, insert };
}

/**
 * Whitespace-tolerant overlap comparison. Strict matching fails when the
 * completion differs from the document only by a space at the seam (the model
 * suggests `);` while the document already has ` );`), so leading whitespace
 * of either side is allowed to absorb before matching — but only when a real
 * match follows it, otherwise indentation is preserved as-is.
 */
export function seamOverlap(completion: string, following: string): SeamOverlap {
  const direct = overlapLength(completion, following);
  if (direct >= completion.length) {
    return { replaceCount: direct, insert: completion, duplicate: true };
  }
  const followingWs = following.length - following.trimStart().length;
  if (followingWs > 0) {
    const match = overlapLength(completion, following.slice(followingWs));
    if (match > 0) {
      return { replaceCount: followingWs + match, insert: completion, duplicate: match >= completion.length };
    }
  }
  const completionWs = completion.length - completion.trimStart().length;
  if (completionWs > 0) {
    const match = overlapLength(completion.slice(completionWs), following);
    if (match > 0) {
      return {
        replaceCount: match,
        insert: completion.slice(completionWs),
        duplicate: match >= completion.length - completionWs,
      };
    }
  }
  return { replaceCount: direct, insert: completion, duplicate: false };
}
