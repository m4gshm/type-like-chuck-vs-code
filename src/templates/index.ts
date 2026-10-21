import { BUILTIN_TEMPLATES, DEFAULT_TEMPLATE_ID } from './builtins';
import { TemplateRegistry } from './registry';
import { CustomTemplateDefinition, FimTemplate, templateFromDefinition } from './types';

export interface ResolvedTemplates {
  registry: TemplateRegistry;
  /**
   * Warnings produced while compiling the custom template or resolving the
   * selected id (unknown id, invalid definition, duplicate id).
   */
  warnings: string[];
}

/**
 * Builds the template registry: built-ins plus the single user-defined
 * template compiled from the `tlc.prefix / tlc.suffix / tlc.middle / tlc.stop` settings. Selecting `custom` in
 * `tlc.promptTemplate` resolves to that template (or the default when the
 * definition is unusable, reported as a warning).
 */
export function buildTemplateRegistry(
  selectedId: string | undefined,
  customTemplate: CustomTemplateDefinition | undefined,
): ResolvedTemplates {
  const warnings: string[] = [];
  const registry = new TemplateRegistry(
    BUILTIN_TEMPLATES.find((t) => t.id === DEFAULT_TEMPLATE_ID)!,
  );
  for (const t of BUILTIN_TEMPLATES) {
    registry.register(t);
  }

  let custom: FimTemplate | undefined;
  if (customTemplate !== undefined) {
    const compiled = templateFromDefinition(customTemplate);
    if (!compiled) {
      warnings.push(`Ignoring invalid custom FIM template: ${JSON.stringify(customTemplate)}`);
    } else if (BUILTIN_TEMPLATES.some((t) => t.id === compiled.id)) {
      warnings.push(`Custom template name "${compiled.id}" conflicts with a built-in template and was ignored`);
    } else {
      custom = compiled;
      registry.register(compiled);
      if (compiled.id !== 'custom') {
        registry.register({ ...compiled, id: 'custom' });
      }
    }
  }

  const effectiveId = selectedId === 'custom' ? custom?.id : selectedId;
  if (selectedId === 'custom' && custom === undefined && customTemplate === undefined) {
    warnings.push('TLC.promptTemplate is "custom" but the custom template fields are not usable; using the default template');
  }

  if (effectiveId && registry.resolve(effectiveId).found) {
    return { registry, warnings };
  }
  if (effectiveId && effectiveId !== 'custom') {
    warnings.push(`Unknown template "${effectiveId}"; using the default template`);
  }
  return { registry, warnings };
}

export { DEFAULT_TEMPLATE_ID };
