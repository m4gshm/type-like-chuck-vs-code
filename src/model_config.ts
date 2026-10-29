import { ExtensionConfig } from './config';
import { ModelInfo } from './completions_client';

export interface ModelConfigHost {
  readConfig(): ExtensionConfig;
  updateSetting(key: string, value: unknown): Promise<void>;
  warn(message: string): void;
  info(message: string): void;
  notify(message: string): void;
  /** Asks the user to pick a model; undefined = cancelled. */
  chooseModel(models: ModelInfo[]): Promise<{ id: string; contextLength?: number } | undefined>;
  onModelChanged?(modelId: string): Promise<void> | void;
}

/**
 * Owns the model-related settings (tlc.model, tlc.contextMaxLength,
 * prefix/suffix budgets): applies the server's /v1/models list, keeps the
 * context limit in sync with the model metadata and rewrites the budgets so
 * their sum fits the limit.
 */
export class ModelConfig {
  constructor(
    private readonly host: ModelConfigHost,
    private config: ExtensionConfig,
  ) {}

  get current(): ExtensionConfig {
    return this.config;
  }

  /** Re-reads the configuration; must be called after any tlc settings change. */
  reload(): void {
    this.config = this.host.readConfig();
  }

  /**
   * Persists a model id and its context length. A model without metadata
   * resets the context limit to "unlimited".
   */
  async setModel(modelId: string, contextLength?: number): Promise<void> {
    if (modelId.length === 0) {
      return;
    }
    const settings = this.host.updateSetting;
    const modelChanged = modelId !== this.config.model;
    const limitChanged =
      contextLength !== undefined && contextLength !== this.config.contextMaxLength;
    // A model without metadata resets the limit even when the id is unchanged:
    // the previous limit may come from another server.
    const limitReset = contextLength === undefined && this.config.contextMaxLength !== 0;
    if (!modelChanged && !limitChanged && !limitReset) {
      return;
    }
    if (modelChanged) {
      await settings('model', modelId);
    }
    if (limitChanged || limitReset) {
      await settings('contextMaxLength', contextLength ?? 0);
      this.host.info(contextLength !== undefined
          ? `Context limit for "${modelId}" set to ${contextLength}.`
          : `Context limit reset to unlimited (no metadata for "${modelId}").` );
    }
    this.reload();
    if (modelChanged) {
      await this.host.onModelChanged?.(modelId);
      this.host.notify(`TLC model set to ${modelId}.`);
    }
  }

  /**
   * Resolves the model against a freshly fetched /v1/models list:
   * - a single model is applied automatically;
   * - with multiple models, the picker is shown only when the configured
   *   model is not on the list (the user's manual choice always wins);
   * - an empty list is logged and ignored.
   * Every application also refreshes tlc.contextMaxLength from the model
   * metadata reported by the server.
   */
  async applyModelList(models: ModelInfo[]): Promise<void> {
    if (models.length === 0) {
      this.host.warn(`Model list is empty; keeping "${this.config.model}".`);
      return;
    }
    if (models.length === 1) {
      const only = models[0];
      if (only.id !== this.config.model || only.contextLength !== this.config.contextMaxLength) {
        await this.setModel(only.id, only.contextLength);
      }
      return;
    }
    const current = models.find((m) => m.id === this.config.model);
    if (current !== undefined) {
      await this.setModel(current.id, current.contextLength);
      return;
    }
    this.host.warn(`"${this.config.model}" is not in the model list; showing the picker.`);
    const chosen = await this.host.chooseModel(models);
    if (chosen !== undefined) {
      await this.setModel(chosen.id, chosen.contextLength);
    }
  }
}
