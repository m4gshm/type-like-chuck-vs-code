/**
 * Truncates generated text to a single line: leading whitespace is preserved
 * and the text is cut at the first newline. Empty/whitespace-only output
 * becomes ''.
 */
export function truncateToLine(text: string): { text: string; toLineEnd: boolean } {
  let i = 0;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
    i += 1;
  }
  const rest = text.slice(i);
  if (text.trim().length === 0) {
    return { text: '', toLineEnd: true };
  }
  const newlineMatch = rest.match(/[\r\n]/);
  if (newlineMatch && newlineMatch.index !== undefined) {
    return { text: text.slice(0, i + newlineMatch.index), toLineEnd: true };
  }
  return { text: text.slice(0, i + rest.length), toLineEnd: false };
}
