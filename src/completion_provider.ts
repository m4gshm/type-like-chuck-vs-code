import * as vscode from 'vscode';
import { ExtensionConfig, effectiveContextLengths } from './config';
import { CompletionsClient, CompletionError } from './completions_client';
import { extractContext } from './prompt';
import { ForbiddenFiles } from './forbidden_files';
import { PendingCompletion } from './pending_completion';
import { CompletionState } from './completion_state';
import { StatusBar } from './status_bar';
import { ResolvedTemplates } from './templates';
import { overlapLength } from './overlap';

export interface ProviderDeps {
  client: CompletionsClient;
  getConfig: () => ExtensionConfig;
  resolveTemplates: () => ResolvedTemplates;
  forbidden: () => ForbiddenFiles;
  state: CompletionState;
  status: StatusBar;
  log: (message: string) => void;
  trace: (message: string) => void;
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
    const timer = setTimeout(
      () => {
        disposable.dispose();
        resolve();
      },
      Math.max(0, ms),
    );
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
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
    this.resetThrottle();
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[]> {
    const { state, forbidden } = this.deps;
    if (!state.isEnabled()) {
      this.deps.trace(`provider skipped: completions are disabled (${document.fileName})`);
      return [];
    }
    if (forbidden().isForbidden(document.fileName)) {
      this.deps.trace(`provider skipped: forbidden file ${document.fileName}`);
      return [];
    }
    this.deps.trace(`provider invoked: ${document.fileName} @ ${position.line}:${position.character}`);

    const completion = await this.getOrCreateCompletion(document, position, token);
    if (completion === undefined || completion.text.length === 0) {
      return [];
    }
    // Fully overlapping suggestions are useless; partial overlaps must replace
    // the duplicated characters instead of doubling them.
    const offset = document.offsetAt(position);
    const following = document.getText().slice(offset, offset + completion.text.length);
    const overlap = overlapLength(completion.text, following);
    if (overlap >= completion.text.length) {
      this.deps.trace('provider skipped: completion duplicates the existing text after the cursor');
      return [];
    }
    const range =
      overlap > 0
        ? new vscode.Range(position, document.positionAt(offset + overlap))
        : new vscode.Range(position, position);
    return [new vscode.InlineCompletionItem(completion.text, range)];
  }

  private async getOrCreateCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<{ text: string } | undefined> {
    const cached = this.cachedValue(document, position);
    if (cached !== undefined) {
      return { text: cached };
    }

    // Undo/redo back to the request's exact position (same character,
    // different version) means the request's context no longer exists.
    const pendingHere = this.pending;
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
        pendingHere.abort();
      } else {
        const raced: { text?: string; failed?: boolean } | typeof GRACE_EXPIRED = typedOn
          ? await (async () => {
              this.deps.status.setBusy(true);
              try {
                return await Promise.race([
                  this.awaitRequest(pendingHere.completion, token),
                  sleep(config.pendingGraceMs, token).then(
                    () => GRACE_EXPIRED,
                    () => GRACE_EXPIRED,
                  ),
                ]) as { text?: string; failed?: boolean } | typeof GRACE_EXPIRED;
              } finally {
                this.deps.status.setBusy(false);
              }
            })()
          : await (async () => {
              this.deps.status.setBusy(true);
              try {
                return await this.awaitRequest(pendingHere.completion, token);
              } finally {
                this.deps.status.setBusy(false);
              }
            })();
        if (raced === GRACE_EXPIRED) {
          pendingHere.abort();
        } else if (token.isCancellationRequested) {
          return undefined;
        } else if (raced.text !== undefined && raced.text.length > 0) {
          this.storeCache(document, position, raced.text);
          return { text: raced.text };
        } else if (raced.failed) {
          // The request already surfaced its error; don't fire another one right away.
          return undefined;
        }
      }
    }
    this.pending?.abort();
    this.pending = undefined;

    if (token.isCancellationRequested) {
      this.cancelActiveRequests();
      return undefined;
    }

    // Trailing debounce: the request fires only after the user pauses typing;
    // the manual trigger bypasses it.
    const config = this.deps.getConfig();
    const now = performance.now();
    if (this.skipDebounceOnce) {
      this.skipDebounceOnce = false;
    } else {
      if (!config.autoTrigger) {
        this.deps.trace('provider skipped: auto-trigger is disabled');
        return undefined;
      }
      const deadline = now + config.debounceMs;
      try {
        await sleep(deadline - now, token);
      } catch {
        // Cancelled while waiting: keep the pending request and cache intact
        // (a follow-up invocation may reuse either). Just stop this invocation.
        return undefined;
      }
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

    const request = this.deps.client
      .complete({
        prefix: context.prefix,
        suffix: context.suffix,
        template,
        signal: controller.signal,
      })
      .then((r) => r.text);
    this.activeRequest = { controller, completion: request };
    this.deps.status.setBusy(true);
    this.deps.trace(`sending completion request to ${config.baseUrl} (model ${config.model}, template ${template.id})`);

    try {
      const text = await request;
      if (text.length > 0) {
        this.storeCache(document, position, text);
      }
      this.deps.status.clearError();
      return { text };
    } catch (err) {
      return this.handleRequestError(err);
    } finally {
      cancelSubscription.dispose();
      if (this.activeRequest && this.activeRequest.controller === controller) {
        this.activeRequest = undefined;
      }
      this.deps.status.setBusy(false);
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
    if (
      cache.fileName !== document.fileName ||
      cache.version !== document.version ||
      cache.line !== position.line ||
      cache.character !== position.character
    ) {
      return undefined;
    }
    return cache.text;
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
      return { text: await request };
    } catch (err) {
      this.handleRequestError(err);
      return { failed: err instanceof CompletionError };
    } finally {
      void token;
    }
  }

  private handleRequestError(err: unknown): undefined {
    if (err instanceof CompletionError) {
      this.deps.log(err.message);
      this.deps.status.setError();
      if (err.kind === 'auth') {
        void vscode.window.showErrorMessage(err.message, 'Set API Key').then((choice) => {
          if (choice === 'Set API Key') {
            void vscode.commands.executeCommand('tlc.setApiKey');
          }
        });
      } else {
        void vscode.window.showWarningMessage(err.message);
      }
      return undefined;
    }
    // Abort/cancellation: silent.
    return undefined;
  }
}
