/**
 * Keeps a completion request alive for a short window after VS Code cancels
 * it, so continued typing on the same line can re-use the in-flight result
 * instead of firing a new request.
 */
export class PendingCompletion {
  private disposed = false;

  constructor(
    readonly line: number,
    readonly positionCharacter: number,
    readonly completion: Promise<string>,
    private readonly controller: { abort(): void },
    lifetimeMs = 1000,
  ) {
    const timer = setTimeout(() => this.dispose(), lifetimeMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  abort(): void {
    this.controller.abort();
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    void this.completion.catch(() => undefined);
  }
}
