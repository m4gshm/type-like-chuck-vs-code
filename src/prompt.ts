/**
 * Masks reserved template tokens appearing in the user's code (by inserting a
 * space after the token's first character) so the model does not mistake them
 * for prompt structure.
 */
export function maskReservedTokens(text: string, reservedTokens: readonly string[]): string {
  let masked = text;
  // Longest first: masking a shorter token first could corrupt or create
  // occurrences of a longer one that contains it.
  const tokens = [...reservedTokens].sort((a, b) => b.length - a.length);
  for (const token of tokens) {
    if (!token || !masked.includes(token)) {
      continue;
    }
    const replacement = token.length > 1 ? token[0] + ' ' + token.slice(1) : token + ' ';
    masked = masked.split(token).join(replacement);
  }
  return masked;
}

/** Raw text before/after the cursor, already truncated to its configured limits. */
export interface CodeContext {
  prefix: string;
  suffix: string;
}

/** Returns the offset shifted back one code unit when it splits a surrogate pair. */
function avoidSplittingSurrogate(text: string, offset: number): number {
  // The boundary splits a pair exactly when the unit before it is a high
  // surrogate: its low surrogate then sits after the boundary.
  if (offset <= 0 || offset >= text.length) {
    return offset;
  }
  const before = text.charCodeAt(offset - 1);
  return before >= 0xd800 && before <= 0xdbff ? offset - 1 : offset;
}

/** Truncation boundaries are shifted so a UTF-16 surrogate pair is never split in half. */
export function extractContext(
  documentText: string,
  offset: number,
  prefixMaxLength: number,
  suffixMaxLength: number,
): CodeContext {
  const prefixStart = avoidSplittingSurrogate(
    documentText,
    Math.max(0, offset - Math.max(0, prefixMaxLength)),
  );
  const suffixEnd = avoidSplittingSurrogate(
    documentText,
    Math.min(documentText.length, offset + Math.max(0, suffixMaxLength)),
  );
  return {
    prefix: documentText.slice(prefixStart, offset),
    suffix: documentText.slice(offset, suffixEnd),
  };
}
