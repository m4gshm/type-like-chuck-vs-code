import * as vscode from 'vscode';
import { readConfig, ExtensionConfig, LocalDevice, LocalEngineKind } from './config';
import { ApiKeyStorage } from './api_key_storage';
import { CompletionsClient, ModelInfo } from './completions_client';
import { CompletionProvider } from './completion_provider';
import { CompletionState } from './completion_state';
import { ForbiddenFiles } from './forbidden_files';
import { ModelConfig } from './model_config';
import { StatusBar } from './status_bar';
import { ConnectionWatchdog } from './connection_watchdog';
import { buildTemplateRegistry, ResolvedTemplates } from './templates';
import { pickSupportedModel, pickTemplateForModel } from './model_selection';
import { MODEL_POLL_INTERVAL_MS, modelIdsKey } from './model_polling';
import { copilotActive, CopilotEnableSetting } from './copilot_gate';
import { DISTRO_CHOICE_DOWNLOAD, EngineManager, EngineStatus, ENGINE_STATUS, ResetTarget } from './local_engine/engine_manager';
import { DownloadProgress } from './local_engine/downloader';
import { DEFAULT_LOCAL_MODEL, isLocalModelId } from './local_engine/model_catalog';
import { effectiveLocalModel, localModelDiskDialog, localModelPickerItems, localModelSpec } from './local_engine/model_picker';
import { migrateDirectory, resolveEnginePaths } from './local_engine/paths';
import { probeCapability } from './local_engine/capability';

/** Platform label under binaries/ovgenai; undefined when no runner is bundled. */
function ovgenaiPlatformDir(platform: NodeJS.Platform, arch: string): string | undefined {
  if (platform === 'win32' && arch === 'x64') {
    return 'win32-x64';
  }
  if (platform === 'linux' && arch === 'x64') {
    return 'linux-x64';
  }
  return undefined;
}

function bundledOvgenaiRunnerPath(extensionPath: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  const dir = ovgenaiPlatformDir(platform, arch);
  if (dir === undefined) {
    return undefined;
  }
  const binary = platform === 'win32' ? 'tlc-ovgenai-runner.exe' : 'tlc-ovgenai-runner';
  // TLC_RUNNER_DIR selects the binaries/<engine> folder; the F5 "release" launch
  // configuration points it at the pinned backend release download.
  const engineDir = process.env.TLC_RUNNER_DIR?.trim() || 'ovgenai';
  return `${extensionPath}/binaries/${engineDir}/${dir}/${binary}`;
}

