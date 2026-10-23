/** How long to wait after the first connection failure before auto-disabling,
 * and the retry interval while waiting for the server to come back. */
export const WATCHDOG_INTERVAL_MS = 30_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });

export interface WatchdogDeps {
  /** Resolves when the server is reachable, rejects otherwise. */
  probe: () => Promise<unknown>;
  /** Gates completions off (auto-disable); receives the failure message. */
  disable: (reason: string) => void;
  /** Gates completions back on (connection restored). */
  enable: () => void;
  /** Shows the connection error; called once per outage. */
  notifyFailure: (message: string) => void;
  /** Clears the failure indication (recovered or reset by the user). */
  clearFailure: () => void;
  log: (message: string) => void;
}

/**
 * Coalesces connection failures: the error is surfaced once, and if the
 * server is still unreachable after the interval the completions are
 * auto-disabled and the server is probed every interval until it responds.
 * A manual enable/disable resets the watchdog: the user's choice wins.
 */
export class ConnectionWatchdog {
  private failing = false;
  private failureMessage: string | undefined;
  private disabledByWatchdog = false;
  private probing = false;
  private disableTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: WatchdogDeps) {}

  /** True while a failure is being watched (the error icon is shown). */
  isFailing(): boolean {
    return this.failing;
  }

  reportFailure(message: string): void {
    if (this.failing) {
      return;
    }
    this.failing = true;
    this.failureMessage = message;
    this.deps.notifyFailure(message);
    this.disableTimer = setTimeout(() => this.onDeadline(), WATCHDOG_INTERVAL_MS);
    if (typeof this.disableTimer.unref === 'function') {
      this.disableTimer.unref();
    }
  }

  reportSuccess(): void {
    if (this.failing) {
      this.clear();
    }
  }

  /** Cancels the watch; the user controls the state from now on. */
  reset(): void {
    this.clear();
  }

  private clear(): void {
    this.failing = false;
    if (this.failureMessage !== undefined) {
      this.failureMessage = undefined;
      this.deps.clearFailure();
    }
    if (this.disableTimer !== undefined) {
      clearTimeout(this.disableTimer);
      this.disableTimer = undefined;
    }
    if (this.disabledByWatchdog) {
      this.disabledByWatchdog = false;
      this.deps.enable();
    }
  }

  private onDeadline(): void {
    this.disableTimer = undefined;
    if (!this.failing) {
      return;
    }
    this.disabledByWatchdog = true;
    this.deps.disable(this.failureMessage ?? 'Connection error');
    this.deps.log('Completions auto-disabled: the server is unreachable. Probing every 30 s.');
    void this.probeLoop();
  }

  private async probeLoop(): Promise<void> {
    if (this.probing) {
      return;
    }
    this.probing = true;
    try {
      while (this.disabledByWatchdog) {
        try {
          await this.deps.probe();
        } catch {
          await sleep(WATCHDOG_INTERVAL_MS);
          continue;
        }
        this.deps.log('Server is reachable again; completions re-enabled.');
        this.clear();
        return;
      }
    } finally {
      this.probing = false;
    }
  }
}
