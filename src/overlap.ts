/**
 * Length of the completion's prefix that duplicates the document text
 * immediately following the cursor. The whole completion duplicating the
 * suffix means there is nothing to insert; a partial overlap means the
 * insertion must replace the overlapping characters instead of being added
 * in front of them.
 */
export function overlapLength(completion: string, following: string): number {
  const max = Math.min(completion.length, following.length);
  let k = 0;
  while (k < max && completion[k] === following[k]) {
    k += 1;
  }
  return k;
}

/**
 * Length of the completion's tail that duplicates the start of the following
 * document text — the model continued its generation into the suffix. The
 * duplicated tail must be trimmed, otherwise the inserted text doubles the
 * characters already present after the cursor.
 */
export function trailingOverlapLength(completion: string, following: string): number {
  const max = Math.min(completion.length, following.length);
  for (let k = max; k > 0; k -= 1) {
    const tail = completion.slice(completion.length - k);
    if (following.startsWith(tail)) {
      return k;
    }
  }
  return 0;
}
