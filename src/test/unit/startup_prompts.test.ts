import { describe, expect, it, vi } from 'vitest';
import { normalizeLocalModelSetting, offerLocalEngine } from '../../startup_prompts';

const askQueue = (answers: string[]) => {
  const asked: string[] = [];
  const ask = vi.fn(async (_message: string, ..._items: string[]) => answers.shift());
  return { ask, asked: () => asked };
};

describe('offerLocalEngine', () => {
  it('does nothing when dismissed or already local', async () => {
    const { ask } = askQueue([]);
    await offerLocalEngine({ mode: 'remote', baseUrl: 'http://x/v1', dismissed: true, ask, setMode: async () => undefined, dismiss: async () => undefined });
    await offerLocalEngine({ mode: 'local', baseUrl: 'http://x/v1', dismissed: false, ask, setMode: async () => undefined, dismiss: async () => undefined });
    expect(ask).not.toHaveBeenCalled();
  });

  it('switches to local mode on accept and persists dismissal on opt-out', async () => {
    const { ask } = askQueue(['Set Up Local Engine', "Don't Ask Again"]);
    const modes: string[] = [];
    let dismissed = false;
    await offerLocalEngine({ mode: 'remote', baseUrl: 'http://x/v1', dismissed: false, ask, setMode: async (m) => { modes.push(m); }, dismiss: async () => { dismissed = true; } });
    expect(modes).toEqual(['local']);
    await offerLocalEngine({ mode: 'remote', baseUrl: 'http://x/v1', dismissed: false, ask, setMode: async () => undefined, dismiss: async () => { dismissed = true; } });
    expect(dismissed).toBe(true);
  });
});

describe('normalizeLocalModelSetting', () => {
  it('resets "custom" without a path to the default model', async () => {
    const updates: Array<string | undefined> = [];
    const warnings: string[] = [];
    await normalizeLocalModelSetting({
      storedModel: 'custom', customModelPath: '', defaultModel: 'Qwen2.5-Coder 1.5B',
      updateModel: async (v) => { updates.push(v); }, warn: (m) => warnings.push(m), notify: () => undefined,
    });
    expect(updates).toEqual(['Qwen2.5-Coder 1.5B']);
    expect(warnings).toHaveLength(1);
  });

  it('clears an unknown catalog id with a notice', async () => {
    const updates: Array<string | undefined> = [];
    const notified: string[] = [];
    await normalizeLocalModelSetting({
      storedModel: 'qwen2.5-obsolete', customModelPath: '', defaultModel: 'Qwen2.5-Coder 1.5B',
      updateModel: async (v) => { updates.push(v); }, warn: () => undefined, notify: (m) => notified.push(m),
    });
    expect(updates).toEqual([undefined]);
    expect(notified).toHaveLength(1);
  });

  it('leaves valid settings alone', async () => {
    const updateModel = vi.fn(async () => undefined);
    await normalizeLocalModelSetting({
      storedModel: 'Qwen2.5-Coder 1.5B', customModelPath: '', defaultModel: 'Qwen2.5-Coder 1.5B',
      updateModel, warn: () => undefined, notify: () => undefined,
    });
    await normalizeLocalModelSetting({
      storedModel: 'custom', customModelPath: 'C:/m.gguf', defaultModel: 'Qwen2.5-Coder 1.5B',
      updateModel, warn: () => undefined, notify: () => undefined,
    });
    expect(updateModel).not.toHaveBeenCalled();
  });
});
