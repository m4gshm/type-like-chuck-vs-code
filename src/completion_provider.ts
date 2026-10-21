import * as vscode from 'vscode';
import { ExtensionConfig } from './config';
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

interface ActiveCompletion {
  line: number;
  startCharacter: number;
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
 * Inline completion provider: rate-limit debounce, cancellation, pending
 * request reuse, and an active-completion cache (prefix typing re-serves the
 * same suggestion without a new API call).
 */
export class CompletionProvider implements vscode.InlineCompletionItemProvider {
  private nextRequestTime = 0;
  private activeRequest:
    | { line: number; controller: AbortController; completion: Promise<string> }
    | undefined;
  private pending: PendingCompletion | undefined;
  private activeCompletion: ActiveCompletion | undefined;

  constructor(private readonly deps: ProviderDeps) {}

  cancelActiveRequests(): void {
    this.activeRequest?.controller.abort();
    this.activeRequest = undefined;
    this.pending?.abort();
    this.pending = undefined;
    this.activeCompletion = undefined;
  }

  /** Drops the throttle so the next invocation requests immediately (manual trigger). */
  resetThrottle(): void {
    this.nextRequestTime = 0;
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
    // Re-serve the cached completion while the user types its prefix.
    const cached = this.activeCompletion;
    if (
      cached &&
      cached.line === position.line &&
      position.character >= cached.startCharacter
    ) {
      const typed = document.lineAt(position.line).text.slice(cached.startCharacter, position.character);
      if (cached.text.startsWith(typed)) {
        return { text: cached.text.slice(typed.length) };
      }
    }

    // Reuse a request kept pending from a cancelled invocation on the same line.
    const pendingHere = this.pending;
    if (
      pendingHere &&
      pendingHere.line === position.line &&
      position.character >= pendingHere.positionCharacter
    ) {
      const text = await this.awaitRequest(pendingHere.completion, token);
      if (text !== undefined && text.length > 0) {
        this.activeCompletion = { line: position.line, startCharacter: position.character, text };
        return { text };
      }
      return undefined;
    }
    this.pending?.abort();
    this.pending = undefined;

    if (token.isCancellationRequested) {
      this.cancelActiveRequests();
      return undefined;
    }

    // Rate-limit: wait out the remaining debounce window (abort-aware).
    const waitUntil = this.nextRequestTime;
    if (waitUntil > performance.now()) {
      try {
        await sleep(waitUntil - performance.now(), token);
      } catch {
        this.cancelActiveRequests();
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

    const config = this.deps.getConfig();
    const { registry } = this.deps.resolveTemplates();
    const { template } = registry.resolve(config.promptTemplate);
    const context = extractContext(
      document.getText(),
      document.offsetAt(position),
      config.prefixMaxLength,
      config.suffixMaxLength,
    );

    const request = this.deps.client
      .complete({
        prefix: context.prefix,
        suffix: context.suffix,
        template,
        signal: controller.signal,
      })
      .then((r) => r.text);
    this.activeRequest = { line: position.line, controller, completion: request };
    this.deps.status.setBusy(true);
    this.nextRequestTime = performance.now() + config.debounceMs;
    this.deps.trace(`sending completion request to ${config.baseUrl} (model ${config.model}, template ${template.id})`);

    try {
      const text = await request;
      if (text.length > 0) {
        this.activeCompletion = { line: position.line, startCharacter: position.character, text };
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

  private async awaitRequest(
    request: Promise<string>,
    token: vscode.CancellationToken,
  ): Promise<string | undefined> {
    try {
      const text = await request;
      return text;
    } catch (err) {
      return this.handleRequestError(err) ?? undefined;
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
