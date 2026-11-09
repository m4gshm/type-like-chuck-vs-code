import { BRAND } from './brand';
import { copilotActive, CopilotEnableSetting } from './copilot_gate';

export interface CopilotPauseHost {
  /** Whether the yield-to-copilot setting is on; when off the pause never engages. */
  yieldToCopilot: () => boolean;
  copilotInstalled: () => boolean;
  copilotSettings: () => { enable: CopilotEnableSetting | undefined; inlineSuggestEnabled: boolean | undefined; languageId: string };
  completionsEnabled: () => boolean;
  setCompletionsEnabled: (enabled: boolean) => Promise<void>;
  onDisabled: () => void;
  refreshStatusBar: () => void;
  warn: (message: string) => void;
  notify: (message: string) => void;
}

/** Pauses TLC completions while GitHub Copilot is active and re-enables them when it turns off. */
export class CopilotPause {
  private prev: boolean | undefined;
  private autoDisabled = false;

  constructor(private readonly host: CopilotPauseHost) {}

  /** 'TLC: Enable/Disable Completions' turned completions on manually — the next Copilot-off must not re-enable over it. */
  clearAutoDisabled(): void {
    this.autoDisabled = false;
  }

  async update(): Promise<void> {
    if (!this.host.yieldToCopilot()) {
      this.prev = undefined;
      return;
    }
    const { enable, inlineSuggestEnabled, languageId } = this.host.copilotSettings();
    const active = copilotActive(this.host.copilotInstalled(), enable, inlineSuggestEnabled, languageId);
    if (active === this.prev) {
      return;
    }
    const firstCheck = this.prev === undefined;
    this.prev = active;
    if (active && this.host.completionsEnabled()) {
      this.autoDisabled = true;
      await this.host.setCompletionsEnabled(false);
      this.host.onDisabled();
      this.host.refreshStatusBar();
      this.host.warn('GitHub Copilot detected: Type like Chuck completions disabled.');
      this.host.notify(`${BRAND} completions are disabled because GitHub Copilot is enabled. ${BRAND} re-enables automatically when Copilot turns off.`);
    } else if (!active && this.autoDisabled) {
      this.autoDisabled = false;
      if (!firstCheck) {
        await this.host.setCompletionsEnabled(true);
        this.host.refreshStatusBar();
        this.host.notify('GitHub Copilot is off: Type like Chuck completions re-enabled.');
      }
    }
  }
}
