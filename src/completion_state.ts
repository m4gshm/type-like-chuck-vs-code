import * as vscode from 'vscode';

const STATE_KEY = 'tlc.enabled';

/** Enable/disable state persisted per workspace in globalState. */
export class CompletionState {
  constructor(private readonly globalState: vscode.Memento) {}

  isEnabled(): boolean {
    return this.globalState.get<boolean>(STATE_KEY, true);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.globalState.update(STATE_KEY, enabled);
  }
}
