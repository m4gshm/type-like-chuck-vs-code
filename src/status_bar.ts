import * as vscode from 'vscode';
import { CompletionState } from './completion_state';
import { BRAND } from './brand';


const ENABLED_TEXT = '$(tlc-cowboy)';
const DISABLED_TEXT = '$(circle-slash)';
const BUSY_TEXT = '$(loading~spin)';
const ERROR_TEXT = '$(error)';
const PARTIAL_LINE_TEXT = (line: number) => `$(light-bulb) insert into line ${line}`;

export class StatusBar {
  private readonly item: vscode.StatusBarItem;
  private readonly partialItem: vscode.StatusBarItem;
  private busy = false;
  private hasError = false;
  private connectionReason: string | undefined;
  private engine: string | undefined;
  private engineDetail: string | undefined;

  constructor(state: CompletionState) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.partialItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.partialItem.command = 'tlc.insertPartialLine';
    this.partialItem.tooltip = 'A suppressed suggestion can extend this line. Click to insert just the difference.';
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

  /** Model + device info shown in the tooltip while the local engine is ready. */
  setEngineDetail(detail: string | undefined): void {
    this.engineDetail = detail;
    this.refresh();
  }

  /** Shown while the current document has an insertable partial-line candidate (1-based line). */
  setPartialLine(line: number | undefined): void {
    if (line === undefined) {
      this.partialItem.hide();
      return;
    }
    this.partialItem.text = PARTIAL_LINE_TEXT(line);
    this.partialItem.show();
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
    const baseTooltip = this.connectionReason !== undefined
      ? `${this.connectionReason}\n\n${enabled
        ? `${BRAND} keeps retrying; completions pause if the server stays unreachable. Click to toggle.`
        : `${BRAND} is paused. Click to re-enable.`}`
      : enabled
        ? `${BRAND} completions enabled (click to toggle)`
        : `${BRAND} completions disabled (click to toggle)`;
    this.item.tooltip = enabled && this.engine === undefined && this.engineDetail !== undefined
      ? `${this.engineDetail}\nClick to toggle`
      : baseTooltip;
    this.item.command = 'tlc.enableDisableCompletions';
  }

  dispose(): void {
    this.item.dispose();
    this.partialItem.dispose();
  }
}
