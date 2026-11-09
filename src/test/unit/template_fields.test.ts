import { describe, expect, it } from 'vitest';
import { TemplateFieldSync } from '../../template_fields';
import { buildTemplateRegistry } from '../../templates';

const qwen2Stop = buildTemplateRegistry('qwen2', undefined).registry.resolve('qwen2').template.reservedTokens.join(',');

const makeSync = (stored: Record<string, string | undefined>) => {
  const cleared: string[] = [];
  const sync = new TemplateFieldSync({
    registry: () => buildTemplateRegistry('qwen2', undefined),
    getSetting: (key) => stored[key],
    clearSetting: async (key) => {
      cleared.push(key);
      stored[key] = undefined;
    },
  });
  return { sync, cleared, stored };
};

describe('TemplateFieldSync', () => {
  it('clears only the marker fields still holding the built-in values', async () => {
    const { sync, cleared } = makeSync({
      prefix: '<|fim_prefix|>',
      suffix: '<|fim_suffix|>',
      middle: '<|fim_middle|>',
      stop: qwen2Stop,
    });
    await sync.cleanup('qwen2');
    expect(cleared.sort()).toEqual(['middle', 'prefix', 'stop', 'suffix']);
    expect(sync.active).toBe(false);
  });

  it('keeps user-customized values and ignores custom/unknown selections', async () => {
    const { sync, cleared } = makeSync({ prefix: '[MY]' });
    await sync.cleanup('qwen2');
    await sync.cleanup('custom');
    await sync.cleanup(undefined);
    expect(cleared).toEqual([]);
  });
});
