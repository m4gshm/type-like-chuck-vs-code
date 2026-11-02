import * as vscode from 'vscode';
import type { ExtensionConfig, LocalDevice } from './config';
import type { ApiKeyStorage } from './api_key_storage';
import type { CompletionsClient, ModelInfo } from './completions_client';
import type { CompletionProvider } from './completion_provider';
import type { CompletionState } from './completion_state';
import type { ModelConfig } from './model_config';
import type { StatusBar } from './status_bar';
import type { ConnectionWatchdog } from './connection_watchdog';
import { pickSupportedModel } from './model_selection';
import { ResetTarget } from './local_engine/engine_manager';
import { localModelDiskDialog, localModelPickerItems } from './local_engine/model_picker';
import { bundledMlxRunnerPath, bundledOvgenaiRunnerPath } from './local_engine/bundled_runners';

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface TlcCommandDeps {
  extensionPath: string;
  config: () => ExtensionConfig;
  client: CompletionsClient;
  modelConfig: ModelConfig;
  apiKeyStorage: ApiKeyStorage;
  complectionState: CompletionState;
  complectionProvider: CompletionProvider;
  statusBar: StatusBar;
  connectionWatchdog: ConnectionWatchdog;
  engineTasks: { run(title: string, task: (signal: AbortSignal) => Promise<unknown>): Promise<void> };
  engineManager: { reset(target: ResetTarget, signal?: AbortSignal): Promise<unknown> };
  checkServerModels: () => Promise<ModelInfo[]>;
  reportServerReachability: () => Promise<void>;
  setApiKey: (key: string | undefined) => Promise<void>;
  clearCopilotAutoDisabled: () => void;
  warn: (message: string) => void;
}

const updateTlcSetting = async (key: string, value: unknown): Promise<void> => {
  await vscode.workspace.getConfiguration('tlc').update(key, value, vscode.ConfigurationTarget.Global);
};

export const pickLocalModelFromDisk = async (kind: ExtensionConfig['localEngineKind']): Promise<string | undefined> => {
  const dialog = localModelDiskDialog(kind);
  const file = await vscode.window.showOpenDialog({
    canSelectFiles: dialog.canSelectFiles,
    canSelectFolders: dialog.canSelectFolders,
    canSelectMany: false,
    filters: dialog.filters,
    title: 'TLC: Select Local Model From Disk',
  });
  return file?.[0]?.fsPath;
};

/**
 * Shows the model QuickPick (server models with supported-family marks
 * plus a manual-entry item) and returns the chosen model id, if any.
 */
export const presentModelQuickPick = async (deps: TlcCommandDeps, models: ModelInfo[]): Promise<{ id: string; contextLength?: number } | undefined> => {
  const supported = pickSupportedModel(models.map((m) => m.id));
  const items: Array<vscode.QuickPickItem & { model: ModelInfo }> = models.map((m) => ({
    label: m.id,
    description:
      m.id === supported
        ? '$(check) supported'
        : m.id === deps.config().model
          ? '$(check) current'
          : undefined,
    detail: m.contextLength !== undefined ? `context: ${m.contextLength}` : undefined,
    model: m,
  }));
  items.push({
    label: '$(pencil) Enter model id manually…',
    detail: `Current: ${deps.config().model}`,
    model: { id: '' },
  });

  const chosen = await vscode.window.showQuickPick(items, {
    title: 'TLC: Select Model',
    placeHolder: 'Model to use for completions (fetched from the server\'s /v1/models)',
    matchOnDescription: true,
  });
  if (chosen === undefined) {
    return undefined;
  }
  if (chosen.model.id.length > 0) {
    return { id: chosen.model.id, contextLength: chosen.model.contextLength };
  }
  const manual = await vscode.window.showInputBox({
    title: 'TLC: Model Id',
    prompt: 'Model name sent in completion requests',
    value: deps.config().model,
  });
  return manual === undefined ? undefined : { id: manual };
};

