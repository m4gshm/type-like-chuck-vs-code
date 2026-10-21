/**
 * Masks reserved template tokens appearing in the user's code so the model
 * does not mistake them for prompt structure. Masking inserts a space after
 * the token's first character (reversible enough for context purposes and
 * avoiding regex-escaping pitfalls).
 */
export function maskReservedTokens(text: string, reservedTokens: readonly string[]): string {
  let masked = text;
  for (const token of reservedTokens) {
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

/**
 * Builds prefix/suffix context around the cursor position, truncating each
 * side to its configured maximum character length.
 */
export function extractContext(
  documentText: string,
  offset: number,
  prefixMaxLength: number,
  suffixMaxLength: number,
): CodeContext {
  const prefixStart = Math.max(0, offset - Math.max(0, prefixMaxLength));
  const suffixEnd = Math.min(documentText.length, offset + Math.max(0, suffixMaxLength));
  return {
    prefix: documentText.slice(prefixStart, offset),
    suffix: documentText.slice(offset, suffixEnd),
  };
}
