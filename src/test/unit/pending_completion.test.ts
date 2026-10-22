import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingCompletion } from '../../pending_completion';

function makePending(lifetimeMs = 1000) {
  const controller = { abort: vi.fn() };
  const pending = new PendingCompletion(3, 7, Promise.resolve('text'), controller, lifetimeMs);
  return { pending, controller };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PendingCompletion', () => {
  it('aborts the request when its TTL expires without a consumer', () => {
    const { pending, controller } = makePending(1000);
    vi.advanceTimersByTime(999);
    expect(controller.abort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(controller.abort).toHaveBeenCalledTimes(1);
    pending.dispose();
  });

  it('consume() cancels the TTL abort: the caller owns the wait', () => {
    const { pending, controller } = makePending(1000);
    pending.consume();
    vi.advanceTimersByTime(5000);
    expect(controller.abort).not.toHaveBeenCalled();
  });

  it('abort() aborts immediately and stops the TTL timer', () => {
    const { pending, controller } = makePending(1000);
    pending.abort();
    expect(controller.abort).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(controller.abort).toHaveBeenCalledTimes(1);
  });

  it('abort() after consume() still aborts the stale request', () => {
    const { pending, controller } = makePending(1000);
    pending.consume();
    pending.abort();
    expect(controller.abort).toHaveBeenCalledTimes(1);
  });
});
