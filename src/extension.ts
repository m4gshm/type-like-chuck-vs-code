import * as vscode from 'vscode';
import { readConfig, effectiveContextLengths, ExtensionConfig } from './config';
import { ApiKeyStorage } from './api_key_storage';
import { CompletionsClient, ModelInfo } from './completions_client';
import { CompletionProvider } from './completion_provider';
import { CompletionState } from './completion_state';
import { ForbiddenFiles } from './forbidden_files';
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

  let config: ExtensionConfig = readConfig();
  let templates: ResolvedTemplates = buildTemplateRegistry(config.promptTemplate, config.customTemplate);
  let forbidden = new ForbiddenFiles(config.forbiddenFileNames);

  const apiKeyStorage = new ApiKeyStorage(context.secrets);
  const client = new CompletionsClient(
    () => config.baseUrl,
    () => config.model,
    () => config.maxTokens,
    (message) => console.log(`[TLC:cause] ${message}`),
  );
  void apiKeyStorage.get().then((key) => client.setApiKey(key));

  const state = new CompletionState(context.globalState);
  const status = new StatusBar(state);

  const provider = new CompletionProvider({
    client,
    getConfig: () => config,
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
            : m.id === config.model
              ? '$(check) current'
              : undefined,
        detail: m.contextLength !== undefined ? `context: ${m.contextLength}` : undefined,
        model: m,
      }));
      items.push({
        label: '$(pencil) Enter model id manuallyвЂ¦',
        detail: `Current: ${config.model}`,
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
        value: config.model,
      });
      return manual === undefined ? undefined : { id: manual };
    };

    /** Rewrites prefixContextMaxLength/suffixContextMaxLength so their sum fits
     * tlc.contextMaxLength (proportional, priority to the prefix). */
    const clampContextSettings = async (): Promise<void> => {
      const limit = config.contextMaxLength;
      if (limit <= 0) {
        return;
      }
      const { prefix, suffix } = effectiveContextLengths(config);
      if (prefix === config.prefixMaxLength && suffix === config.suffixMaxLength) {
        return;
      }
      const settings = vscode.workspace.getConfiguration('tlc');
      await settings.update('prefixContextMaxLength', prefix, vscode.ConfigurationTarget.Global);
      await settings.update('suffixContextMaxLength', suffix, vscode.ConfigurationTarget.Global);
      config = readConfig();
      log(`Context budgets clamped to ${prefix} + ${suffix} (limit ${limit}).`);
    };

    /** Persists a model id (and its context length) in settings and refreshes the cached config. */
    const setModel = async (modelId: string, contextLength?: number): Promise<void> => {
      if (modelId.length === 0) {
        return;
      }
      const settings = vscode.workspace.getConfiguration('tlc');
      const modelChanged = modelId !== config.model;
      const contextChanged =
        contextLength !== undefined && contextLength !== config.contextMaxLength;
      if (!modelChanged && !contextChanged) {
        return;
      }
      if (modelChanged) {
        await settings.update('model', modelId, vscode.ConfigurationTarget.Global);
      }
      if (contextChanged) {
        await settings.update('contextMaxLength', contextLength, vscode.ConfigurationTarget.Global);
        log(`Context limit for "${modelId}" set to ${contextLength}.`);
      }
      config = readConfig();
      if (modelChanged) {
        void vscode.window.showInformationMessage(`TLC model set to ${modelId}.`);
      }
      await clampContextSettings();
    };

    /**
     * Resolves the model against a freshly fetched /v1/models list:
     * - a single model is applied automatically;
     * - with multiple models, the picker is shown only when the configured
     *   model is not on the list (the user's manual choice always wins);
     * - an empty list is logged and ignored.
     * Every application also refreshes tlc.contextMaxLength from the model
     * metadata reported by the server.
     */
    const applyModelList = async (models: ModelInfo[]): Promise<void> => {
      // Re-clamp even when the model is unchanged (e.g. the limit was set
      // earlier but the budgets were not rewritten yet).
      await clampContextSettings();
      if (models.length === 0) {
        log(`Model list from ${config.baseUrl} is empty; keeping "${config.model}".`);
        return;
      }
      if (models.length === 1) {
        if (models[0].id !== config.model || models[0].contextLength !== config.contextMaxLength) {
          await setModel(models[0].id, models[0].contextLength);
        }
        return;
      }
      const current = models.find((m) => m.id === config.model);
      if (current !== undefined) {
        // The user's manual choice wins; still refresh the context limit.
        await setModel(current.id, current.contextLength);
        return;
      }
      log(`"${config.model}" is not in the model list of ${config.baseUrl}; showing the picker.`);
      const chosen = await presentModelQuickPick(models);
      if (chosen !== undefined) {
        await setModel(chosen.id, chosen.contextLength);
      }
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
        log(`Cannot list models from ${config.baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
        void vscode.window.showWarningMessage(
          `Cannot fetch the model list from ${config.baseUrl}. You can still enter the model id manually.`,
        );
      }

      const chosen = await presentModelQuickPick(models);
      if (chosen !== undefined) {
        await setModel(chosen.id, chosen.contextLength);
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

  /** Removes marker/stop settings entries that just duplicate a built-in template. */
  const cleanupTemplateFields = async (selectedId: string | undefined): Promise<void> => {
    if (selectedId === undefined || selectedId === 'custom') {
      return;
    }
    const { template } = templates.registry.resolve(selectedId);
    if (!template || template.id !== selectedId) {
      return;
    }
    const cfg = vscode.workspace.getConfiguration('tlc');
    const stored: Array<[string, string]> = [
      ['prefix', template.markers.prefix],
      ['suffix', template.markers.suffix],
      ['middle', template.markers.middle],
      ['stop', template.reservedTokens.join(',')],
    ];
    syncingTemplateFields = true;
    try {
      for (const [key, builtinValue] of stored) {
        if (cfg.get<string>(key) === builtinValue) {
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
      if (event.affectsConfiguration('tlc.promptTemplate') && !syncingTemplateFields) {
        const selectedId = vscode.workspace.getConfiguration('tlc').get<string>('promptTemplate');
        if (selectedId !== 'custom') {
          await cleanupTemplateFields(selectedId);
        }
      } else if (
        !syncingTemplateFields
        && ['prefix', 'suffix', 'middle', 'stop'].some((s) => event.affectsConfiguration(`tlc.${s}`))
      ) {
        if (config.promptTemplate !== 'custom') {
          await vscode.workspace.getConfiguration('tlc').update('promptTemplate', 'custom', vscode.ConfigurationTarget.Global);
        }
      }

      const baseUrlChanged = event.affectsConfiguration('tlc.baseUrl');

      config = readConfig();
      // The SDK captures baseURL at construction time, so refresh on any
      // settings change to pick up a new tlc.baseUrl.
      client.refresh();
      templates = buildTemplateRegistry(config.promptTemplate, config.customTemplate);
      forbidden = new ForbiddenFiles(config.forbiddenFileNames);
      for (const warning of templates.warnings) {
        log(warning);
      }

      // When the server URL changes, resolve the model against its list:
      // one model is applied automatically, several show the picker when the
      // configured model is not on the list.
      if (baseUrlChanged) {
        try {
          await applyModelList(await client.listModels());
        } catch (err) {
          log(`Cannot list models from ${config.baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }),
  );

  // On startup: validate the configured model against the server's list,
  // then validate the selected template.
  void (async () => {
    await client.setApiKey(await apiKeyStorage.get());
    try {
      await applyModelList(await client.listModels());
    } catch {
      // Server not reachable at startup: keep the configured model silently.
    }

    // Template validation: a known built-in or a usable custom template is
    // fine; otherwise suggest a template matching the model name, and if that
    // fails too, warn with a shortcut to the settings editor.
    const selected = config.promptTemplate;
    const usable =
      selected === 'custom'
        ? config.customTemplate !== undefined
        : selected !== undefined && templates.registry.resolve(selected).found;
    if (usable) {
      await cleanupTemplateFields(selected);
      return;
    }

    const suggestion = pickTemplateForModel(config.model);
    if (suggestion !== undefined) {
      await vscode.workspace.getConfiguration('tlc').update('promptTemplate', suggestion, vscode.ConfigurationTarget.Global);
      config = readConfig();
      templates = buildTemplateRegistry(config.promptTemplate, config.customTemplate);
      await cleanupTemplateFields(suggestion);
      void vscode.window.showInformationMessage(
        `TLC: template "${suggestion}" selected to match model "${config.model}".`,
      );
      return;
    }

    log(`Unknown prompt template "${selected ?? 'default'}" and no template matches model "${config.model}".`);
    const choice = await vscode.window.showWarningMessage(
      `TLC: prompt template "${selected ?? 'default'}" is not recognized and no template matches model "${config.model}". Please pick a template.`,
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
