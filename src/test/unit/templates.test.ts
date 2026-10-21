import { describe, expect, it } from 'vitest';
import { buildTemplateRegistry } from '../../templates';
import { DEFAULT_TEMPLATE_ID } from '../../templates/builtins';

const CUSTOM = {
  id: 'mine',
  prefix: '[P]',
  suffix: '[S]',
  middle: '[M]',
  stop: ['[E]'],
};

describe('template registry', () => {
  it('registers and looks up built-in templates', () => {
    const { registry, warnings } = buildTemplateRegistry('qwen3', undefined);
    expect(warnings).toHaveLength(0);
    const { template, found } = registry.resolve('qwen3');
    expect(found).toBe(true);
    expect(template.id).toBe('qwen3');
  });

  it('renders qwen2 prompts with FIM markers', () => {
    const { registry } = buildTemplateRegistry('qwen2', undefined);
    const { template } = registry.resolve('qwen2');
    expect(template.render('fn a() {', '}')).toBe('<|fim_prefix|>fn a() {<|fim_suffix|>}<|fim_middle|>');
  });

  it('renders qwen3, lfm2 and mellum prompts with family-specific markers', () => {
    const cases: Array<[string, string, string]> = [
      ['qwen3', '<|fim_prefix|>pre', 'suf<|fim_middle|>'],
      ['lfm2', '<|fim_pre|>pre', 'suf<|fim_mid|>'],
      ['mellum', '<fim_prefix>pre', 'suf<fim_middle>'],
    ];
    for (const [id, expectedStart, expectedEnd] of cases) {
      const { registry, warnings } = buildTemplateRegistry(id, undefined);
      expect(warnings).toHaveLength(0);
      const { template, found } = registry.resolve(id);
      expect(found).toBe(true);
      const prompt = template.render('pre', 'suf');
      expect(prompt.startsWith(expectedStart)).toBe(true);
      expect(prompt.endsWith(expectedEnd)).toBe(true);
      expect(template.reservedTokens.length).toBeGreaterThan(0);
    }
  });

  it('compiles the custom template from settings fields', () => {
    const { registry, warnings } = buildTemplateRegistry('custom', CUSTOM);
    expect(warnings).toHaveLength(0);
    const { template, found } = registry.resolve('custom');
    expect(found).toBe(true);
    expect(template.render('a', 'b')).toBe('[P]a[S]b[M]');
    expect(template.reservedTokens).toEqual(['[E]']);
    expect(template.markers).toEqual({ prefix: '[P]', suffix: '[S]', middle: '[M]' });
    expect(registry.resolve('mine').found).toBe(true);
  });

  it('falls back to the default template on unknown id with a warning', () => {
    const { registry, warnings } = buildTemplateRegistry('no-such-template', undefined);
    expect(warnings).toHaveLength(1);
    const { template, found } = registry.resolve('no-such-template');
    expect(found).toBe(false);
    expect(template.id).toBe(DEFAULT_TEMPLATE_ID);
  });

  it('falls back to the default when promptTemplate is custom without usable fields', () => {
    const { registry, warnings } = buildTemplateRegistry('custom', undefined);
    expect(warnings).toHaveLength(1);
    const { template, found } = registry.resolve('custom');
    expect(found).toBe(false);
    expect(template.id).toBe(DEFAULT_TEMPLATE_ID);
  });

  it('rejects invalid custom templates with a warning', () => {
    const { registry, warnings } = buildTemplateRegistry('custom', {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      id: 'no-middle', prefix: '[P]', suffix: '[S]', middle: undefined as any,
    });
    expect(warnings).toHaveLength(1);
    expect(registry.resolve('custom').template.id).toBe(DEFAULT_TEMPLATE_ID);
  });
});
