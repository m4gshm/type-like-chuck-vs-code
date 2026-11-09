import { detectLoop } from './loop_detection';
import { truncateToLine } from './line_truncation';
import { FimTemplate } from './templates/types';

const MARKDOWN_FENCE_OPENER = /^\s*(```|~~~)[A-Za-z0-9_+#.:-]*\s*$/;

/** A lone ```lang / ~~~lang line: instruct models open FIM answers with it. */
const isMarkdownFenceOpener = (line: string): boolean => MARKDOWN_FENCE_OPENER.test(line);

/** Shared streaming tail for the HTTP and stdio transports: stop-token cut, loop detection, single-line truncation, fence skip, reserved-token strip. */
export async function consumeChunks(
  chunks: AsyncIterable<{ choices: Array<{ text?: string }> }>,
  template: FimTemplate,
  startedAt: number,
  signal: AbortSignal,
  logResponse?: (message: string) => void,
): Promise<{ text: string }> {
  let text = '';
  let done = false;
  let loopDetected = false;
  let chunksSeen = 0;
  let fenceSkipped = false;
  for await (const chunk of chunks) {
    chunksSeen++;
    const chunkText = chunk.choices[0]?.text ?? '';
    if (chunkText.length > 0) {
      text += chunkText;
      // Servers may ignore the `stop` parameter: any reserved token that
      // shows up in the stream acts as an implicit stop, cut there.
      let cutAt = -1;
      for (const token of template.reservedTokens) {
        if (token.length > 0) {
          const at = text.indexOf(token);
          if (at !== -1 && (cutAt === -1 || at < cutAt)) {
            cutAt = at;
          }
        }
      }
      if (cutAt !== -1) {
        text = text.slice(0, cutAt);
        done = true;
        break;
      }
      // Degenerate repetition (e.g. <|fim_pad|> repeated): stop early.
      const loop = detectLoop(text);
      if (loop.looped) {
        loopDetected = true;
        text = text.slice(0, loop.cutIndex);
        break;
      }
      const newlineAt = text.match(/[\r\n]/);
      if (newlineAt && newlineAt.index !== undefined) {
        // Instruct models often open with a markdown fence (```go);
        // skip that line and complete from the following one.
        if (!fenceSkipped && isMarkdownFenceOpener(text.slice(0, newlineAt.index))) {
          fenceSkipped = true;
          text = text.slice(newlineAt.index + 1);
          continue;
        }
        text = text.slice(0, newlineAt.index);
        done = true;
        break;
      }
    }
  }
  if (!done && !loopDetected && !signal.aborted) {
    text = truncateToLine(text).text;
  }
  if (!fenceSkipped && isMarkdownFenceOpener(text)) {
    text = '';
  }
  // Template tags must never leak into the insertion.
  for (const token of template.reservedTokens) {
    if (token) {
      text = text.split(token).join('');
    }
  }
  // chunks=0 means the backend produced nothing; chunks>0 with 0 chars means
  // tokens arrived but were cut (newline/stop token/loop/abort).
  logResponse?.(`api response (${text.length} chars, ${chunksSeen} chunks${signal.aborted ? ', aborted' : ''}, ${Date.now() - startedAt} ms): ${text}`);
  return { text: text.trim().length === 0 ? '' : text };
}
