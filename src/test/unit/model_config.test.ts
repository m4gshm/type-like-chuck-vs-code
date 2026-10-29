import { describe, expect, it } from 'vitest';
import { ModelConfig, ModelConfigHost } from '../../model_config';
import { ExtensionConfig } from '../../config';
import { ModelInfo } from '../../completions_client';

function mkConfig(overrides: Partial<ExtensionConfig> = {}): ExtensionConfig {
  return {
    baseUrl: 'http://stub/v1',
    model: 'qwen2.5-coder-1.5b',
    apiKey: '',
    mode: 'remote',
    localModel: '1.5b',
    localDevice: 'cpu',
    localNpuContextMaxLength: 8192,
    localLlamaCppRelease: 'b11935',
    localEngineDir: '',
    localEngineBinary: '',
    localModelDir: '',
    localModelCacheDir: '',
    localHuggingfaceUrl: 'https://huggingface.co',
    localGithubUrl: 'https://github.com',
    localModelPath: '',
    localModelUrls: {},
    localApiKeyEnabled: true,
    promptTemplate: 'qwen2',
    customTemplate: undefined,
    prefixMaxLength: 8000,
    suffixMaxLength: 2000,
    contextMaxLength: 0,
    maxTokens: 256,
    debounceMs: 250,
    pendingGraceMs: 150,
    autoTrigger: true,
    cacheEnabled: true,
    cacheTtlMs: 10_000,
    yieldToCopilot: true,
    forbiddenFileNames: [],
    ...overrides,
  };
}

interface Setup {
  modelConfig: ModelConfig;
  updates: Array<{ key: string; value: unknown }>;
  config: ExtensionConfig;
  pickerShown: () => number;
  logs: string[];
}

function setup(initial: ExtensionConfig): Setup {
  const config = initial;
  const updates: Array<{ key: string; value: unknown }> = [];
  let pickerCalls = 0;
  const logs: string[] = [];
  const host: ModelConfigHost = {
    readConfig: () => config,
    updateSetting: async (key, value) => {
      updates.push({ key, value });
      // Simulate VS Code applying the setting and notifying readers (settings
      // keys map to the config field names).
      const field = key === 'prefixContextMaxLength' ? 'prefixMaxLength'
        : key === 'suffixContextMaxLength' ? 'suffixMaxLength' : key;
      (config as unknown as Record<string, unknown>)[field] = value;
    },
    warn: (m) => logs.push(m),
    info: () => undefined,
    notify: () => undefined,
    chooseModel: async (models) => {
      pickerCalls += 1;
      return { id: models[0].id, contextLength: models[0].contextLength };
    },
  };
  return { modelConfig: new ModelConfig(host, config), updates, config, pickerShown: () => pickerCalls, logs };
}

describe('ModelConfig.applyModelList', () => {
  it('applies a single model automatically together with its context length', async () => {
    const setup1 = setup(mkConfig({ contextMaxLength: 8192 }));
    await setup1.modelConfig.applyModelList([{ id: 'qwen2.5-coder-1.5b', contextLength: 8192 }]);

    // Model and context unchanged → no settings written back.
    expect(setup1.updates).toHaveLength(0);
    expect(setup1.config.contextMaxLength).toBe(8192);
  });

  it('switches to a single different model', async () => {
    const setup1 = setup(mkConfig());
    await setup1.modelConfig.applyModelList([{ id: 'mellum-base', contextLength: 16384 }]);
    expect(setup1.config.model).toBe('mellum-base');
    expect(setup1.config.contextMaxLength).toBe(16384);
  });

  it('keeps the current model when it is on a multi-model list (manual choice wins)', async () => {
    const setup1 = setup(mkConfig({ model: 'b', contextMaxLength: 8192 }));
    const models: ModelInfo[] = [
      { id: 'a', contextLength: 4096 },
      { id: 'b', contextLength: 4096 },
    ];
    await setup1.modelConfig.applyModelList(models);

    expect(setup1.pickerShown()).toBe(0);
    expect(setup1.config.model).toBe('b');
    // Context limit refreshed from the server metadata for the current model.
    expect(setup1.config.contextMaxLength).toBe(4096);
    expect(setup1.updates.map((u) => u.key)).toContain('contextMaxLength');
  });

  it('shows the picker when the configured model is not on a multi-model list', async () => {
    const setup1 = setup(mkConfig({ model: 'unknown-model' }));
    const models: ModelInfo[] = [
      { id: 'a', contextLength: 4096 },
      { id: 'b', contextLength: 4096 },
    ];
    await setup1.modelConfig.applyModelList(models);

    expect(setup1.pickerShown()).toBe(1);
    expect(setup1.config.model).toBe('a');
  });

  it('keeps everything on an empty model list', async () => {
    const setup1 = setup(mkConfig());
    await setup1.modelConfig.applyModelList([]);
    expect(setup1.updates).toHaveLength(0);
    expect(setup1.logs.some((l) => l.includes('empty'))).toBe(true);
  });
});

describe('ModelConfig.setModel', () => {
  it('resets the context limit when a new model reports no metadata', async () => {
    const setup1 = setup(mkConfig({ contextMaxLength: 8192 }));
    await setup1.modelConfig.setModel('mystery-model');

    expect(setup1.config.contextMaxLength).toBe(0);
    expect(setup1.updates.map((u) => u.key)).toContain('contextMaxLength');
  });

  it('is a no-op when the model and the limit are unchanged', async () => {
    const setup1 = setup(mkConfig({ contextMaxLength: 4096, prefixMaxLength: 3277, suffixMaxLength: 819 }));
    await setup1.modelConfig.setModel('qwen2.5-coder-1.5b', 4096);
    expect(setup1.updates).toHaveLength(0);
  });

  it('resets the context limit when the same model reports no metadata (another server)', async () => {
    const setup1 = setup(mkConfig({ contextMaxLength: 8192 }));
    await setup1.modelConfig.setModel('qwen2.5-coder-1.5b', undefined);
    expect(setup1.config.contextMaxLength).toBe(0);
    expect(setup1.updates.map((u) => u.key)).toContain('contextMaxLength');
  });

  it('ignores empty model ids', async () => {
    const setup1 = setup(mkConfig());
    await setup1.modelConfig.setModel('');
    expect(setup1.updates).toHaveLength(0);
  });

  it('does not rewrite the budgets on model change (they are fitted per request)', async () => {
    const setup1 = setup(mkConfig({ model: 'small' }));
    await setup1.modelConfig.setModel('small', 1000);
    expect(setup1.config.prefixMaxLength).toBe(8000);
    expect(setup1.config.suffixMaxLength).toBe(2000);
    expect(setup1.updates.map((u) => u.key)).toEqual(['contextMaxLength']);
  });

  it('notifies onModelChanged when the model changes and stays silent otherwise', async () => {
    const changes: string[] = [];
    const setup1 = setup(mkConfig({ model: 'qwen2.5-coder-1.5b', contextMaxLength: 4096 }));
    setup1.modelConfig['host'].onModelChanged = (id) => {
      changes.push(id);
    };

    await setup1.modelConfig.setModel('qwen2.5-coder-1.5b', 4096); // unchanged
    expect(changes).toHaveLength(0);

    await setup1.modelConfig.setModel('qwen3-coder-30b', 4096); // new model
    expect(changes).toEqual(['qwen3-coder-30b']);
  });
});