export const registerTlcCommands = (deps: TlcCommandDeps): vscode.Disposable[] => {
  const { config } = deps;
  return [
    vscode.commands.registerCommand('tlc.triggerCompletion', () => {
      if (deps.complectionState.isEnabled()) {
        deps.complectionProvider.resetThrottle();
      }
      // When TLC is disabled the generic trigger lets another provider (e.g.
      // Copilot) answer on the same keys.
      void vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    }),
    vscode.commands.registerCommand('tlc.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'API key for the completions API (leave empty for servers that need none)',
        password: true,
      });
      if (key === undefined) {
        return;
      }
      if (key.length === 0) {
        await deps.apiKeyStorage.clear();
      } else {
        await deps.apiKeyStorage.set(key);
      }
      if (config().apiKey.length > 0) {
        void vscode.window.showWarningMessage(
          'TLC: tlc.openai.apiKey is set in the settings and takes precedence over the secret-stored key.',
        );
      }
      await deps.setApiKey(config().apiKey.length > 0 ? config().apiKey : key.length === 0 ? undefined : key);
      void vscode.window.showInformationMessage('TLC API key updated.');
    }),
    vscode.commands.registerCommand('tlc.clearApiKey', async () => {
      await deps.apiKeyStorage.clear();
      await deps.setApiKey(config().apiKey.length > 0 ? config().apiKey : undefined);
      void vscode.window.showInformationMessage('TLC API key cleared.');
    }),
    vscode.commands.registerCommand('tlc.testConnection', () => deps.reportServerReachability()),
    vscode.commands.registerCommand('tlc.selectModel', async () => {
      let models: ModelInfo[] = [];
      try {
        models = await deps.client.listModels();
      } catch (err) {
        deps.warn(`Cannot list models from ${config().baseUrl}: ${errMessage(err)}`);
        void vscode.window.showWarningMessage(
          `Cannot fetch the model list from ${config().baseUrl}. You can still enter the model id manually.`,
        );
      }

      const chosen = await presentModelQuickPick(deps, models);
      if (chosen !== undefined) {
        await deps.modelConfig.setModel(chosen.id, chosen.contextLength);
      }
    }),
    vscode.commands.registerCommand('tlc.selectMode', async () => {
      const chosen = await vscode.window.showQuickPick(
        [
          { label: '$(cloud) Remote server', detail: `OpenAI-compatible API at ${config().baseUrl}`, value: 'remote' },
          { label: '$(device-desktop) Local engine', detail: 'TLC-managed llama.cpp (downloaded on demand, optional NPU/GPU)', value: 'local' },
        ],
        { title: 'TLC: Select Mode', placeHolder: `Current: ${config().mode}` },
      );
      if (chosen !== undefined && chosen.value !== config().mode) {
        await updateTlcSetting('mode', chosen.value);
      }
    }),
    vscode.commands.registerCommand('tlc.selectLocalModel', async () => {
      const kind = config().localEngineKind;
      const chosen = await vscode.window.showQuickPick(
        localModelPickerItems(kind, config().localModel),
        { title: 'TLC: Select Local Model', placeHolder: 'Model downloaded for the local engine' },
      );
      if (chosen === undefined) {
        return;
      }
      if (chosen.value === 'disk') {
        const file = await pickLocalModelFromDisk(kind);
        if (file !== undefined) {
          // Path first (it restarts the engine with the file), then the
          // "custom" id points back at the same file.
          await updateTlcSetting('local.customModelPath', file);
          await updateTlcSetting('local.model', 'custom');
        }
        return;
      }
      // A catalog model replaces any offline modelPath override; the id is
      // applied first so a single restart picks up both changes.
      await updateTlcSetting('local.model', chosen.value);
      await updateTlcSetting('local.customModelPath', undefined);
    }),
    vscode.commands.registerCommand('tlc.selectLocalDevice', async () => {
      const kind = config().localEngineKind;
      const items = kind === 'mlx'
        ? [
            { label: '$(zap) GPU (MLX, Metal)', value: 'gpu' as LocalDevice },
          ]
        : [
            { label: '$(zap) Auto (GPU → CPU)', value: 'auto' as LocalDevice },
            { label: kind === 'ovgenai' ? 'NPU (Intel Core Ultra, OpenVINO GenAI runner)' : 'NPU (uses GPU for llama.cpp)', value: 'npu' as LocalDevice },
            { label: kind === 'ovgenai' ? 'GPU (OpenVINO GenAI runner)' : 'GPU (vulkan build)', value: 'gpu' as LocalDevice },
            { label: 'CPU', value: 'cpu' as LocalDevice },
          ];
      const chosen = await vscode.window.showQuickPick(
        items.map((i) => ({
          label: i.label,
          description: config().localDevice === i.value ? '$(check) current' : undefined,
          value: i.value,
        })),
        { title: 'TLC: Select Local Device' },
      );
      if (chosen !== undefined) {
        await updateTlcSetting('local.device', chosen.value);
      }
    }),
    vscode.commands.registerCommand('tlc.resetLocalEngine', async () => {
      const targets: Array<{ label: string; detail: string; target: ResetTarget }> = [
        { label: 'Re-download engine', detail: 'Deletes the downloaded engine (llama.cpp build or OpenVINO runtime) and downloads it again, choosing the engine kind first', target: 'engine' },
        { label: 'Re-download model', detail: 'Deletes the selected model (GGUF or OpenVINO IR) and downloads it again', target: 'model' },
        { label: 'Clear model cache', detail: 'Deletes the model cache; it is rebuilt on the next start', target: 'cache' },
      ];
      const chosen = await vscode.window.showQuickPick(targets, { title: 'TLC: Reset Local Engine' });
      if (chosen === undefined) {
        return;
      }
      if (config().mode !== 'local') {
        void vscode.window.showInformationMessage('TLC: switch to the local engine mode first (TLC: Select Mode).');
        return;
      }
      if (chosen.target === 'engine') {
        // The kind decides what gets downloaded next, so pick it here; the
        // download-or-existing-folder question follows for the chosen kind.
        const kinds = [
          { label: '$(zap) Auto', detail: 'Best match for the platform (mlx on Apple Silicon, OpenVINO GenAI on Intel, llama.cpp elsewhere)', value: 'auto' },
          { label: '$(device-desktop) llama.cpp', detail: 'GGUF models via llama-server (vulkan GPU, CPU fallback)', value: 'llama.cpp' },
          ...(bundledOvgenaiRunnerPath(deps.extensionPath) !== undefined
            ? [{ label: '$(circuit-board) OpenVINO GenAI', detail: 'Native IR models on Intel NPU/GPU/CPU', value: 'ovgenai' }]
            : []),
          ...(bundledMlxRunnerPath(deps.extensionPath) !== undefined
            ? [{ label: '$(beam) MLX', detail: 'MLX 4-bit models on Apple Metal', value: 'mlx' }]
            : []),
        ];
        const kind = await vscode.window.showQuickPick(
          kinds.map((k) => ({ ...k, description: config().localEngineKind === k.value ? '$(check) current' : undefined })),
          { title: 'TLC: Reset Local Engine — Engine Kind' },
        );
        if (kind === undefined) {
          return;
        }
        if (kind.value !== config().localEngineKind) {
          await updateTlcSetting('local.engineKind', kind.value);
        }
      }
      await deps.engineTasks.run(`TLC: resetting the local ${chosen.target}`, (signal) => deps.engineManager.reset(chosen.target, signal));
    }),
    vscode.commands.registerCommand('tlc.enableDisableCompletions', async () => {
      // Clicking the error icon retries the connection instead of toggling:
      // the user's intent there is "fix it", not "disable".
      if (deps.connectionWatchdog.isFailing()) {
        deps.connectionWatchdog.reset();
        deps.statusBar.setBusy(true);
        try {
          const models = await deps.checkServerModels();
          void vscode.window.showInformationMessage(
            `TLC: ${config().baseUrl} is reachable again (${models.length} model${models.length === 1 ? '' : 's'}).`,
          );
        } catch (err) {
          deps.connectionWatchdog.reportFailure(
            `TLC: cannot reach ${config().baseUrl}: ${errMessage(err)}`,
          );
        } finally {
          deps.statusBar.setBusy(false);
        }
        return;
      }
      // Manual toggle wins: cancel any auto-disable/auto-re-enable watch.
      deps.connectionWatchdog.reset();
      // A manual toggle is the user's choice: Copilot must not undo it later.
      deps.clearCopilotAutoDisabled();
      const enabled = !deps.complectionState.isEnabled();
      await deps.complectionState.setEnabled(enabled);
      if (!enabled) {
        deps.complectionProvider.onDisabled();
      }
      deps.statusBar.refresh();
      void vscode.window.showInformationMessage(enabled ? 'TLC completions enabled.' : 'TLC completions disabled.');
    }),
  ];
};
