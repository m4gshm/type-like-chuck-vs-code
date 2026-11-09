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

function items(): Array<{ text: string; tooltip?: string; command?: string; shown: boolean }> {
  return (window as unknown as { createdStatusBarItems: Array<{ text: string; tooltip?: string; command?: string; shown: boolean }> }).createdStatusBarItems;
}

function itemText(): string {
  const all = items();
  return all[all.length - 2].text;
}

function itemTooltip(): string {
  const all = items();
  return all[all.length - 2].tooltip ?? '';
}

describe('StatusBar', () => {
  it('reflects enabled/busy/error/disabled states in priority order', async () => {
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
    expect(itemTooltip()).toContain('is paused. Click to re-enable.');

    // Connection restored: no reason left behind.
    state.setConnectionBlocked(false);
    bar.setConnectionReason(undefined);
    expect(itemTooltip()).toContain('completions enabled (click to toggle)');

    // Manual disable: plain tooltip.
    void state.setEnabled(false);
    bar.refresh();
    expect(itemTooltip()).toContain('completions disabled (click to toggle)');
  });

  it('shows the engine detail in the tooltip while the local engine is ready', () => {
    const state = new CompletionState(new FakeMemento() as never);
    const bar = new StatusBar(state);

    bar.setEngineDetail('Qwen2.5-Coder 1.5B (npu)');
    expect(itemText()).toBe('$(tlc-cowboy)');
    expect(itemTooltip()).toBe('Qwen2.5-Coder 1.5B (npu)\nClick to toggle');

    // A transient label (spinner/error) wins over the detail text.
    bar.setEngine('$(loading~spin) starting…');
    expect(itemText()).toBe('$(loading~spin) starting…');

    // Cleared detail leaves the plain tooltip.
    bar.setEngine(undefined);
    bar.setEngineDetail(undefined);
    expect(itemTooltip()).toContain('completions enabled (click to toggle)');
  });

  it('shows the partial-line badge while a candidate exists and hides it after', () => {
    const state = new CompletionState(new FakeMemento() as never);
    const bar = new StatusBar(state);
    const badge = items()[items().length - 1];

    bar.setPartialLine(12);
    expect(badge.text).toBe('$(light-bulb) insert into line 12');
    expect(badge.command).toBe('tlc.insertPartialLine');
    expect(badge.shown).toBe(true);

    bar.setPartialLine(undefined);
    expect(badge.shown).toBe(false);
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
