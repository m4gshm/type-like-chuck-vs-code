import { describe, expect, it, vi } from 'vitest';
import { EngineTaskRunner } from '../../engine_progress';

const flush = async (ms: number) => new Promise((r) => setTimeout(r, ms));

const makeHost = () => {
  const bars: string[] = [];
  return {
    bars,
    host: {
      withProgress: async (
        _options: { title: string; cancellable: boolean },
        task: (p: { report(v: { message?: string }): void }, t: { onCancellationRequested(cb: () => void): void }) => Promise<void>,
      ): Promise<void> => {
        await task(
          { report: (value: { message?: string }) => bars.push(value.message ?? '') },
          { onCancellationRequested: (_cb: () => void) => undefined },
        );
      },
      offerRetry: vi.fn(),
      enginePhaseLabel: () => 'llama-server',
      modelName: () => 'Qwen2.5-Coder 1.5B',
    },
  };
};

describe('EngineTaskRunner', () => {
  it('deduplicates concurrent runs into one underlying task', async () => {
    const { host } = makeHost();
    const runner = new EngineTaskRunner(host as never);
    let started = 0;
    const task = async () => {
      started += 1;
      await flush(50);
    };
    await Promise.all([runner.run('t', task), runner.run('t', task)]);
    expect(started).toBe(1);
    expect(host.offerRetry).not.toHaveBeenCalled();
  });

  it('offers a retry when the task fails and reports the stage label first', async () => {
    const { host, bars } = makeHost();
    const runner = new EngineTaskRunner(host as never);
    runner.stageLabel = 'starting llama-server…';
    const failing = async () => {
      await flush(250);
      throw new Error('download failed');
    };
    await runner.run('t', failing);
    await flush(30);
    expect(bars).toContain('starting llama-server…');
    expect(host.offerRetry).toHaveBeenCalledTimes(1);
    expect(vi.mocked(host.offerRetry).mock.calls[0][0]).toContain('download failed');
  });

  it('reports byte counts, the file name and the model phase while downloading', async () => {
    const { host, bars } = makeHost();
    const runner = new EngineTaskRunner(host as never);
    runner.stageLabel = 'starting…';
    const task = async () => {
      runner.onDownloadProgress('model', { downloadedBytes: 0, totalBytes: 3000, fileName: 'openvino_model.bin', fileIndex: 2, fileCount: 4 });
      runner.onDownloadProgress('model', { downloadedBytes: 1500, totalBytes: 3000, fileName: 'openvino_model.bin', fileIndex: 2, fileCount: 4 });
      await flush(450);
    };
    await runner.run('t', task);
    await flush(200);
    expect(bars.some((b) => b.includes('openvino_model.bin (file 2/4)') && b.includes(': 1.5KB / 3.0KB'))).toBe(true);
  });
});
