import type { Position, TextDocument } from 'vscode';
import { ExtensionConfig } from './config';

export interface CachedCompletion {
  fileName: string;
  line: number;
  character: number;
  version: number;
  createdAt: number;
  text: string;
  anchored?: boolean;
}

export interface CompletionCacheDeps {
  getConfig: () => ExtensionConfig;
  trace: (message: string) => void;
  debug: (message: string) => void;
}

export class CompletionCache {
  private entry: CachedCompletion | undefined;

  constructor(private readonly deps: CompletionCacheDeps) { }

  get(document: TextDocument, position: Position): CachedCompletion | undefined {
    const config = this.deps.getConfig();
    if (!config.cacheEnabled) {
      return undefined;
    }
    const cache = this.entry;
    if (!cache) {
      return undefined;
    }
    const age = performance.now() - cache.createdAt;
    if (age >= config.cacheTtlMs) {
      this.deps.trace(`completion trace: cached completion expired after ${Math.round(age)}ms (ttl ${config.cacheTtlMs}ms): ${document.fileName} @ ${position.line}:${position.character}`);
      this.entry = undefined;
      return undefined;
    }
    if (cache.fileName !== document.fileName || cache.line !== position.line) {
      return undefined;
    }
    if (cache.version === document.version && cache.character === position.character) {
      return { ...cache, anchored: true };
    }
    if (cache.version === document.version) {
      return undefined;
    }
    return this.partialHit(document, position, cache);
  }

  /**
   * Forward cache: the cursor advanced along the same line and the typed text
   * is a prefix of the cached completion, so the remainder is served without a
   * new API call. The cache anchor moves to the current position so repeated
   * typing keeps consuming the same completion.
   */
  private partialHit(
    document: TextDocument,
    position: Position,
    cache: CachedCompletion,
  ): CachedCompletion | undefined {
    if (cache.version === document.version) {
      return undefined;
    }
    const sliced = this.sliceByTyped(document, position, cache.character, cache.text, true);
    if (sliced === undefined || sliced.result.trim().length === 0) {
      return undefined;
    }
    this.deps.debug(`completion served a partial cache hit: skipping ${sliced.typed.length} typed characters`);
    this.entry = {
      ...cache,
      character: position.character,
      version: document.version,
      createdAt: performance.now(),
      text: sliced.result,
    };
    return this.entry;
  }

  /**
   * Given the text the user typed between an anchor position and the current
   * cursor position, slice it off the completion text and return the remainder.
   * When `skipWhenNoTyping` is true and the user hasn't moved, returns
   * `undefined` (used by the cache path to trigger a fresh request).
   */
  sliceByTyped(
    document: TextDocument,
    position: Position,
    anchorCharacter: number,
    completion: string,
    skipWhenNoTyping = false,
  ): { typed: string; result: string } | undefined {
    const typed = document.lineAt(position.line).text.slice(anchorCharacter, position.character);
    if (skipWhenNoTyping && typed.length === 0) {
      return undefined;
    }
    if (typed.length > 0 && (typed.length >= completion.length || !completion.startsWith(typed))) {
      return undefined;
    }
    return { typed, result: completion.slice(typed.length) };
  }

  store(document: TextDocument, position: Position, text: string): void {
    if (!this.deps.getConfig().cacheEnabled) {
      return;
    }
    this.entry = {
      fileName: document.fileName,
      line: position.line,
      character: position.character,
      version: document.version,
      createdAt: performance.now(),
      text,
    };
  }
}
