import * as vscode from 'vscode';
import { ExtensionConfig, effectiveContextLengths } from './config';
import { CompletionsClient, CompletionError, isAbortError, messageOf } from './completions_client';
import { extractContext } from './prompt';
import { ForbiddenFiles } from './forbidden_files';
import { PendingCompletion } from './pending_completion';
import { CompletionState } from './completion_state';
import { StatusBar } from './status_bar';
import { ResolvedTemplates } from './templates';
import { overlapLength, trailingOverlapLength } from './overlap';

/** Connection-failure coalescing the provider reports to (see ConnectionWatchdog). */
export interface ConnectionWatchdogLike {
  reportFailure(message: string): void;
  reportSuccess(): void;
}
export interface ProviderDeps {
  client: CompletionsClient;
  getConfig: () => ExtensionConfig;
  resolveTemplates: () => ResolvedTemplates;
  forbidden: () => ForbiddenFiles;
  completionState: CompletionState;
  statusBar: StatusBar;
  connectionWatchdog: ConnectionWatchdogLike;
  toRelativePath: (fullPath: string) => string;
  warn: (message: string) => void;
  debug: (message: string) => void;
  trace: (message: string) => void;
  error: (message: string, err: unknown) => void;
}

interface CachedCompletion {
  fileName: string;
  line: number;
  character: number;
  version: number;
  createdAt: number;
  text: string;
}

/** Sentinel: the pending-request grace window expired. */
const GRACE_EXPIRED: unique symbol = Symbol('graceExpired');

const sleep = (ms: number, token: vscode.CancellationToken) =>
  new Promise<void>((resolve, reject) => {
    if (token.isCancellationRequested) {
      reject(new vscode.CancellationError());
      return;
    }
    const timer = setTimeout(() => {
      disposable.dispose();
      resolve();
    }, Math.max(0, ms));
    timer.unref();
    const disposable = token.onCancellationRequested(() => {
      clearTimeout(timer);
      reject(new vscode.CancellationError());
    });
  });

/**
 * Inline completion provider: trailing debounce (typing pause), manual
 * trigger bypass, cancellation, pending-request reuse, and an exact-position
 * completion cache served without a new API call.
 */
export class CompletionProvider implements vscode.InlineCompletionItemProvider {
  private skipDebounceOnce = false;
  private activeRequest:
    | { controller: AbortController; completion: Promise<string> }
    | undefined;
  private pending: PendingCompletion | undefined;
  private cache: CachedCompletion | undefined;

  constructor(private readonly deps: ProviderDeps) { }

  cancelActiveRequests(): void {
    this.activeRequest?.controller.abort();
    this.activeRequest = undefined;
    this.pending?.abort();
    this.pending = undefined;
  }

  /** Makes the next invocation skip the debounce window (manual trigger). */
  resetThrottle(): void {
    this.skipDebounceOnce = true;
  }

