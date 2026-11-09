import type { StatusBar } from './status_bar';
import { BRAND } from './brand';

import type { CompletionState } from './completion_state';
import type { CompletionsClient } from './completions_client';
import type { ConnectionWatchdog } from './connection_watchdog';
import { EngineStatus, ENGINE_STATUS } from './local_engine/engine_status';
import type { LocalEngineKind } from './config';

/** The stdio pipe exposed by a running ovgenai/mlx runner. */
interface StdioRunner {
  stream(prompt: string, maxTokens: number, stop: string[], signal: AbortSignal): AsyncIterable<string>;
}

/**
 * Local-mode UI reaction to engine lifecycle statuses: status-bar labels,
 * completion suppression while the engine is busy, and the endpoint/stdio
 * switch-over when the engine becomes ready.
 */
export class LocalModeStatusUi {
  constructor(private readonly host: {
    statusBar: StatusBar;
    state: CompletionState;
    client: CompletionsClient;
    watchdog: Pick<ConnectionWatchdog, 'reportSuccess'>;
    stdioRunner: () => StdioRunner | undefined;
    engineKind: () => LocalEngineKind;
    /** Catalog label of the selected model, or "model" when unknown. */
    modelLabel: () => string;
    /** Redirects the completions endpoint used in local mode. */
    setEndpoint: (url: string | undefined) => void;
    /** Feeds the progress bar's stage label while nothing is downloading yet. */
    stage: (label: string) => void;
    log: { info(message: string): void; warn(message: string): void };
    /** Offered when a download fails (status.message starts with "Download failed"). */
    offerDownloadRetry?: (message: string) => void;
  }) {}

  kindLabel(): string {
    const kind = this.host.engineKind();
    return kind === 'ovgenai' ? 'ovgenai runner' : kind === 'mlx' ? 'mlx runner' : 'llama-server';
  }

  // The ovgenai "engine" download is the OpenVINO runtime, not the bundled runner.
  enginePhaseLabel(): string {
    return this.host.engineKind() === 'ovgenai' ? 'OpenVINO runtime' : this.kindLabel();
  }

  handle(status: EngineStatus): void {
    if (status.status === ENGINE_STATUS.ready) {
      // Re-enable completions suppressed while the engine was starting.
      this.host.state.setConnectionBlocked(false);
      this.host.statusBar.setConnectionReason(undefined);
      const runner = this.host.stdioRunner();
      if (runner !== undefined) {
        // ovgenai/mlx: completions flow through the stdio pipe, not an endpoint.
        this.host.client.setStdioSource((prompt, maxTokens, stop, signal) => runner.stream(prompt, maxTokens, stop, signal));
        this.host.client.setModelLabel(status.model);
        this.host.statusBar.setEngine(undefined);
        this.host.statusBar.setEngineDetail(status.device !== undefined ? `${status.model} (${status.device})` : status.model);
        this.host.log.info(`${BRAND} local engine ready: ${this.host.engineKind()} runner model=${status.modelPath}${status.device !== undefined ? ` device=${status.device}` : ''}`);
        this.host.watchdog.reportSuccess();
      } else {
        this.host.setEndpoint(status.baseUrl);
        this.host.client.refresh();
        void this.host.client.setApiKey(status.apiKey);
        this.host.watchdog.reportSuccess();
        this.host.statusBar.setEngine(undefined);
        this.host.statusBar.setEngineDetail(status.device !== undefined ? `${status.model} (${status.device})` : status.model);
        this.host.log.info(`${BRAND} local engine ready: ${status.baseUrl} model=${status.modelPath}${status.device !== undefined ? ` device=${status.device}` : ''} key=${status.apiKey ?? '(none — key authentication disabled)'}`);
      }
    } else if (status.status === ENGINE_STATUS.error) {
      this.host.client.setStdioSource(undefined);
      this.host.client.setModelLabel(undefined);
      this.host.setEndpoint('');
      this.host.client.refresh();
      this.host.statusBar.setEngineDetail(undefined);
      // Block completions too: the placeholder endpoint would only produce a
      // misleading "Cannot reach the completions API" connection error.
      this.host.state.setConnectionBlocked(true);
      this.host.statusBar.setConnectionReason(status.message);
      this.host.statusBar.setEngine(`$(error) engine: ${status.message}`);
      this.host.log.warn(`${BRAND} local engine error: ${status.message}`);
      if (status.message.startsWith('Download failed')) {
        this.host.offerDownloadRetry?.(status.message);
      }
    } else {
      const label = status.status === ENGINE_STATUS.awaitingInput
        ? status.prompt
        : status.status === ENGINE_STATUS.preparingEngine
        ? `downloading ${this.enginePhaseLabel()}…`
        : status.status === ENGINE_STATUS.preparingModel
          ? `downloading ${this.host.modelLabel()}…`
          : `starting ${this.kindLabel()}: ${this.host.modelLabel()}…${status.status === ENGINE_STATUS.starting && status.npuCompile ? ' (the first NPU start compiles the model — several minutes)' : ''}`;
      this.host.stage(label);
      this.host.statusBar.setEngine(`$(loading~spin) ${label}`);
      // Suppress completions while the engine is starting: otherwise typing
      // races the placeholder local endpoint and reports a confusing
      // "Cannot reach the completions API (http://127.0.0.1:0/v1)" connection
      // error instead of quietly waiting for the engine to come up.
      this.host.state.setConnectionBlocked(true);
      this.host.statusBar.setConnectionReason(label);
    }
  }
}
