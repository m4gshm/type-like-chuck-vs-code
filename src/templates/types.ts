export interface FimMarkers {
  prefix: string;
  suffix: string;
  middle: string;
}

export interface FimTemplate {
  /** Unique template id, selectable via `tlc.promptTemplate`. */
  readonly id: string;
  /** Reserved tokens sent as API stop sequences and masked inside user code. */
  readonly reservedTokens: readonly string[];
  /** Structural markers, so tooling can display and copy template elements. */
  readonly markers: FimMarkers;
  /** Renders the FIM prompt for the given code prefix and suffix. */
  render(prefix: string, suffix: string): string;
}

/** A user-defined template as it appears in the `tlc.customTemplates` setting. */
export interface CustomTemplateDefinition {
  id: string;
  prefix: string;
  suffix: string;
  middle: string;
  stop?: string[];
}

export function templateFromDefinition(def: CustomTemplateDefinition): FimTemplate | undefined {
  if (
    !def ||
    typeof def.id !== 'string' || def.id.length === 0 ||
    typeof def.prefix !== 'string' ||
    typeof def.suffix !== 'string' ||
    typeof def.middle !== 'string'
  ) {
    return undefined;
  }
  const stop = Array.isArray(def.stop)
    ? def.stop.filter((t): t is string => typeof t === 'string' && t.length > 0)
    : [];
  return {
    id: def.id,
    reservedTokens: stop,
    markers: { prefix: def.prefix, suffix: def.suffix, middle: def.middle },
    render: (prefix, suffix) => def.prefix + prefix + def.suffix + suffix + def.middle,
  };
}
