/**
 * Keeps a completion request alive for a short window after VS Code cancels
 * it, so continued typing on the same line can re-use the in-flight result
 * instead of firing a new request.
 *
 * Lifecycle:
 * - created when a running request is cancelled by typing;
 * - `consume()` — an invocation decided to await the result: the TTL timer is
 *   stopped and the caller owns the wait (the request is never aborted);
 * - `abort()` — the request is no longer wanted (grace expired, new request
 *   supersedes it): aborts the controller and detaches;
 * - TTL expiry (`lifetimeMs`) — nobody consumed the request: aborts it so the
 *   server does not keep generating into the void.
 */
export class PendingCompletion {
  private disposed = false;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(
    readonly line: number,
    readonly positionCharacter: number,
    readonly completion: Promise<string>,
    private readonly controller: { abort(): void },
    lifetimeMs = 1000,
  ) {
    this.timer = setTimeout(() => this.abort(), lifetimeMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /** Marks the request as consumed and cancels the TTL abort. */
  consume(): void {
    this.clearTimer();
    this.disposed = true;
    void this.completion.catch(() => undefined);
  }

  abort(): void {
    this.clearTimer();
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

  private clearTimer(): void {
    clearTimeout(this.timer);
  }
}