  onDisabled(): void {
    this.cancelActiveRequests();
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[]> {
    const { completionState: state, forbidden } = this.deps;
    const fileName = this.deps.toRelativePath(document.fileName);
    if (!state.isEnabled()) {
      this.deps.debug(`completion skipped: completions are disabled (${fileName})`);
      return [];
    }
    if (forbidden().isForbidden(document.fileName)) {
      this.deps.debug(`completion skipped: forbidden file ${fileName}`);
      return [];
    }
    const completion = await this.getOrCreateCompletion(document, position, token);
    if (completion === undefined || completion.text.length === 0) {
      return [];
    }

    // Fully overlapping suggestions are useless; partial overlaps must replace
    // the duplicated characters instead of doubling them.
    const offset = document.offsetAt(position);
    const following = document.getText().slice(offset, offset + completion.text.length);
    // The model may continue its generation into the suffix: trim the tail
    // duplicating the text after the cursor before the overlap handling.
    const tailOverlap = trailingOverlapLength(completion.text, following);
    let text = tailOverlap > 0 ? completion.text.slice(0, completion.text.length - tailOverlap) : completion.text;
    if (text.length === 0) {
      this.deps.debug('completion skipped: completion duplicates the existing text after the cursor');
      return [];
    }
    const overlap = overlapLength(text, following);
    if (overlap >= text.length) {
      this.deps.debug('completion skipped: completion duplicates the existing text after the cursor');
      return [];
    }
    const range = overlap > 0 ? new vscode.Range(position, document.positionAt(offset + overlap)) : new vscode.Range(position, position);
    return [new vscode.InlineCompletionItem(text, range)];
  }

  private async getOrCreateCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<{ text: string } | undefined> {
    const fileName = this.deps.toRelativePath(document.fileName);
    const prefix = this.prefixWord(document, position);
    const pos = `${position.line}:${position.character}${prefix ? ' "' + prefix + '"' : ''}`;
    this.deps.debug(`completion invoking: ${fileName} @ ${pos}`);

    const manual = this.skipDebounceOnce;
    this.skipDebounceOnce = false;
    if (manual) {
      this.deps.debug(`completion manual trigger: bypassing cache and pending: ${fileName} @ ${pos}`);
    } else {
      const cached = this.cachedValue(document, position);
      if (cached !== undefined) {
        this.deps.debug(`completion cached result: ${fileName} @ ${pos} -> ${cached}`);
        return { text: cached };
      }
      this.deps.trace(`completion trace: cache miss: ${fileName} @ ${pos}`);
    }

    // Undo/redo back to the request's exact position (same character,
    // different version) means the request's context no longer exists.
    const pendingHere = manual ? undefined : this.pending;
    this.deps.trace(pendingHere
      ? `completion trace: pending request found @ ${pendingHere.line}:${pendingHere.positionCharacter} (v${pendingHere.version})`
      : `completion trace: no pending request: ${fileName} @ ${pos}`);
    if (
      pendingHere &&
      pendingHere.fileName === document.fileName &&
      pendingHere.line === position.line &&
      position.character >= pendingHere.positionCharacter &&
      !(
        position.character === pendingHere.positionCharacter &&
        document.version !== pendingHere.version
      )
    ) {
      this.pending = undefined;
      pendingHere.consume();
      // Typed past the request start: wait only pendingGraceMs for the stale
      // result before requesting afresh; unchanged position waits in full.
      const config = this.deps.getConfig();
      const typedOn = position.character > pendingHere.positionCharacter;
      if (typedOn && config.pendingGraceMs <= 0) {
        this.deps.trace(`completion trace: typed past the pending position with grace disabled, aborting: ${fileName} @ ${pos}`);
        pendingHere.abort();
      } else {
        this.deps.statusBar.setBusy(true);
        try {
          const result = typedOn ? await Promise.race([
            this.awaitRequest(pendingHere.completion, token),
            sleep(config.pendingGraceMs, token).then(() => GRACE_EXPIRED),
          ]) : await this.awaitRequest(pendingHere.completion, token);
          if (result === GRACE_EXPIRED) {
            this.deps.trace(`completion trace: pending grace expired after ${config.pendingGraceMs}ms, aborting: ${fileName} @ ${pos}`);
            pendingHere.abort();
          } else {
            const completion = result as { text?: string; failed?: boolean };
            const text = completion.text;
            if (token.isCancellationRequested) {
              this.deps.debug(`completion cancelled while waiting for pending result: ${fileName} @ ${pos}`);
              return undefined;
            } else if (text !== undefined && text.length > 0) {
              const sliced = this.sliceByTyped(document, position, pendingHere.positionCharacter, text);
              if (sliced !== undefined) {
                this.storeCache(document, position, sliced.result);
                const pendingPrefix = this.prefixWord(document, new vscode.Position(pendingHere.line, pendingHere.positionCharacter));
                this.deps.debug(`completion pending completions: ${fileName} @ ${pendingHere.line}:${pendingHere.positionCharacter}${pendingPrefix ? ' "' + pendingPrefix + '"' : ''} -> ${sliced.result}`);
                return { text: sliced.result };
              }
              this.deps.trace(`completion trace: typed text diverged from the pending completion, requesting afresh: ${fileName} @ ${pos}`);
            } else if (completion.failed) {
              this.deps.debug(`completion pending request returned failure: ${fileName} @ ${pos}`);
              return undefined;
            }
          }
        } finally {
          this.deps.statusBar.setBusy(false);
        }
      }
    }
    this.pending?.abort();
    this.pending = undefined;

    if (token.isCancellationRequested) {
      this.cancelActiveRequests();
      this.deps.debug(`completion cancelled: ${fileName} @ ${pos}`);
      return undefined;
    }

    // Trailing debounce: the request fires only after the user pauses typing;
    // the manual trigger bypasses it.
    const config = this.deps.getConfig();
    if (!manual) {
      if (!config.autoTrigger) {
        this.deps.debug('completion skipped: auto-trigger is disabled');
        return undefined;
      }
      this.deps.trace(`completion trace: debouncing for ${config.debounceMs}ms: ${fileName} @ ${pos}`);
      try {
        await sleep(config.debounceMs, token);
      } catch (e) {
        if (token.isCancellationRequested) {
          // Cancelled while waiting: keep the pending request and cache intact
          // (a follow-up invocation may reuse either). Just stop this invocation.
          this.deps.debug(`completion cancelled during debounce: ${fileName} @ ${pos}`);
          return undefined;
        }
        this.handleRequestError(e, `completion debounce error: ${fileName} @ ${pos}`);
        return undefined;
      }
      this.deps.trace(`completion trace: debounce passed: ${fileName} @ ${pos}`);
    }

    const controller = new AbortController();
    const cancelSubscription = token.onCancellationRequested(() => {
      // Keep the request briefly pending so fast typing can re-use it.
      if (this.activeRequest && this.activeRequest.controller === controller) {
        this.pending = new PendingCompletion(
          document.fileName,
          position.line,
          position.character,
          document.version,
          this.activeRequest.completion,
          controller,
        );
        this.activeRequest = undefined;
      } else {
        controller.abort();
      }
    });

    const { registry } = this.deps.resolveTemplates();
    const { template } = registry.resolve(config.promptTemplate);
    const lengths = effectiveContextLengths(config);
    const context = extractContext(
      document.getText(),
      document.offsetAt(position),
      lengths.prefix,
      lengths.suffix,
    );

    const request = this.deps.client.complete({
      prefix: context.prefix,
      suffix: context.suffix,
      template,
      signal: controller.signal,
    }).then((r) => r.text);
    this.activeRequest = { controller, completion: request };
    this.deps.statusBar.setBusy(true);
    this.deps.trace(`completion trace: sending completion request to ${config.baseUrl} (model ${config.model}, template ${template.id}): ${fileName} @ ${pos}`);

    try {
      const text = await request;
      this.deps.connectionWatchdog.reportSuccess();
      if (text.length > 0) {
        //todo only not empty text updates cache
        this.storeCache(document, position, text);
      }
      this.deps.statusBar.clearError();
      this.deps.debug(`completion result: ${fileName} @ ${pos} -> ${text}`);
      return { text };
    } catch (err) {
      this.handleRequestError(err, `completion request error: ${fileName} @ ${pos}`);
      return undefined;
    } finally {
      cancelSubscription.dispose();
      if (this.activeRequest && this.activeRequest.controller === controller) {
        this.activeRequest = undefined;
      }
      this.deps.statusBar.setBusy(false);
    }
  }

  private cachedValue(document: vscode.TextDocument, position: vscode.Position): string | undefined {
    const config = this.deps.getConfig();
    if (!config.cacheEnabled) {
      return undefined;
    }
    const cache = this.cache;
    if (!cache) {
      return undefined;
    }
    if (performance.now() - cache.createdAt >= config.cacheTtlMs) {
      this.cache = undefined;
      return undefined;
    }
    if (cache.fileName !== document.fileName || cache.line !== position.line) {
      return undefined;
    }
    if (cache.version === document.version) {
      return cache.character === position.character ? cache.text : undefined;
    }
    return this.partialCacheHit(document, position, cache);
  }

  /**
   * Forward cache: the cursor advanced along the same line and the typed text
   * is a prefix of the cached completion, so the remainder is served without a
   * new API call. The cache anchor moves to the current position so repeated
   * typing keeps consuming the same completion.
   */
  private partialCacheHit(
    document: vscode.TextDocument,
    position: vscode.Position,
    cache: CachedCompletion,
  ): string | undefined {
    if (cache.version === document.version) {
      return undefined;
    }
    const sliced = this.sliceByTyped(document, position, cache.character, cache.text, true);
    if (sliced === undefined) {
      return undefined;
    }
    this.deps.debug(`completion served a partial cache hit: skipping ${sliced.typed.length} typed characters`);
    this.cache = {
      ...cache,
      character: position.character,
      version: document.version,
      createdAt: performance.now(),
      text: sliced.result,
    };
    return this.cache.text;
  }

  /**
   * Given the text the user typed between an anchor position and the current
   * cursor position, slice it off the completion text and return the remainder.
   * When `skipWhenNoTyping` is true and the user hasn't moved, returns
   * `undefined` (used by the cache path to trigger a fresh request).
   */
  private sliceByTyped(
    document: vscode.TextDocument,
    position: vscode.Position,
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

  /** Returns the last word on the cursor's line (empty string if none). */
  private prefixWord(document: vscode.TextDocument, position: vscode.Position): string {
    const line = document.lineAt(position.line);
    const text = line.text.slice(0, position.character);
    const match = text.match(/[\w]+$/);
    return match ? match[0] : '';
  }

  private storeCache(document: vscode.TextDocument, position: vscode.Position, text: string): void {
    if (!this.deps.getConfig().cacheEnabled) {
      return;
    }
    this.cache = {
      fileName: document.fileName,
      line: position.line,
      character: position.character,
      version: document.version,
      createdAt: performance.now(),
      text,
    };
  }

  private async awaitRequest(
    request: Promise<string>,
    token: vscode.CancellationToken,
  ): Promise<{ text?: string; failed?: boolean }> {
    try {
      const text = await request;
      this.deps.connectionWatchdog.reportSuccess();
      return { text };
    } catch (err) {
      this.handleRequestError(err);
      return { failed: err instanceof CompletionError };
    } finally {
      void token;
    }
  }

  private handleRequestError(err: unknown, context = 'completion request error'): void {
    if (isAbortError(err)) {
      return;
    }
    if (err instanceof CompletionError) {
      this.deps.warn(err.message);
      this.deps.statusBar.setError();
      if (err.kind === 'auth') {
        void vscode.window.showErrorMessage(err.message, 'Set API Key').then((choice) => {
          if (choice === 'Set API Key') {
            void vscode.commands.executeCommand('tlc.setApiKey');
          }
        });
      } else if (err.kind === 'connection') {
        // Surfaced once per outage by the watchdog, not on every request.
        this.deps.connectionWatchdog.reportFailure(err.message);
      } else {
        void vscode.window.showWarningMessage(err.message);
      }
    } else {
      this.deps.error(context, err);
      const message = `Unexpected completion error: ${messageOf(err)}`;
      this.deps.statusBar.setError();
      void vscode.window.showErrorMessage(message);
    }
  }
}
