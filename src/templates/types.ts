export interface FimMarkers {
  prefix: string;
  suffix: string;
  middle: string;
}

export interface FimTemplate {
  readonly id: string;
  /** Reserved tokens sent as API stop sequences and masked inside user code. */
  readonly reservedTokens: readonly string[];
  /** Structural markers, so tooling can display and copy template elements. */
  readonly markers: FimMarkers;
  render(prefix: string, suffix: string): string;
}

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
    typeof def.middle !== 'string' ||
    (def.prefix.length === 0 && def.suffix.length === 0 && def.middle.length === 0)
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
