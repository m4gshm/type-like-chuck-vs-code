/**
 * Model ids are matched against these ordered substrings (case-insensitive);
 * the first supported model found on the server becomes the default pick in
 * the model selector. FIM templates exist for each supported family.
 */
const SUPPORTED_PATTERNS: readonly string[] = [
  'qwen2.5-coder',
  'qwen2-coder',
  'qwen3-coder',
  'mellum',
  'lfm2',
  'qwen2.5',
  'qwen3',
  'qwen2',
  'qwen',
];

export function pickSupportedModel(models: readonly string[]): string | undefined {
  for (const pattern of SUPPORTED_PATTERNS) {
    const match = models.find((id) => id.toLowerCase().includes(pattern));
    if (match !== undefined) {
      return match;
    }
  }
  return undefined;
}

/**
 * Suggests a built-in template id for a model name (partial match):
 * qwen3 → qwen3, other qwen → qwen2, mellum → mellum, lfm → lfm2.
 */
export function pickTemplateForModel(model: string): string | undefined {
  const m = model.toLowerCase();
  if (m.includes('mellum')) {
    return 'mellum';
  }
  if (m.includes('lfm')) {
    return 'lfm2';
  }
  if (m.includes('qwen3')) {
    return 'qwen3';
  }
  if (m.includes('qwen')) {
    return 'qwen2';
  }
  return undefined;
}
