import * as vscode from 'vscode';
import { CompletionState } from './completion_state';

const ENABLED_TEXT = '$(tlc-cowboy)';
const DISABLED_TEXT = '$(circle-slash)';
const BUSY_TEXT = '$(loading~spin)';
const ERROR_TEXT = '$(error)';

export class StatusBar {
  private readonly item: vscode.StatusBarItem;
  private busy = false;
  private hasError = false;
  private connectionReason: string | undefined;
  private engine: string | undefined;

  constructor(state: CompletionState) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.state = state;
    this.refresh();
    this.item.show();
  }

  state: CompletionState;

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.refresh();
  }

  setError(): void {
    this.hasError = true;
    this.refresh();
  }

  clearError(): void {
    this.hasError = false;
    this.refresh();
  }

  setConnectionReason(reason: string | undefined): void {
    this.connectionReason = reason;
    this.refresh();
  }

  setEngine(engine: string | undefined): void {
    this.engine = engine;
    this.refresh();
  }

  refresh(): void {
    const enabled = this.state.isEnabled();
    this.item.text = !enabled
      ? DISABLED_TEXT
      : this.hasError
        ? ERROR_TEXT
        : this.engine !== undefined
          ? this.engine
          : this.busy
            ? BUSY_TEXT
            : ENABLED_TEXT;
    this.item.tooltip = this.connectionReason !== undefined
      ? `${this.connectionReason}\n\n${enabled
        ? 'TLC keeps retrying; completions pause if the server stays unreachable. Click to toggle.'
        : 'TLC is paused. Click to re-enable.'}`
      : enabled
        ? 'TLC completions enabled (click to toggle)'
        : 'TLC completions disabled (click to toggle)';
    this.item.command = 'tlc.enableDisableCompletions';
  }

  dispose(): void {
    this.item.dispose();
  }
}