/** Path of the bundled mlx runner; defined on macOS arm64 only. */
function bundledMlxRunnerPath(extensionPath: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  if (platform !== 'darwin' || arch !== 'arm64') {
    return undefined;
  }
  return `${extensionPath}/binaries/mlx/darwin-arm64/tlc-mlx-runner`;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('TLC', { log: true });
  const warn = (message: string): void => output.warn(message);
  const info = (message: string): void => output.info(message);
  const debug = (message: string): void => output.debug(message);
  const trace = (message: string): void => output.trace(message);
  const error = (message: string, err: unknown): void => {
    const stack = err instanceof Error ? err.stack ?? '' : String(err);
    output.error(`${message}\n${stack}`);
  };

  let templates: ResolvedTemplates;
  let forbidden: ForbiddenFiles;
  const modelConfig = new ModelConfig(
    {
      readConfig: readConfig,
      updateSetting: async (key, value) => {
        await vscode.workspace.getConfiguration('tlc').update(key === 'model' ? 'openai.model' : key, value, vscode.ConfigurationTarget.Global);
      },
      warn: warn,
      info: info,
      notify: (message) => void vscode.window.showInformationMessage(message),
      chooseModel: (models) => presentModelQuickPick(models),
      onModelChanged: (modelId) => applyTemplateSuggestion(modelId),
    },
    readConfig(),
  );
  const config = (): ExtensionConfig => modelConfig.current;

  /**
   * Switches the prompt template to the built-in matching the model family
   * (unless the user chose "custom" or the match is already selected).
   * `template` (from the local model catalog) overrides name matching.
   */
  const applyTemplateSuggestion = async (modelId: string, template?: string): Promise<void> => {
    const selected = config().promptTemplate;
    if (selected === 'custom') {
      return;
    }
    const suggestion = template ?? pickTemplateForModel(modelId);
    if (suggestion === undefined || suggestion === selected) {
      return;
    }
    await vscode.workspace.getConfiguration('tlc').update('promptTemplate', suggestion, vscode.ConfigurationTarget.Global);
    templates = buildTemplateRegistry(suggestion, config().customTemplate);
    void vscode.window.showInformationMessage(
      `TLC: template "${suggestion}" selected to match model "${modelId}".`,
    );
  };
  templates = buildTemplateRegistry(config().promptTemplate, config().customTemplate);
  forbidden = new ForbiddenFiles(config().forbiddenFileNames);

  const apiKeyStorage = new ApiKeyStorage(context.secrets);
  let localEndpoint: string | undefined;
  const client = new CompletionsClient(
    () => (config().mode === 'local' ? localEndpoint ?? '' : config().baseUrl),
    () => config().model,
    () => config().maxTokens,
    (message) => console.log(`[TLC:cause] ${message}`),
    (message) => trace(message),
  );

  const complectionState = new CompletionState(context.globalState);
  const statusBar = new StatusBar(complectionState);

  const connectionWatchdog = new ConnectionWatchdog({
    probe: () => client.listModels(),
    disable: (reason) => {
      complectionProvider.cancelActiveRequests();
      complectionState.setConnectionBlocked(true);
      statusBar.setConnectionReason(reason);
      statusBar.refresh();
    },
    enable: () => {
      complectionState.setConnectionBlocked(false);
      statusBar.setConnectionReason(undefined);
      statusBar.clearError();
      statusBar.refresh();
    },
    notifyFailure: (message) => {
      statusBar.setConnectionReason(message);
      void vscode.window.showWarningMessage(message);
    },
    clearFailure: () => {
      statusBar.setConnectionReason(undefined);
      statusBar.clearError();
    },
    warn: warn,
  });

  const enginePaths = (): { engineRoot: string; modelDir: string; modelCacheDir: string } =>
    resolveEnginePaths(
      {
        engineDir: config().localEngineDir,
        modelDir: config().localDownloadedModelsDir,
        modelCacheDir: config().localModelCacheDir,
      },
      context.globalStorageUri.fsPath,
    );
  let engineProgressListener: ((kind: 'engine' | 'model', progress: DownloadProgress) => void) | undefined;
  // The picked folder persists as tlc.local.distroDir so later starts skip the question.
  const askDistroOrDownload = async (kind: 'ovgenai' | 'llama.cpp'): Promise<string | typeof DISTRO_CHOICE_DOWNLOAD | undefined> => {
    const kindLabel = kind === 'ovgenai' ? 'OpenVINO GenAI runtime' : 'llama.cpp build';
    const chosen = await vscode.window.showQuickPick(
      [
        { label: '$(cloud-download) Download', detail: `Download the ${kindLabel} archive on demand`, value: DISTRO_CHOICE_DOWNLOAD },
        { label: '$(folder-opened) Use an existing folder…', detail: `Pick an unpacked ${kindLabel} on disk (saved to tlc.local.distroDir)`, value: 'disk' as const },
      ],
      { title: 'TLC: Local Engine Runtime', placeHolder: `Download the ${kindLabel} or use an existing unpacked distribution?` },
    );
    if (chosen === undefined) {
      return undefined;
    }
    if (chosen.value === DISTRO_CHOICE_DOWNLOAD) {
      return DISTRO_CHOICE_DOWNLOAD;
    }
    const folder = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: 'TLC: Select Unpacked Engine Distribution',
    });
    if (folder?.[0] === undefined) {
      return undefined;
    }
    const dir = folder[0].fsPath;
    await vscode.workspace.getConfiguration('tlc').update('local.distroDir', dir, vscode.ConfigurationTarget.Global);
    return dir;
  };
  const engineManager = new EngineManager({
    platform: process.platform,
    arch: process.arch,
    paths: enginePaths,
    settings: () => ({
      modelId: config().localModel,
      device: config().localDevice,
      engineKind: config().localEngineKind,
      npuContextLength: config().localNpuContextMaxLength,
      releaseTag: config().localLlamaCppRelease,
      distroDir: config().localDistroDir,
      huggingfaceUrl: config().localHuggingfaceUrl,
      githubUrl: config().localGithubUrl,
      openvinoUrl: config().localOpenvinoUrl,
      // The custom path applies only while the model setting is "custom":
      // a stale path must not silently override a catalog model choice.
      modelPath: config().localModel === 'custom' ? config().localCustomModelPath : '',
      modelUrls: config().localModelUrls,
      ovgenaiRunnerPath: bundledOvgenaiRunnerPath(context.extensionPath),
      mlxRunnerPath: bundledMlxRunnerPath(context.extensionPath),
      apiKeyEnabled: config().localApiKeyEnabled,
    }),
    onStatus: (status) => handleEngineStatus(status),
    onProgress: (kind, progress) => engineProgressListener?.(kind, progress),
    // Duplicated into the output channel: toasts auto-dismiss, the log stays.
    notify: (message) => {
      info(message);
      void vscode.window.showInformationMessage(message);
    },
    log: trace,
    warn: warn,
    askDistroOrDownload,
  });

  /**
   * Local-mode endpoint handling: while the engine is not ready the client
   * points at a dead local URL (never at the remote server); once ready it
   * points at the engine and uses its per-session API key.
   */
  /** Human labels for the current local engine kind and model (progress + status bar). */
  const localKindLabel = (): string => {
    const kind = config().localEngineKind;
    return kind === 'ovgenai' ? 'ovgenai runner' : kind === 'mlx' ? 'mlx runner' : 'llama-server';
  };
  const localModelName = (): string => localModelSpec(config().localEngineKind, config().localModel)?.label ?? 'model';
  // The ovgenai "engine" download is the OpenVINO runtime, not the bundled runner.
  const localEnginePhaseLabel = (): string =>
    config().localEngineKind === 'ovgenai' ? 'OpenVINO runtime' : localKindLabel();

  const handleEngineStatus = (status: EngineStatus): void => {
    if (status.status === ENGINE_STATUS.ready) {
      // Re-enable completions suppressed while the engine was starting.
      complectionState.setConnectionBlocked(false);
      statusBar.setConnectionReason(undefined);
      const runner = engineManager.stdioRunner();
      if (runner !== undefined) {
        // ovgenai/mlx: completions flow through the stdio pipe, not an endpoint.
        client.setStdioSource((prompt, maxTokens, stop, signal) => runner.stream(prompt, maxTokens, stop, signal));
        client.setModelLabel(status.model);
        statusBar.setEngine(`$(check) ${status.model} (${status.device})`);
        info(`TLC local engine ready: ${config().localEngineKind} runner model=${status.modelPath} device=${status.device}`);
        connectionWatchdog.reportSuccess();
      } else {
        localEndpoint = status.baseUrl;
        client.refresh();
        void client.setApiKey(status.apiKey);
        connectionWatchdog.reportSuccess();
        statusBar.setEngine(`$(check) ${status.model} (${status.device})`);
        info(`TLC local engine ready: ${status.baseUrl} model=${status.modelPath} device=${status.device} key=${status.apiKey ?? '(none — key authentication disabled)'}`);
      }
    } else if (status.status === ENGINE_STATUS.error) {
      client.setStdioSource(undefined);
      client.setModelLabel(undefined);
      localEndpoint = '';
      client.refresh();
      // Block completions too: the placeholder endpoint would only produce a
      // misleading "Cannot reach the completions API" connection error.
      complectionState.setConnectionBlocked(true);
      statusBar.setConnectionReason(status.message);
      statusBar.setEngine(`$(error) engine: ${status.message}`);
      warn(`TLC local engine error: ${status.message}`);
    } else {
      const label = status.status === ENGINE_STATUS.awaitingInput
        ? status.prompt
        : status.status === ENGINE_STATUS.preparingEngine
        ? `downloading ${localEnginePhaseLabel()}…`
        : status.status === ENGINE_STATUS.preparingModel
          ? `downloading ${localModelName()}…`
          : `starting ${localKindLabel()}: ${localModelName()}… (the first NPU start compiles the model — several minutes)`;
      engineStageLabel = label;
      statusBar.setEngine(`$(loading~spin) ${label}`);
      // Suppress completions while the engine is starting: otherwise typing
      // races the placeholder local endpoint and reports a confusing
      // "Cannot reach the completions API (http://127.0.0.1:0/v1)" connection
      // error instead of quietly waiting for the engine to come up.
      complectionState.setConnectionBlocked(true);
      statusBar.setConnectionReason(label);
    }
  };

  /** Runs a long engine task behind a progress notification with byte counts. */
  const formatBytes = (bytes: number): string => {
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
      value /= 1000;
      unit += 1;
    }
    return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)}${units[unit]}`;
  };
  // Kept in sync by handleEngineStatus so the progress bar can show a
  // meaningful stage before the first byte arrives.
  let engineStageLabel = 'starting…';
  let activeEngineTask: Promise<void> | undefined;
  const runEngineTask = async (title: string, task: (signal: AbortSignal) => Promise<unknown>): Promise<void> => {
    // Concurrent callers (startup + settings-change restart) share one
    // notification and one underlying task instead of stacking messages.
    if (activeEngineTask !== undefined) {
      return activeEngineTask;
    }
    activeEngineTask = runEngineTaskOnce(title, task);
    try {
      await activeEngineTask;
    } finally {
      activeEngineTask = undefined;
    }
  };

  const runEngineTaskOnce = async (title: string, task: (signal: AbortSignal) => Promise<unknown>): Promise<void> => {
    const startedAt = Date.now();
    let progress: DownloadProgress = { downloadedBytes: 0, totalBytes: undefined };
    let progressKind: 'engine' | 'model' = 'engine';
    engineProgressListener = (kind, p) => {
      if (kind !== progressKind) {
        // A new phase started: never show the previous phase's byte counts.
        progress = { downloadedBytes: 0, totalBytes: p.totalBytes };
        progressKind = kind;
        return;
      }
      progress = p;
    };
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (bar, token) => {
      const cancel = new AbortController();
      token.onCancellationRequested(() => cancel.abort());
      const ticker = setInterval(() => {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        const elapsedLabel = elapsed >= 10 ? ` (${Math.floor(elapsed / 60)}m ${elapsed % 60}s elapsed)` : '';
        // Until the first byte arrives the byte counter reads 0 — show the
        // stage instead; "0B" confuses more than it informs.
        if (progress.downloadedBytes === 0) {
          bar.report({ message: `${engineStageLabel}${elapsedLabel}` });
          return;
        }
        const total = progress.totalBytes;
        const part = `${formatBytes(progress.downloadedBytes)}${total !== undefined ? ` / ${formatBytes(total)}` : ''}`;
        const phaseLabel = progressKind === 'engine' ? localEnginePhaseLabel() : `model: ${localModelName()}`;
        bar.report({ message: `${phaseLabel}: ${part}` });
      }, 200);
      try {
        await task(cancel.signal);
      } catch (err) {
        if (!(err instanceof Error && err.name === 'AbortError')) {
          const message = `TLC local engine: ${err instanceof Error ? err.message : String(err)}`;
          void vscode.window.showWarningMessage(message, 'Retry').then((choice) => {
            if (choice === 'Retry') {
              void runEngineTask(title, task);
            }
          });
        }
      } finally {
        clearInterval(ticker);
        engineProgressListener = undefined;
      }
    });
  };

  /** Local model template hint: catalog spec (label + template id) for
   * catalog models; for From-disk models the family is matched by the path
   * name since the catalog id may be stale. */
  const localModelHint = (): { modelId: string; template?: string } => {
    const modelPath = config().localModel === 'custom' ? config().localCustomModelPath : '';
    if (modelPath.length > 0) {
      return { modelId: modelPath };
    }
    const spec = localModelSpec(config().localEngineKind, config().localModel);
    return spec !== undefined ? { modelId: spec.label, template: spec.template } : { modelId: config().localModel };
  };

  /** Opens the From-disk model file dialog for the engine kind; returns the picked path. */
  const pickLocalModelFromDisk = async (kind: LocalEngineKind): Promise<string | undefined> => {
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

  const applyMode = async (): Promise<void> => {
    if (config().mode === 'local') {
      localEndpoint = '';
      client.refresh();
      await client.setApiKey(undefined);
      // Make the FIM template follow the selected model (spec-driven for
      // catalog models, name-matched for From-disk), unless custom.
      const hint = localModelHint();
      await applyTemplateSuggestion(hint.modelId, hint.template);
      handleEngineStatus({ status: ENGINE_STATUS.starting });
      await runEngineTask('TLC: preparing the local engine', (signal) => managerEnsureReady(signal));
    } else {
      await engineManager.stop();
      client.setStdioSource(undefined);
      client.setModelLabel(undefined);
      localEndpoint = undefined;
      client.refresh();
      // The local branch blocks completions while the engine runs; going back
      // to remote must lift the block or completions stay dead.
      complectionState.setConnectionBlocked(false);
      statusBar.setConnectionReason(undefined);
      statusBar.setEngine(undefined);
      await syncApiKey();
    }
  };

  const managerEnsureReady = async (signal?: AbortSignal): Promise<void> => {
    try {
      await engineManager.ensureReady(signal);
    } catch {
      // Status and retry UI are handled by the manager's error status and the
      // progress task's Retry action.
    }
  };

  /** Resolves and migrates the local directories, then logs them. */
  const syncEngineDirectories = async (): Promise<void> => {
    const paths = enginePaths();
    const previous = previousEnginePaths;
    previousEnginePaths = paths;
    if (previous !== undefined) {
      await migrateDirectory(previous.engineRoot, paths.engineRoot);
      await migrateDirectory(previous.modelDir, paths.modelDir);
      await migrateDirectory(previous.modelCacheDir, paths.modelCacheDir);
    }
    info(`TLC local engine directories: engine=${paths.engineRoot} models=${paths.modelDir} cache=${paths.modelCacheDir}`);
    // Engine runtime internals (OV GenAI: ~85 chars below engineRoot) must fit
    // the Windows MAX_PATH of 260, including a custom tlc.local.engineDir.
    if (paths.engineRoot.length + 100 > 260) {
      void vscode.window.showWarningMessage(
        `TLC: the engine directory is long (${paths.engineRoot.length} characters); runtime library paths may exceed the Windows 260-character limit and fail to load. Consider a shorter tlc.local.engineDir.`,
      );
    }
  };
  let previousEnginePaths: ReturnType<typeof enginePaths> | undefined;

  const complectionProvider = new CompletionProvider({
    client,
    getConfig: config,
    resolveTemplates: () => templates,
    forbidden: () => forbidden,
    completionState: complectionState,
    statusBar: statusBar,
    connectionWatchdog: connectionWatchdog,
    toRelativePath: (p: string) => vscode.workspace.asRelativePath(p),
    warn: warn,
    debug: debug,
    trace: trace,
    error: error,
  });

  /**
   * Fetches /v1/models and applies the list when it changed since the last
   * check (startup, poll, baseUrl change, manual test). Reports reachability
   * to the watchdog. `lastModelIds === undefined` forces the first check.
   */
  let lastModelIds: string | undefined;
  const checkServerModels = async (): Promise<ModelInfo[]> => {
    const models = await client.listModels();
    connectionWatchdog.reportSuccess();
    if (config().mode === 'local') {
      // The local engine's model list must not feed the remote model picker.
      return models;
    }
    const ids = modelIdsKey(models);
    const changed = lastModelIds !== ids;
    lastModelIds = ids;
    if (changed && models.length > 0) {
      await modelConfig.applyModelList(models);
    }
    return models;
  };

  const selector: vscode.DocumentSelector = { pattern: '**' };
  const providerRegistration = vscode.languages.registerInlineCompletionItemProvider(selector, complectionProvider);

  /**
   * Shows the model QuickPick (server models with supported-family marks
   * plus a manual-entry item) and returns the chosen model id, if any.
   */
  const presentModelQuickPick = async (models: ModelInfo[]): Promise<{ id: string; contextLength?: number } | undefined> => {
    const supported = pickSupportedModel(models.map((m) => m.id));
    const items: Array<vscode.QuickPickItem & { model: ModelInfo }> = models.map((m) => ({
      label: m.id,
      description:
        m.id === supported
          ? '$(check) supported'
          : m.id === config().model
            ? '$(check) current'
            : undefined,
      detail: m.contextLength !== undefined ? `context: ${m.contextLength}` : undefined,
      model: m,
    }));
    items.push({
      label: '$(pencil) Enter model id manually…',
      detail: `Current: ${config().model}`,
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
      value: config().model,
    });
    return manual === undefined ? undefined : { id: manual };
  };

  context.subscriptions.push(
    output,
    statusBar,
    providerRegistration,
    vscode.commands.registerCommand('tlc.triggerCompletion', () => {
      if (complectionState.isEnabled()) {
        complectionProvider.resetThrottle();
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
        await apiKeyStorage.clear();
      } else {
        await apiKeyStorage.set(key);
      }
      if (config().apiKey.length > 0) {
        void vscode.window.showWarningMessage(
          'TLC: tlc.openai.apiKey is set in the settings and takes precedence over the secret-stored key.',
        );
      }
      await client.setApiKey(config().apiKey.length > 0 ? config().apiKey : key.length === 0 ? undefined : key);
      void vscode.window.showInformationMessage('TLC API key updated.');
    }),
    vscode.commands.registerCommand('tlc.clearApiKey', async () => {
      await apiKeyStorage.clear();
      await client.setApiKey(config().apiKey.length > 0 ? config().apiKey : undefined);
      void vscode.window.showInformationMessage('TLC API key cleared.');
    }),
    vscode.commands.registerCommand('tlc.testConnection', async () => {
      try {
        const models = await checkServerModels();
        const current = config().model;
        const onList = models.some((m) => m.id === current);
        void vscode.window.showInformationMessage(
          `TLC: ${config().baseUrl} is reachable (${models.length} model${models.length === 1 ? '' : 's'}). `
          + (onList
            ? `Current model: ${current}.`
            : `Model updated from the server (was "${current}").`),
        );
      } catch (err) {
        const message = `TLC: cannot reach ${config().baseUrl}: ${err instanceof Error ? err.message : String(err)}`;
        connectionWatchdog.reportFailure(message);
        void vscode.window.showWarningMessage(message);
      }
    }),
    vscode.commands.registerCommand('tlc.selectModel', async () => {
      let models: ModelInfo[] = [];
      try {
        models = await client.listModels();
      } catch (err) {
        warn(`Cannot list models from ${config().baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
        void vscode.window.showWarningMessage(
          `Cannot fetch the model list from ${config().baseUrl}. You can still enter the model id manually.`,
        );
      }

      const chosen = await presentModelQuickPick(models);
      if (chosen !== undefined) {
        await modelConfig.setModel(chosen.id, chosen.contextLength);
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
        await vscode.workspace.getConfiguration('tlc').update('mode', chosen.value, vscode.ConfigurationTarget.Global);
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
      const tlc = vscode.workspace.getConfiguration('tlc');
      if (chosen.value === 'disk') {
        const file = await pickLocalModelFromDisk(kind);
        if (file !== undefined) {
          // Path first (it restarts the engine with the file), then the
          // "custom" id points back at the same file.
          await tlc.update('local.customModelPath', file, vscode.ConfigurationTarget.Global);
          await tlc.update('local.model', 'custom', vscode.ConfigurationTarget.Global);
        }
        return;
      }
      // A catalog model replaces any offline modelPath override; the id is
      // applied first so a single restart picks up both changes.
      await tlc.update('local.model', chosen.value, vscode.ConfigurationTarget.Global);
      await tlc.update('local.customModelPath', undefined, vscode.ConfigurationTarget.Global);
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
        await vscode.workspace.getConfiguration('tlc').update('local.device', chosen.value, vscode.ConfigurationTarget.Global);
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
          { label: '$(device-desktop) llama.cpp', detail: 'GGUF models via llama-server (vulkan GPU, CPU fallback)', value: 'llama.cpp' },
          ...(bundledOvgenaiRunnerPath(context.extensionPath) !== undefined
            ? [{ label: '$(circuit-board) OpenVINO GenAI', detail: 'Native IR models on Intel NPU/GPU/CPU', value: 'ovgenai' }]
            : []),
          ...(bundledMlxRunnerPath(context.extensionPath) !== undefined
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
          await vscode.workspace.getConfiguration('tlc').update('local.engineKind', kind.value, vscode.ConfigurationTarget.Global);
        }
      }
      await runEngineTask(`TLC: resetting the local ${chosen.target}`, (signal) => engineManager.reset(chosen.target, signal));
    }),
    vscode.commands.registerCommand('tlc.enableDisableCompletions', async () => {
      // Clicking the error icon retries the connection instead of toggling:
      // the user's intent there is "fix it", not "disable".
      if (connectionWatchdog.isFailing()) {
        connectionWatchdog.reset();
        statusBar.setBusy(true);
        try {
          const models = await checkServerModels();
          void vscode.window.showInformationMessage(
            `TLC: ${config().baseUrl} is reachable again (${models.length} model${models.length === 1 ? '' : 's'}).`,
          );
        } catch (err) {
          connectionWatchdog.reportFailure(
            `TLC: cannot reach ${config().baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          statusBar.setBusy(false);
        }
        return;
      }
      // Manual toggle wins: cancel any auto-disable/auto-re-enable watch.
      connectionWatchdog.reset();
      // A manual toggle is the user's choice: Copilot must not undo it later.
      copilotAutoDisabled = false;
      const enabled = !complectionState.isEnabled();
      await complectionState.setEnabled(enabled);
      if (!enabled) {
        complectionProvider.onDisabled();
      }
      statusBar.refresh();
      void vscode.window.showInformationMessage(enabled ? 'TLC completions enabled.' : 'TLC completions disabled.');
    }),
  );

  /** Effective API key: the tlc.apiKey setting wins over secret storage. */
  const effectiveApiKey = async (): Promise<string | undefined> => {
    const fromSettings = config().apiKey;
    if (fromSettings.length > 0) {
      return fromSettings;
    }
    return apiKeyStorage.get();
  };
  const syncApiKey = async () => client.setApiKey(await effectiveApiKey());

  let copilotAutoDisabled = false;
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.kind === vscode.TextEditorSelectionChangeKind.Mouse
        || event.kind === vscode.TextEditorSelectionChangeKind.Command) {
        complectionProvider.cancelActiveRequests();
        return;
      }
      const positions = event.selections.map((s) => s.active);
      if (positions.length !== 1) {
        complectionProvider.cancelActiveRequests();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => complectionProvider.cancelActiveRequests()),
  );

  let copilotPrev: boolean | undefined;
  const updateCopilotPause = async (): Promise<void> => {
    if (!modelConfig.current.yieldToCopilot) {
      copilotPrev = undefined;
      return;
    }
    const copilotConfig = vscode.workspace.getConfiguration('github.copilot');
    const languageId = vscode.window.activeTextEditor?.document.languageId ?? 'plaintext';
    // getExtension misses the built-in Copilot core on newer VS Code builds,
    // so any github.copilot* extension (core or chat) counts as installed.
    const installed = vscode.extensions.getExtension('GitHub.copilot') !== undefined
      || vscode.extensions.all.some((e) => /^github\.copilot(-chat)?$/i.test(e.id));
    const active = copilotActive(
      installed,
      copilotConfig.get<CopilotEnableSetting>('enable'),
      copilotConfig.get<boolean>('inlineSuggest.enable'),
      languageId,
    );
    if (active === copilotPrev) {
      return;
    }
    const firstCheck = copilotPrev === undefined;
    copilotPrev = active;
    if (active && complectionState.isEnabled()) {
      copilotAutoDisabled = true;
      await complectionState.setEnabled(false);
      complectionProvider.onDisabled();
      statusBar.refresh();
      warn('GitHub Copilot detected: TLC completions disabled.');
      void vscode.window.showInformationMessage(
        'TLC completions are disabled because GitHub Copilot is enabled. TLC re-enables automatically when Copilot turns off.',
      );
    } else if (!active && copilotAutoDisabled) {
      copilotAutoDisabled = false;
      if (!firstCheck) {
        await complectionState.setEnabled(true);
        statusBar.refresh();
        void vscode.window.showInformationMessage('GitHub Copilot is off: TLC completions re-enabled.');
      }
    }
  };
  void updateCopilotPause();
  context.subscriptions.push(
    vscode.extensions.onDidChange(() => void updateCopilotPause()),
    vscode.window.onDidChangeActiveTextEditor(() => void updateCopilotPause()),
  );

  // Template field rules:
  // - marker/stop settings belong to the "custom" template only;
  // - selecting a built-in template removes stored copies of its markers;
  // - editing any field switches the selection to "custom".
  let syncingTemplateFields = false;
  const cleanupTemplateFields = async (selectedId: string | undefined): Promise<void> => {
    if (selectedId === undefined || selectedId === 'custom') {
      return;
    }
    const { template } = templates.registry.resolve(selectedId);
    if (!template || template.id !== selectedId) {
      return;
    }
    const cfg = vscode.workspace.getConfiguration('tlc');
    const parseStop = (raw: string | undefined): string =>
      (raw ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .join(',');
    const stored: Array<[string, string, (raw: string | undefined) => string]> = [
      ['prefix', template.markers.prefix, (raw) => raw ?? ''],
      ['suffix', template.markers.suffix, (raw) => raw ?? ''],
      ['middle', template.markers.middle, (raw) => raw ?? ''],
      ['stop', template.reservedTokens.join(','), parseStop],
    ];
    syncingTemplateFields = true;
    try {
      for (const [key, builtinValue, normalize] of stored) {
        if (normalize(cfg.get<string>(key)) === builtinValue) {
          await cfg.update(key, undefined, vscode.ConfigurationTarget.Global);
        }
      }
    } finally {
      syncingTemplateFields = false;
    }
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (
        event.affectsConfiguration('github.copilot.enable')
        || event.affectsConfiguration('github.copilot.inlineSuggest.enable')
        || event.affectsConfiguration('github.copilot.nextEditSuggestions.enabled')
        || event.affectsConfiguration('tlc.yieldToCopilot')
      ) {
        updateCopilotPause();
      }
      if (!event.affectsConfiguration('tlc')) {
        return;
      }
      // Refresh the cached config first: everything below (including
      // client.refresh()) derives from the new settings.
      const previousMode = config().mode;
      const previousEngineDirs = {
        engineDir: config().localEngineDir,
        modelDir: config().localDownloadedModelsDir,
        modelCacheDir: config().localModelCacheDir,
      };
      const previousLocal = {
        model: config().localModel,
        modelPath: config().localCustomModelPath,
        device: config().localDevice,
        apiKeyEnabled: config().localApiKeyEnabled,
        npuContextLength: config().localNpuContextMaxLength,
      };
      modelConfig.reload();
      if (event.affectsConfiguration('tlc.promptTemplate') && !syncingTemplateFields) {
        const selectedId = vscode.workspace.getConfiguration('tlc').get<string>('promptTemplate');
        if (selectedId !== 'custom') {
          await cleanupTemplateFields(selectedId);
        }
      } else if (
        !syncingTemplateFields
        && ['prefix', 'suffix', 'middle', 'stop'].some((s) => event.affectsConfiguration(`tlc.${s}`))
      ) {
        if (config().promptTemplate !== 'custom') {
          await vscode.workspace.getConfiguration('tlc').update('promptTemplate', 'custom', vscode.ConfigurationTarget.Global);
        }
      }

      // The SDK captures baseURL at construction time. In local mode the
      // getter resolves to the engine endpoint, so refresh stays harmless.
      const baseUrlChanged = event.affectsConfiguration('tlc.openai.baseUrl') || event.affectsConfiguration('tlc.baseUrl');
      if (baseUrlChanged) {
        client.refresh();
      }

      const modeChanged = event.affectsConfiguration('tlc.mode') && config().mode !== previousMode;
      const dirsChanged = config().localEngineDir !== previousEngineDirs.engineDir
        || config().localDownloadedModelsDir !== previousEngineDirs.modelDir
        || config().localModelCacheDir !== previousEngineDirs.modelCacheDir;
      const localTargetChanged = config().mode === 'local'
        && (effectiveLocalModel(config().localModel, config().localCustomModelPath) !== effectiveLocalModel(previousLocal.model, previousLocal.modelPath)
          || event.affectsConfiguration('tlc.local.device') && config().localDevice !== previousLocal.device
          || event.affectsConfiguration('tlc.local.apiKeyEnabled') && config().localApiKeyEnabled !== previousLocal.apiKeyEnabled
          || event.affectsConfiguration('tlc.local.npuContextMaxLength') && config().localNpuContextMaxLength !== previousLocal.npuContextLength);
      if (dirsChanged) {
        await syncEngineDirectories();
      }
      if (event.affectsConfiguration('tlc.local.model') && config().localModel === 'custom' && config().localCustomModelPath.length === 0) {
        // "custom" is meaningless without a file: ask for one immediately and
        // revert to the previous catalog model when the dialog is canceled.
        const picked = await pickLocalModelFromDisk(config().localEngineKind);
        if (picked !== undefined) {
          await vscode.workspace.getConfiguration('tlc').update('local.customModelPath', picked, vscode.ConfigurationTarget.Global);
        } else {
          const revert = previousLocal.model.length > 0 && previousLocal.model !== 'custom' ? previousLocal.model : DEFAULT_LOCAL_MODEL;
          await vscode.workspace.getConfiguration('tlc').update('local.model', revert, vscode.ConfigurationTarget.Global);
          warn(`TLC local engine: model "custom" was canceled — reset to ${revert}.`);
        }
      } else if (modeChanged) {
        await applyMode();
      } else if (localTargetChanged) {
        if (config().mode === 'local') {
          const hint = localModelHint();
          await applyTemplateSuggestion(hint.modelId, hint.template);
        }
        handleEngineStatus({ status: ENGINE_STATUS.starting });
        await runEngineTask('TLC: restarting the local engine', (signal) => managerEnsureReady(signal));
      }
      if (event.affectsConfiguration('tlc.openai.apiKey') || event.affectsConfiguration('tlc.apiKey')) {
        await syncApiKey();
      }

      templates = buildTemplateRegistry(config().promptTemplate, config().customTemplate);
      forbidden = new ForbiddenFiles(config().forbiddenFileNames);
      for (const warning of templates.warnings) {
        warn(warning);
      }

      // Resolve the model against the new server's list. Editing the setting
      // commits on Enter/blur: behave like "TLC: Test Connection" and surface
      // the outcome to the user. Local mode never contacts the remote server.
      if (baseUrlChanged && config().mode === 'remote') {
        try {
          const models = await checkServerModels();
          const current = config().model;
          const onList = models.some((m) => m.id === current);
          void vscode.window.showInformationMessage(
            `TLC: ${config().baseUrl} is reachable (${models.length} model${models.length === 1 ? '' : 's'}). `
            + (onList ? `Current model: ${current}.` : `Model updated from the server (was "${current}").`),
          );
        } catch (err) {
          const message = `TLC: cannot reach ${config().baseUrl}: ${err instanceof Error ? err.message : String(err)}`;
          connectionWatchdog.reportFailure(message);
          void vscode.window.showWarningMessage(message);
        }
      }
    }),
  );

  // Poll the server's model list: detect model changes while the extension
  // runs (the server may load another model) and double as a health probe.
  const pollTimer = setInterval(() => {
    if (config().mode === 'local') {
      // The engine manager owns local health; never probe the remote server.
      return;
    }
    void checkServerModels().catch((err: unknown) => {
      connectionWatchdog.reportFailure(
        `Cannot reach the completions API (${config().baseUrl}): ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, MODEL_POLL_INTERVAL_MS);
  pollTimer.unref?.();
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(pollTimer)));
  context.subscriptions.push(
    new vscode.Disposable(() => {
      void engineManager.stop();
      client.setStdioSource(undefined);
    }),
  );

  const LOCAL_ENGINE_OFFER_DISMISSED = 'localEngineOfferDismissed';
  const offerLocalEngine = async (): Promise<void> => {
    if (context.globalState.get<boolean>(LOCAL_ENGINE_OFFER_DISMISSED) || config().mode === 'local') {
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `TLC: no completion server is reachable at ${config().baseUrl}. `
      + 'Set up the built-in local engine (downloads llama.cpp and a Qwen2.5-Coder model)?',
      'Set Up Local Engine',
      'Not Now',
      "Don't Ask Again",
    );
    if (choice === 'Set Up Local Engine') {
      await vscode.workspace.getConfiguration('tlc').update('mode', 'local', vscode.ConfigurationTarget.Global);
    } else if (choice === "Don't Ask Again") {
      await context.globalState.update(LOCAL_ENGINE_OFFER_DISMISSED, true);
    }
  };

  const LOCAL_ENGINE_RECO_DISMISSED = 'localEngineRecommendationDismissed';
  const settingChosen = (key: string): boolean => {
    const inspect = vscode.workspace.getConfiguration('tlc').inspect(key);
    return [inspect?.globalValue, inspect?.workspaceValue, inspect?.workspaceFolderValue, inspect?.defaultLanguageValue].some((v) => v !== undefined) === true;
  };
  const deviceChosen = (): boolean => settingChosen('local.device');
  const kindChosen = (): boolean => settingChosen('local.engineKind');
  const offerRecommendedLocalEngine = async (): Promise<void> => {
    const dismissed = context.globalState.get<boolean>(LOCAL_ENGINE_RECO_DISMISSED) === true;
    const rec = await probeCapability({ platform: process.platform, arch: process.arch });
    if (rec.kind === 'local') {
      info(`TLC local engine recommendation: ${rec.engineKind} (${rec.device}). ${rec.reason}.`);
      if (dismissed) {
        return;
      }
      if (kindChosen()) {
        return;
      }
      const current = config();
      if (deviceChosen() && current.localDevice === rec.device && current.localEngineKind === rec.engineKind) {
        return;
      }
      const header = deviceChosen()
        ? `TLC: recommended local engine`
        : 'TLC: no local engine selected — the best match';
      const choice = await vscode.window.showInformationMessage(
        `${header} — ${rec.engineKind} (${rec.device === 'auto' ? 'auto device' : `${rec.device.toUpperCase()} device`}). ${rec.reason}`,
        'Apply Recommendation',
        "Don't Ask Again",
      );
      if (choice === 'Apply Recommendation') {
        await vscode.workspace.getConfiguration('tlc').update('local.engineKind', rec.engineKind, vscode.ConfigurationTarget.Global);
        await vscode.workspace.getConfiguration('tlc').update('local.device', rec.device, vscode.ConfigurationTarget.Global);
      } else if (choice === "Don't Ask Again") {
        await context.globalState.update(LOCAL_ENGINE_RECO_DISMISSED, true);
      }
    } else {
      info(`TLC local engine recommendation: remote API. ${rec.reason}.`);
      if (dismissed || deviceChosen()) {
        return;
      }
      const choice = await vscode.window.showInformationMessage(
        `TLC: no local engine is selected and no local acceleration is available on this platform (${rec.reason}); the remote API will be used.`,
        "Don't Ask Again",
      );
      if (choice === "Don't Ask Again") {
        await context.globalState.update(LOCAL_ENGINE_RECO_DISMISSED, true);
      }
    }
  };

  // A stale local.model value (renamed catalog ids, hand-edited settings)
  // would fail the engine start; reset it to the default once, with a notice.
  const normalizeLocalModelSetting = async (): Promise<void> => {
    const c = vscode.workspace.getConfiguration('tlc');
    const stored = c.get<string>('local.model', '');
    if (stored === 'custom' && c.get<string>('local.customModelPath', '').length === 0) {
      await c.update('local.model', DEFAULT_LOCAL_MODEL, vscode.ConfigurationTarget.Global);
      warn('TLC local engine: model "custom" has no tlc.local.customModelPath — reset to the default model.');
    } else if (stored.length > 0 && stored !== 'custom' && !isLocalModelId(stored)) {
      await c.update('local.model', undefined, vscode.ConfigurationTarget.Global);
      warn(`TLC local engine: model "${stored}" is not a catalog entry — reset to the default (${DEFAULT_LOCAL_MODEL}).`);
      void vscode.window.showWarningMessage(`TLC: local model "${stored}" is unknown — reset to ${DEFAULT_LOCAL_MODEL}.`);
    }
  };

  void (async () => {
    await normalizeLocalModelSetting();
    await syncApiKey();
    await syncEngineDirectories();
    if (config().mode === 'local') {
      // Block completions before the engine-status handler runs: between
      // activation and applyMode there is a window where the placeholder
      // endpoint would leak requests (and a 401 from the OpenAI SDK's default
      // host). handleEngineStatus(ready) lifts the block.
      complectionState.setConnectionBlocked(true);
      statusBar.setConnectionReason('starting…');
      await offerRecommendedLocalEngine();
      void applyMode();
      return;
    }
    try {
      await checkServerModels();
    } catch {
      // Server not reachable at startup: keep the configured model and offer
      // the built-in engine instead of failing silently.
      void offerLocalEngine();
    }

    const selected = config().promptTemplate;
    const usable =
      selected === 'custom'
        ? config().customTemplate !== undefined
        : selected !== undefined && templates.registry.resolve(selected).found;
    if (usable) {
      await cleanupTemplateFields(selected);
      return;
    }

    const suggestion = pickTemplateForModel(config().model);
    if (suggestion !== undefined) {
      await applyTemplateSuggestion(config().model);
      await cleanupTemplateFields(suggestion);
      return;
    }

    warn(`Unknown prompt template "${selected ?? 'default'}" and no template matches model "${config().model}".`);
    const choice = await vscode.window.showWarningMessage(
      `TLC: prompt template "${selected ?? 'default'}" is not recognized and no template matches model "${config().model}". Please pick a template.`,
      'Open Settings',
    );
    if (choice === 'Open Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:m4gshm.tlc promptTemplate');
    }
  })();
}

export function deactivate(): void {}