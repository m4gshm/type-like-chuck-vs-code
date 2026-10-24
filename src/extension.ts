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
import { pickSupportedModel, pickTemplateForModel } from './model_selection';
import { MODEL_POLL_INTERVAL_MS, modelIdsKey } from './model_polling';

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
        await vscode.workspace.getConfiguration('tlc').update(key, value, vscode.ConfigurationTarget.Global);
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
   */
  const applyTemplateSuggestion = async (modelId: string): Promise<void> => {
    const selected = config().promptTemplate;
    if (selected === 'custom') {
      return;
    }
    const suggestion = pickTemplateForModel(modelId);
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
  const client = new CompletionsClient(
    () => config().baseUrl,
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
      if (!complectionState.isEnabled()) {
        return;
      }
      complectionProvider.resetThrottle();
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
          'TLC: tlc.apiKey is set in the settings and takes precedence over the secret-stored key.',
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
  const syncApiKey = async (): Promise<void> => {
    await client.setApiKey(await effectiveApiKey());
  };

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
      if (!event.affectsConfiguration('tlc')) {
        return;
      }
      // Refresh the cached config first: everything below (including
      // client.refresh()) derives from the new settings.
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

      // The SDK captures baseURL at construction time.
      const baseUrlChanged = event.affectsConfiguration('tlc.baseUrl');
      if (baseUrlChanged) {
        client.refresh();
      }
      if (event.affectsConfiguration('tlc.apiKey')) {
        await syncApiKey();
      }

      templates = buildTemplateRegistry(config().promptTemplate, config().customTemplate);
      forbidden = new ForbiddenFiles(config().forbiddenFileNames);
      for (const warning of templates.warnings) {
        warn(warning);
      }

      // Resolve the model against the new server's list. Editing the setting
      // commits on Enter/blur: behave like "TLC: Test Connection" and surface
      // the outcome to the user.
      if (baseUrlChanged) {
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
    void checkServerModels().catch((err: unknown) => {
      connectionWatchdog.reportFailure(
        `Cannot reach the completions API (${config().baseUrl}): ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, MODEL_POLL_INTERVAL_MS);
  pollTimer.unref?.();
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(pollTimer)));

  void (async () => {
    await syncApiKey();
    try {
      await checkServerModels();
    } catch {
      // Server not reachable at startup: keep the configured model silently.
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

export function deactivate(): void {
  // Nothing to clean up: all disposables are registered on the context.
}
