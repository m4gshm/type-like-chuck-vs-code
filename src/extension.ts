import * as vscode from 'vscode';
import { readConfig, ExtensionConfig } from './config';
import { ApiKeyStorage } from './api_key_storage';
import { CompletionsClient, ModelInfo } from './completions_client';
import { CompletionProvider } from './completion_provider';
import { CompletionState } from './completion_state';
import { ForbiddenFiles } from './forbidden_files';
import { ModelConfig } from './model_config';
import { StatusBar } from './status_bar';
import { ConnectionWatchdog } from './connection_watchdog';
import { buildTemplateRegistry, ResolvedTemplates } from './templates';
import { pickTemplateForModel } from './model_selection';
import { MODEL_POLL_INTERVAL_MS, modelIdsKey } from './model_polling';
import { copilotActive, CopilotEnableSetting } from './copilot_gate';
import { DISTRO_CHOICE_DOWNLOAD, EngineManager, ENGINE_STATUS } from './local_engine/engine_manager';
import { DEFAULT_LOCAL_MODEL } from './local_engine/model_catalog';
import { effectiveLocalModel, localModelDisplayName, localModelSpec } from './local_engine/model_picker';
import { migrateDirectory, resolveEnginePaths } from './local_engine/paths';
import { bundledMlxRunnerPath, bundledOvgenaiRunnerPath } from './local_engine/bundled_runners';
import { EngineTaskRunner } from './engine_progress';
import { TemplateFieldSync } from './template_fields';
import { LocalModeStatusUi } from './local_mode_status';
import { normalizeLocalModelSetting, offerLocalEngine } from './startup_prompts';
import { BRAND } from './brand';
import { registerTlcCommands, pickLocalModelFromDisk, presentModelQuickPick, TlcCommandDeps } from './commands';

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Type like Chuck', { log: true });
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
      chooseModel: (models) => presentModelQuickPick(commandDeps, models),
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
      `${BRAND}: template "${suggestion}" selected to match model "${modelId}".`,
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
  const engineTasks = new EngineTaskRunner({
    withProgress: (options, task) =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: options.title, cancellable: options.cancellable },
        task,
      ),
    offerRetry: (message, retry) => {
      void vscode.window.showWarningMessage(message, 'Retry').then((choice) => {
        if (choice === 'Retry') {
          retry();
        }
      });
    },
    enginePhaseLabel: () => localEnginePhaseLabel(),
    modelName: () => localModelName(),
  });
  // The picked folder persists as tlc.local.distroDir so later starts skip the question.
  const askDistroOrDownload = async (kind: 'ovgenai' | 'llama.cpp'): Promise<string | typeof DISTRO_CHOICE_DOWNLOAD | undefined> => {
    const kindLabel = kind === 'ovgenai' ? 'OpenVINO GenAI runtime' : 'llama.cpp build';
    const chosen = await vscode.window.showQuickPick(
      [
        { label: '$(cloud-download) Download', detail: `Download the ${kindLabel} archive on demand`, value: DISTRO_CHOICE_DOWNLOAD },
        { label: '$(folder-opened) Use an existing folder…', detail: `Pick an unpacked ${kindLabel} on disk (saved to tlc.local.distroDir)`, value: 'disk' as const },
      ],
      { title: `${BRAND}: Local Engine Runtime`, placeHolder: `Download the ${kindLabel} or use an existing unpacked distribution?` },
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
      title: `${BRAND}: Select Unpacked Engine Distribution`,
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
      ovgenaiRunnerPath: bundledOvgenaiRunnerPath(context.extensionPath),
      mlxRunnerPath: bundledMlxRunnerPath(context.extensionPath),
      apiKeyEnabled: config().localApiKeyEnabled,
    }),
    onStatus: (status) => localModeUi.handle(status),
    onProgress: engineTasks.onDownloadProgress,
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
  const localModeUi = new LocalModeStatusUi({
    statusBar,
    state: complectionState,
    client,
    watchdog: connectionWatchdog,
    stdioRunner: () => engineManager.stdioRunner(),
    engineKind: () => config().localEngineKind,
    modelLabel: () => localModelDisplayName(config().localEngineKind, config().localModel),
    setEndpoint: (url) => {
      localEndpoint = url;
    },
    stage: (label) => {
      engineTasks.stageLabel = label;
    },
    log: { info, warn },
  });
  const localEnginePhaseLabel = (): string => localModeUi.enginePhaseLabel();
  const localModelName = (): string => localModelDisplayName(config().localEngineKind, config().localModel);

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

  const applyMode = async (): Promise<void> => {
    if (config().mode === 'local') {
      localEndpoint = '';
      client.refresh();
      await client.setApiKey(undefined);
      // Make the FIM template follow the selected model (spec-driven for
      // catalog models, name-matched for From-disk), unless custom.
      const hint = localModelHint();
      await applyTemplateSuggestion(hint.modelId, hint.template);
      localModeUi.handle({ status: ENGINE_STATUS.starting });
      await engineTasks.run(`${BRAND}: preparing the local engine`, (signal) => managerEnsureReady(signal));
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
      statusBar.setEngineDetail(undefined);
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
    info(`${BRAND} local engine directories: engine=${paths.engineRoot} models=${paths.modelDir} cache=${paths.modelCacheDir}`);
    // Engine runtime internals (OV GenAI: ~85 chars below engineRoot) must fit
    // the Windows MAX_PATH of 260, including a custom tlc.local.engineDir.
    if (paths.engineRoot.length + 100 > 260) {
      void vscode.window.showWarningMessage(
        `${BRAND}: the engine directory is long (${paths.engineRoot.length} characters); runtime library paths may exceed the Windows 260-character limit and fail to load. Consider a shorter tlc.local.engineDir.`,
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

  /** Behaves like "TLC: Test Connection": probe the server and surface the outcome. */
  const reportServerReachability = async (): Promise<void> => {
    try {
      const models = await checkServerModels();
      const current = config().model;
      const onList = models.some((m) => m.id === current);
      void vscode.window.showInformationMessage(
        `${BRAND}: ${config().baseUrl} is reachable (${models.length} model${models.length === 1 ? '' : 's'}). `
        + (onList ? `Current model: ${current}.` : `Model updated from the server (was "${current}").`),
      );
    } catch (err) {
      const message = `${BRAND}: cannot reach ${config().baseUrl}: ${errMessage(err)}`;
      connectionWatchdog.reportFailure(message);
      void vscode.window.showWarningMessage(message);
    }
  };

  const selector: vscode.DocumentSelector = { pattern: '**' };
  const providerRegistration = vscode.languages.registerInlineCompletionItemProvider(selector, complectionProvider);

  const commandDeps: TlcCommandDeps = {
    extensionPath: context.extensionPath,
    config,
    client,
    modelConfig,
    apiKeyStorage,
    complectionState,
    complectionProvider,
    statusBar,
    connectionWatchdog,
    engineTasks,
    engineManager,
    checkServerModels,
    reportServerReachability,
    setApiKey: (key) => client.setApiKey(key),
    clearCopilotAutoDisabled: () => {
      copilotAutoDisabled = false;
    },
    warn,
  };
  context.subscriptions.push(
    output,
    statusBar,
    providerRegistration,
    ...registerTlcCommands(commandDeps),
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
      warn('GitHub Copilot detected: Type like Chuck completions disabled.');
      void vscode.window.showInformationMessage(
        `${BRAND} completions are disabled because GitHub Copilot is enabled. ${BRAND} re-enables automatically when Copilot turns off.`,
      );
    } else if (!active && copilotAutoDisabled) {
      copilotAutoDisabled = false;
      if (!firstCheck) {
        await complectionState.setEnabled(true);
        statusBar.refresh();
        void vscode.window.showInformationMessage('GitHub Copilot is off: Type like Chuck completions re-enabled.');
      }
    }
  };
  void updateCopilotPause();
  context.subscriptions.push(
    vscode.extensions.onDidChange(() => void updateCopilotPause()),
    vscode.window.onDidChangeActiveTextEditor(() => void updateCopilotPause()),
  );

  const templateSync = new TemplateFieldSync({
    registry: () => templates,
    getSetting: (key) => vscode.workspace.getConfiguration('tlc').get<string>(key),
    clearSetting: (key) => vscode.workspace.getConfiguration('tlc').update(key, undefined, vscode.ConfigurationTarget.Global),
  });

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
      const previous = { ...config() };
      modelConfig.reload();
      if (event.affectsConfiguration('tlc.promptTemplate') && !templateSync.active) {
        const selectedId = vscode.workspace.getConfiguration('tlc').get<string>('promptTemplate');
        if (selectedId !== 'custom') {
          await templateSync.cleanup(selectedId);
        }
      } else if (
        !templateSync.active
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

      const modeChanged = event.affectsConfiguration('tlc.mode') && config().mode !== previous.mode;
      const dirsChanged = config().localEngineDir !== previous.localEngineDir
        || config().localDownloadedModelsDir !== previous.localDownloadedModelsDir
        || config().localModelCacheDir !== previous.localModelCacheDir;
      const localTargetChanged = config().mode === 'local'
        && (effectiveLocalModel(config().localModel, config().localCustomModelPath) !== effectiveLocalModel(previous.localModel, previous.localCustomModelPath)
          || config().localDevice !== previous.localDevice
          || config().localEngineKind !== previous.localEngineKind
          || config().localApiKeyEnabled !== previous.localApiKeyEnabled
          || config().localNpuContextMaxLength !== previous.localNpuContextMaxLength);
      if (dirsChanged) {
        await syncEngineDirectories();
      }
      if (event.affectsConfiguration('tlc.local.model') && config().localModel === 'custom' && config().localCustomModelPath.length === 0) {
        // "custom" is meaningless without a file: ask for one immediately and
        // revert to the previous catalog model when the dialog is canceled.
        const picked = await pickLocalModelFromDisk(config().localEngineKind);        if (picked !== undefined) {
          await vscode.workspace.getConfiguration('tlc').update('local.customModelPath', picked, vscode.ConfigurationTarget.Global);
        } else {
          const revert = previous.localModel.length > 0 && previous.localModel !== 'custom' ? previous.localModel : DEFAULT_LOCAL_MODEL;
          await vscode.workspace.getConfiguration('tlc').update('local.model', revert, vscode.ConfigurationTarget.Global);
          warn(`${BRAND} local engine: model "custom" was canceled — reset to ${revert}.`);
        }
      } else if (modeChanged) {
        await applyMode();
      } else if (localTargetChanged) {
        if (config().mode === 'local') {
          const hint = localModelHint();
          await applyTemplateSuggestion(hint.modelId, hint.template);
        }
        localModeUi.handle({ status: ENGINE_STATUS.starting });
        await engineTasks.run(`${BRAND}: restarting the local engine`, (signal) => managerEnsureReady(signal));
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
        await reportServerReachability();
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
        `Cannot reach the completions API (${config().baseUrl}): ${errMessage(err)}`,
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
  const ask = async (message: string, ...items: string[]): Promise<string | undefined> => vscode.window.showInformationMessage(message, ...items);

  void (async () => {
    await normalizeLocalModelSetting({
      storedModel: vscode.workspace.getConfiguration('tlc').get<string>('local.model', ''),
      customModelPath: vscode.workspace.getConfiguration('tlc').get<string>('local.customModelPath', ''),
      defaultModel: DEFAULT_LOCAL_MODEL,
      updateModel: async (value) => vscode.workspace.getConfiguration('tlc').update('local.model', value, vscode.ConfigurationTarget.Global),
      warn,
      notify: (message) => void vscode.window.showWarningMessage(message),
    });
    await syncApiKey();
    await syncEngineDirectories();
    if (config().mode === 'local') {
      // Block completions before the engine-status handler runs: between
      // activation and applyMode there is a window where the placeholder
      // endpoint would leak requests (and a 401 from the OpenAI SDK's default
      // host). The engine-status ready branch lifts the block.
      complectionState.setConnectionBlocked(true);
      statusBar.setConnectionReason('starting…');
      // Log the effective selection; the actual device (auto resolution and
      // fallbacks) is reported by the ready line once the engine is up.
      info(`${BRAND} local engine: kind=${config().localEngineKind} device=${config().localDevice} model=${config().localModel}.`);
      void applyMode();
      return;
    }
    try {
      await checkServerModels();
    } catch {
      // Server not reachable at startup: keep the configured model and offer
      // the built-in engine instead of failing silently.
      void offerLocalEngine({
        mode: config().mode,
        baseUrl: config().baseUrl,
        dismissed: context.globalState.get<boolean>(LOCAL_ENGINE_OFFER_DISMISSED) === true,
        ask,
        setMode: async (mode) => vscode.workspace.getConfiguration('tlc').update('mode', mode, vscode.ConfigurationTarget.Global),
        dismiss: async () => context.globalState.update(LOCAL_ENGINE_OFFER_DISMISSED, true),
      });
    }

    const selected = config().promptTemplate;
    const usable =
      selected === 'custom'
        ? config().customTemplate !== undefined
        : selected !== undefined && templates.registry.resolve(selected).found;
    if (usable) {
      await templateSync.cleanup(selected);
      return;
    }

    const suggestion = pickTemplateForModel(config().model);
    if (suggestion !== undefined) {
      await applyTemplateSuggestion(config().model);
      await templateSync.cleanup(suggestion);
      return;
    }

    warn(`Unknown prompt template "${selected ?? 'default'}" and no template matches model "${config().model}".`);
    const choice = await vscode.window.showWarningMessage(
      `${BRAND}: prompt template "${selected ?? 'default'}" is not recognized and no template matches model "${config().model}". Please pick a template.`,
      'Open Settings',
    );
    if (choice === 'Open Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:m4gshm.tlc promptTemplate');
    }
  })();
}

export function deactivate(): void {}