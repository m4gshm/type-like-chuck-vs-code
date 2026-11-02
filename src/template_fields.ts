import { ResolvedTemplates } from './templates';

/**
 * Template field rules:
 * - marker/stop settings belong to the "custom" template only;
 * - selecting a built-in template removes stored copies of its markers;
 * - editing any field switches the selection to "custom".
 */
export class TemplateFieldSync {
  private syncing = false;

  constructor(private readonly host: {
    registry: () => ResolvedTemplates;
    getSetting: (key: string) => string | undefined;
    clearSetting: (key: string) => PromiseLike<void>;
  }) {}

  /** True while this class writes the marker settings itself. */
  get active(): boolean {
    return this.syncing;
  }

  cleanup = async (selectedId: string | undefined): Promise<void> => {
    if (selectedId === undefined || selectedId === 'custom') {
      return;
    }
    const { template } = this.host.registry().registry.resolve(selectedId);
    if (!template || template.id !== selectedId) {
      return;
    }
    const parseStop = (raw: string | undefined): string =>
      (raw ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .join(',');
    const stored: Array<[string, string, (raw: string | undefined) => string]> = [
      ['prefix', template.markers.prefix, (raw) => raw ?? ''],
      ['suffix', template.markers.suffix, (raw) => raw ?? ''],
      ['middle', template.markers.middle, (raw) => raw ?? ''],
      ['stop', template.reservedTokens.join(','), parseStop],
    ];
    this.syncing = true;
    try {
      for (const [key, builtinValue, normalize] of stored) {
        if (normalize(this.host.getSetting(key)) === builtinValue) {
          await this.host.clearSetting(key);
        }
      }
    } finally {
      this.syncing = false;
    }
  };
}
