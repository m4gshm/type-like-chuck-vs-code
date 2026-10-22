import * as vscode from 'vscode';
import { readConfig, ExtensionConfig } from './config';
import { ApiKeyStorage } from './api_key_storage';
import { CompletionsClient, ModelInfo } from './completions_client';
import { CompletionProvider } from './completion_provider';
import { CompletionState } from './completion_state';
import { ForbiddenFiles } from './forbidden_files';
import { ModelConfig } from './model_config';
import { StatusBar } from './status_bar';
import { buildTemplateRegistry, ResolvedTemplates } from './templates';
import { pickSupportedModel, pickTemplateForModel } from './model_selection';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('TLC', { log: true });
  const log = (message: string): void => {
    output.warn(message);
    console.log(`[TLC:warn] ${message}`);
  };
  const trace = (message: string): void => {
    output.debug(message);
    console.log(`[TLC] ${message}`);
  };

  let templates: ResolvedTemplates;
  let forbidden: ForbiddenFiles;
  const modelConfig = new ModelConfig(
    {
      readConfig: readConfig,
      updateSetting: async (key, value) => {
        await vscode.workspace.getConfiguration('tlc').update(key, value, vscode.ConfigurationTarget.Global);
      },
      log,
      notify: (message) => void vscode.window.showInformationMessage(message),
      chooseModel: (models) => presentModelQuickPick(models),
    },
    readConfig(),
  );
  const config = (): ExtensionConfig => modelConfig.current;
  templates = buildTemplateRegistry(config().promptTemplate, config().customTemplate);
  forbidden = new ForbiddenFiles(config().forbiddenFileNames);

  const apiKeyStorage = new ApiKeyStorage(context.secrets);
  const client = new CompletionsClient(
    () => config().baseUrl,
    () => config().model,
    () => config().maxTokens,
    (message) => console.log(`[TLC:cause] ${message}`),
  );

  const state = new CompletionState(context.globalState);
  const status = new StatusBar(state);

  const provider = new CompletionProvider({
    client,
    getConfig: config,
    resolveTemplates: () => templates,
    forbidden: () => forbidden,
    state,
    status,
    log,
    trace,
  });

  const selector: vscode.DocumentSelector = { pattern: '**' };
  const providerRegistration = vscode.languages.registerInlineCompletionItemProvider(selector, provider);

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
    status,
    providerRegistration,
    vscode.commands.registerCommand('tlc.triggerCompletion', () => {
      if (!state.isEnabled()) {
        return;
      }
      provider.resetThrottle();
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
      await client.setApiKey(key.length === 0 ? undefined : key);
      void vscode.window.showInformationMessage('TLC API key updated.');
    }),
    vscode.commands.registerCommand('tlc.clearApiKey', async () => {
      await apiKeyStorage.clear();
      await client.setApiKey(undefined);
      void vscode.window.showInformationMessage('TLC API key cleared.');
    }),
    vscode.commands.registerCommand('tlc.selectModel', async () => {
      let models: ModelInfo[] = [];
      try {
        models = await client.listModels();
      } catch (err) {
        log(`Cannot list models from ${config().baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
        void vscode.window.showWarningMessage(
          `Cannot fetch the model list from ${config().baseUrl}. You can still enter the model id manually.`,
        );
      }

      const chosen = await presentModelQuickPick(models);
      if (chosen !== undefined) {
        await modelConfig.setModel(chosen.id, chosen.contextLength);
      }
    }),
    vscode.commands.registerCommand('tlc.toggleCompletions', async () => {
      const enabled = !state.isEnabled();
      await state.setEnabled(enabled);
      if (!enabled) {
        provider.onDisabled();
      }
      status.refresh();
      void vscode.window.showInformationMessage(enabled ? 'TLC completions enabled.' : 'TLC completions disabled.');
    }),
  );

  // Cancel in-flight requests when the cursor jumps away (line change, click, Esc).
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.kind === vscode.TextEditorSelectionChangeKind.Mouse
        || event.kind === vscode.TextEditorSelectionChangeKind.Command) {
        provider.cancelActiveRequests();
        return;
      }
      const positions = event.selections.map((s) => s.active);
      if (positions.length !== 1) {
        provider.cancelActiveRequests();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => provider.cancelActiveRequests()),
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

      templates = buildTemplateRegistry(config().promptTemplate, config().customTemplate);
      forbidden = new ForbiddenFiles(config().forbiddenFileNames);
      for (const warning of templates.warnings) {
        log(warning);
      }

      // Resolve the model against the new server's list.
      if (baseUrlChanged) {
        try {
          await modelConfig.applyModelList(await client.listModels());
        } catch (err) {
          log(`Cannot list models from ${config().baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }),
  );

  // On startup: validate the configured model against the server's list,
  // then validate the selected template.
  void (async () => {
    await client.setApiKey(await apiKeyStorage.get());
    try {
      await modelConfig.applyModelList(await client.listModels());
    } catch {
      // Server not reachable at startup: keep the configured model silently.
    }

    // Template validation: fall back to a template matching the model name,
    // then to a warning with a shortcut to the settings editor.
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
      await vscode.workspace.getConfiguration('tlc').update('promptTemplate', suggestion, vscode.ConfigurationTarget.Global);
      templates = buildTemplateRegistry(suggestion, config().customTemplate);
      await cleanupTemplateFields(suggestion);
      void vscode.window.showInformationMessage(
        `TLC: template "${suggestion}" selected to match model "${config().model}".`,
      );
      return;
    }

    log(`Unknown prompt template "${selected ?? 'default'}" and no template matches model "${config().model}".`);
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
