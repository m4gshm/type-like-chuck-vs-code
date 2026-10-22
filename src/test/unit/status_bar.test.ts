import { describe, expect, it } from 'vitest';
import { StatusBar } from '../../status_bar';
import { CompletionState } from '../../completion_state';
import { window } from 'vscode';

class FakeMemento {
  private values = new Map<string, unknown>();
  get<T>(key: string, fallback: T): T {
    return (this.values.get(key) as T) ?? fallback;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

function itemText(): string {
  const items = (window as unknown as { createdStatusBarItems: Array<{ text: string }> }).createdStatusBarItems;
  return items[items.length - 1].text;
}

function itemTooltip(): string {
  const items = (window as unknown as { createdStatusBarItems: Array<{ tooltip?: string }> }).createdStatusBarItems;
  return items[items.length - 1].tooltip ?? '';
}

describe('StatusBar', () => {
  it('reflects enabled/busy/error/disabled states in priority order', () => {
    const state = new CompletionState(new FakeMemento() as never);
    expect(state.isEnabled()).toBe(true);

    const bar = new StatusBar(state);
    expect(itemText()).toBe('$(tlc-cowboy)');

    bar.setBusy(true);
    expect(itemText()).toBe('$(loading~spin)');

    bar.setBusy(false);
    bar.setError();
    expect(itemText()).toBe('$(error)');

    bar.clearError();
    expect(itemText()).toBe('$(tlc-cowboy)');

    void state.setEnabled(false);
    bar.refresh();
    expect(itemText()).toBe('$(circle-slash)');

    // Disabled wins over busy/error.
    bar.setBusy(true);
    bar.setError();
    expect(itemText()).toBe('$(circle-slash)');
  });

  it('shows the connection reason in the tooltip right away, and "paused" once auto-disabled', () => {
    const state = new CompletionState(new FakeMemento() as never);
    const bar = new StatusBar(state);
    const reason = 'Cannot reach the completions API (http://127.0.0.1:8887/v1): Connection error.';

    // First failure: still enabled, but the tooltip already explains it.
    bar.setConnectionReason(reason);
    expect(itemText()).toBe('$(tlc-cowboy)');
    expect(itemTooltip()).toContain(reason);
    expect(itemTooltip()).toContain('Click to toggle.');

    // Watchdog auto-disable after 30 s.
    state.setConnectionBlocked(true);
    bar.refresh();
    expect(itemText()).toBe('$(circle-slash)');
    expect(itemTooltip()).toContain(reason);
    expect(itemTooltip()).toContain('TLC is paused. Click to re-enable.');

    // Connection restored: no reason left behind.
    state.setConnectionBlocked(false);
    bar.setConnectionReason(undefined);
    expect(itemTooltip()).toBe('TLC completions enabled (click to toggle)');

    // Manual disable: plain tooltip.
    void state.setEnabled(false);
    bar.refresh();
    expect(itemTooltip()).toBe('TLC completions disabled (click to toggle)');
  });
});

describe('CompletionState', () => {
  it('persists enable/disable in the memento', async () => {
    const memento = new FakeMemento();
    const state = new CompletionState(memento as never);
    expect(state.isEnabled()).toBe(true);
    await state.setEnabled(false);
    expect(state.isEnabled()).toBe(false);
    await state.setEnabled(true);
    expect(state.isEnabled()).toBe(true);
  });
});
