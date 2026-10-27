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
