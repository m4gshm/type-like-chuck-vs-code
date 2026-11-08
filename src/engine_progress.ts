import { DownloadProgress } from './local_engine/downloader';
import { BRAND } from './brand';
import { messageOf } from './errors';


type ProgressReport = { message?: string };
interface ProgressLike {
  report(value: ProgressReport): void;
}
interface CancellationTokenLike {
  onCancellationRequested(callback: () => void): void;
}

const formatBytes = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)}${units[unit]}`;
};

/** Runs long engine tasks behind a progress notification with byte counts. */
export class EngineTaskRunner {
  /** Meaningful stage before the first byte arrives; kept in sync by engine-status handling. */
  stageLabel = 'starting…';
  private listener: ((kind: 'engine' | 'model', progress: DownloadProgress) => void) | undefined;
  private active: Promise<void> | undefined;

  constructor(private readonly host: {
    withProgress: (
      options: { title: string; cancellable: boolean },
      task: (progress: ProgressLike, token: CancellationTokenLike) => Promise<void> | Thenable<void>,
    ) => Promise<void> | Thenable<void>;
    /** Duplicated into the output channel by the caller: toasts auto-dismiss, the log stays. */
    offerRetry: (message: string, retry: () => void) => void;
    enginePhaseLabel: () => string;
    modelName: () => string;
  }) {}

  onDownloadProgress = (kind: 'engine' | 'model', progress: DownloadProgress): void => {
    this.listener?.(kind, progress);
  };

  /** Concurrent callers (startup + settings-change restart) share one task instead of stacking. */
  run = async (title: string, task: (signal: AbortSignal) => Promise<unknown>): Promise<void> => {
    if (this.active !== undefined) {
      return this.active;
    }
    this.active = this.runOnce(title, task);
    try {
      await this.active;
    } finally {
      this.active = undefined;
    }
  };

  private async runOnce(title: string, task: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
    const startedAt = Date.now();
    let progress: DownloadProgress = { downloadedBytes: 0, totalBytes: undefined };
    let progressKind: 'engine' | 'model' = 'engine';
    let lastFile: string | undefined;
    this.listener = (kind, p) => {
      if (kind !== progressKind || (p.fileName !== undefined && p.fileName !== lastFile)) {
        // A new phase or a new file started: never show the previous counters.
        progress = { ...p, downloadedBytes: 0 };
        progressKind = kind;
        lastFile = p.fileName;
        return;
      }
      progress = p;
    };
    await this.host.withProgress({ title, cancellable: true }, async (bar, token) => {
      const cancel = new AbortController();
      token.onCancellationRequested(() => cancel.abort());
      const ticker = setInterval(() => {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        const elapsedLabel = elapsed >= 10 ? ` (${Math.floor(elapsed / 60)}m ${elapsed % 60}s elapsed)` : '';
        // Until the first byte arrives the byte counter reads 0 — show the
        // stage instead; "0B" confuses more than it informs.
        if (progress.downloadedBytes === 0) {
          bar.report({ message: `${this.stageLabel}${elapsedLabel}` });
          return;
        }
        const total = progress.totalBytes;
        const part = `${formatBytes(progress.downloadedBytes)}${total !== undefined ? ` / ${formatBytes(total)}` : ''}`;
        const file = progress.fileName !== undefined
          ? ` — ${progress.fileName}${progress.fileCount !== undefined ? ` (file ${progress.fileIndex}/${progress.fileCount})` : ''}`
          : '';
        const phaseLabel = progressKind === 'engine' ? this.host.enginePhaseLabel() : `model: ${this.host.modelName()}`;
        bar.report({ message: `${phaseLabel}${file}: ${part}` });
      }, 200);
      try {
        await task(cancel.signal);
      } catch (err) {
        if (!(err instanceof Error && err.name === 'AbortError')) {
          const message = `${BRAND} local engine: ${messageOf(err)}`;
          this.host.offerRetry(message, () => void this.run(title, task));
        }
      } finally {
        clearInterval(ticker);
        this.listener = undefined;
      }
    });
  }
}
