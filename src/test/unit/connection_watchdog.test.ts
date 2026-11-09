import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionWatchdog, WATCHDOG_INTERVAL_MS } from '../../connection_watchdog';

function setup(probeImpl: () => Promise<unknown> = () => Promise.resolve()) {
  const calls: string[] = [];
  const notifications: string[] = [];
  const logs: string[] = [];
  const watchdog = new ConnectionWatchdog({
    probe: probeImpl,
    disable: (reason) => calls.push(`disable: ${reason}`),
    enable: () => calls.push('enable'),
    notifyFailure: (m) => notifications.push(m),
    clearFailure: () => calls.push('clear'),
    warn: (m) => logs.push(m),
  });
  return { watchdog, calls, notifications, logs };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ConnectionWatchdog', () => {
  it('notifies about a connection failure only once per outage', () => {
    const { watchdog, notifications } = setup();
    watchdog.reportFailure('Cannot reach the completions API');
    watchdog.reportFailure('Cannot reach the completions API');
    watchdog.reportFailure('Cannot reach the completions API');
    expect(notifications).toEqual(['Cannot reach the completions API']);
  });

  it('does not disable when a request succeeds within the interval', async () => {
    const { watchdog, calls } = setup();
    watchdog.reportFailure('down');
    watchdog.reportSuccess();
    await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS);
    expect(calls).toEqual(['clear']);
  });

  it('disables after the interval and re-enables once the probe succeeds', async () => {
    const { watchdog, calls } = setup();
    watchdog.reportFailure('down');
    await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS - 1);
    expect(calls).toEqual([]);
    // The deadline fires and the immediate probe succeeds → re-enabled.
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['disable: down', 'clear', 'enable']);
  });

  it('stays disabled while every probe fails', async () => {
    const { watchdog, calls } = setup(async () => {
      throw new Error('still down');
    });
    watchdog.reportFailure('down');
    await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS * 5);
    expect(calls).toEqual(['disable: down']);
  });

  it('keeps probing every interval until the server responds', async () => {
    let attempts = 0;
    const { watchdog, calls } = setup(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('still down');
      }
      return undefined;
    });
    watchdog.reportFailure('down');
    await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS);
    expect(calls).toEqual(['disable: down']);
    await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS);
    expect(attempts).toBe(2);
    expect(calls).toEqual(['disable: down']);
    await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS);
    expect(attempts).toBe(3);
    expect(calls).toEqual(['disable: down', 'clear', 'enable']);
  });

  it('reset() cancels the watch: no auto-disable, and an auto-disabled gate is lifted', async () => {
    const { watchdog, calls } = setup(async () => {
      throw new Error('still down');
    });
    watchdog.reportFailure('down');
    watchdog.reset();
    await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS * 3);
    expect(calls).toEqual(['clear']);
  });

  it('reset() after an auto-disable re-enables and stops the probe loop', async () => {
    const { watchdog, calls } = setup(async () => {
      throw new Error('still down');
    });
    watchdog.reportFailure('down');
    await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS);
    expect(calls).toEqual(['disable: down']);
    watchdog.reset();
    expect(calls).toEqual(['disable: down', 'clear', 'enable']);
    await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS * 3);
    expect(calls).toEqual(['disable: down', 'clear', 'enable']);
  });

  it('starts a fresh outage cycle after recovery', async () => {
    const { watchdog, notifications } = setup();
    watchdog.reportFailure('first outage');
    watchdog.reportSuccess();
    watchdog.reportFailure('second outage');
    expect(notifications).toEqual(['first outage', 'second outage']);
  });
});
