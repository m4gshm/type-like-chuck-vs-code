import * as vscode from 'vscode';

const STATE_KEY = 'tlc.enabled';

/** Enable/disable state persisted per workspace in globalState, plus an
 * in-memory connection gate set by the watchdog (never persisted). */
export class CompletionState {
  private connectionBlocked = false;

  constructor(private readonly globalState: vscode.Memento) {}

  isEnabled(): boolean {
    if (this.connectionBlocked) {
      return false;
    }
    let enabled = this.globalState.get<boolean>(STATE_KEY, true);
    return enabled;
  }

  isConnectionBlocked(): boolean {
    return this.connectionBlocked;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.globalState.update(STATE_KEY, enabled);
  }

  setConnectionBlocked(blocked: boolean): void {
    this.connectionBlocked = blocked;
  }
}
