/**
 * Detects degenerate repetition ("looping") in generated text, e.g.
 * `<|fim_pad|><|fim_pad|>...` or long runs of the same character.
 *
 * The check is suffix-based: for block lengths 1..MAX_BLOCK_LENGTH it counts
 * how many times the trailing block repeats consecutively and signals a loop
 * when the count reaches the threshold for that length.
 */

const MAX_BLOCK_LENGTH = 64;

/** Single-character blocks need more repeats: `aaaa...` runs are common in real code. */
const SINGLE_CHAR_THRESHOLD = 24;

const BLOCK_THRESHOLD = 6;

export interface LoopDetection {
  looped: boolean;
  cutIndex: number;
}

export function detectLoop(text: string): LoopDetection {
  const maxBlock = Math.min(MAX_BLOCK_LENGTH, Math.floor(text.length / 2));
  for (let block = 1; block <= maxBlock; block += 1) {
    const candidate = text.slice(text.length - block);
    // Long runs of whitespace are legitimate output (deep indentation), not a
    // degenerate loop — exempt blocks consisting solely of whitespace.
    if (/^\s+$/.test(candidate)) {
      continue;
    }
    let repeats = 1;
    let pos = text.length - block;
    while (pos - block >= 0 && text.slice(pos - block, pos) === candidate) {
      repeats += 1;
      pos -= block;
    }
    const threshold = block === 1 ? SINGLE_CHAR_THRESHOLD : BLOCK_THRESHOLD;
    if (repeats >= threshold) {
      return { looped: true, cutIndex: pos };
    }
  }
  return { looped: false, cutIndex: text.length };
}
