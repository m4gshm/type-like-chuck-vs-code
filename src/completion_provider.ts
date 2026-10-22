import * as vscode from 'vscode';
import { ExtensionConfig, effectiveContextLengths } from './config';
import { CompletionsClient, CompletionError } from './completions_client';
import { extractContext } from './prompt';
import { ForbiddenFiles } from './forbidden_files';
import { PendingCompletion } from './pending_completion';
import { CompletionState } from './completion_state';
import { StatusBar } from './status_bar';
import { ResolvedTemplates } from './templates';

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
  line: number;
  character: number;
  /** Document version at cache creation; any edit (deleted char, deleted line) invalidates. */
  version: number;
  createdAt: number;
  text: string;
}

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
    this.cache = undefined;
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
    return [new vscode.InlineCompletionItem(completion.text, new vscode.Range(position, position))];
  }

  private async getOrCreateCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<{ text: string } | undefined> {
    // Re-serve the cached completion only at the exact cursor position it was
    // created for, while the document is unchanged and the TTL has not expired.
    const cached = this.cachedValue(document, position);
    if (cached !== undefined) {
      return { text: cached };
    }

    // Reuse a request kept pending from a cancelled invocation on the same line,
    // but only once: after consuming it, later typing must trigger a fresh request.
    const pendingHere = this.pending;
    if (
      pendingHere &&
      pendingHere.line === position.line &&
      position.character >= pendingHere.positionCharacter
    ) {
      this.pending = undefined;
      // If the user typed past the request's start position, give the in-flight
      // request only a short grace period before discarding it in favor of a
      // fresh request with up-to-date context (tlc.pendingGraceMs; 0 skips the
      // wait). Re-invocation at the same position (no edits) keeps waiting for
      // the full result.
      const config = this.deps.getConfig();
      const typedOn = position.character > pendingHere.positionCharacter;
      const grace =
        typedOn && config.pendingGraceMs > 0
          ? sleep(config.pendingGraceMs, token).then(
              () => undefined,
              () => undefined,
            )
          : undefined;
      const result = await (grace
        ? Promise.race([this.awaitRequest(pendingHere.completion, token), grace])
        : this.awaitRequest(pendingHere.completion, token));
      if (!result || token.isCancellationRequested) {
        return undefined;
      }
      if (result.text !== undefined && result.text.length > 0) {
        this.storeCache(document, position, result.text);
        return { text: result.text };
      }
      if (result.failed) {
        // The request already surfaced its error; don't fire another one right away.
        return undefined;
      }
      // Grace expired: the stale request is no longer worth waiting for.
      pendingHere.abort();
    }
    this.pending?.abort();
    this.pending = undefined;

    if (token.isCancellationRequested) {
      this.cancelActiveRequests();
      return undefined;
    }

    // Trailing debounce: every invocation pushes the send deadline out, so the
    // request fires only after the user pauses typing. Manual trigger bypasses.
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
    token.onCancellationRequested(() => {
      // Keep the request briefly pending so fast typing can re-use it.
      if (this.activeRequest && this.activeRequest.controller === controller) {
        this.pending = new PendingCompletion(
          position.line,
          position.character,
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
    // Same document state (deleted char / deleted line changes the version) and
    // exactly the cursor position the completion was created for.
    if (
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
