import { LocalEngineKind } from '../config';
import { LOCAL_MODEL_IDS, LocalModelId, localModel } from './model_catalog';
import { irModel } from './ir_model_catalog';
import { mlxModel } from './mlx_model_catalog';

export type LocalModelPickValue = LocalModelId | 'disk';

export interface LocalModelPickItem {
  label: string;
  description?: string;
  detail: string;
  value: LocalModelPickValue;
}

/** QuickPick items for TLC: Select Local Model, including the "From disk…" offline entry. */
export function localModelPickerItems(kind: LocalEngineKind, currentId: string): LocalModelPickItem[] {
  const modelOf = (id: LocalModelId) =>
    kind === 'ovgenai' ? irModel(id) : kind === 'mlx' ? mlxModel(id) : localModel(id);
  const items: LocalModelPickItem[] = LOCAL_MODEL_IDS.map((id) => {
    const model = modelOf(id);
    return {
      label: model.label,
      description: currentId === id ? '$(check) current' : undefined,
      detail: `${(model.approximateBytes / 1_000_000_000).toFixed(1)} GB download · id: ${id}`,
      value: id,
    };
  });
  items.push({
    label: '$(folder-opened) From disk…',
    detail: 'Use a local model without downloading: '
      + (kind === 'ovgenai'
        ? 'an OpenVINO IR .xml file (its .bin must sit alongside)'
        : kind === 'mlx'
          ? 'an mlx model directory'
          : 'a GGUF file'),
    value: 'disk',
  });
  return items;
}

/** File dialog options for the "From disk…" entry, per engine kind. */
export function localModelDiskDialog(kind: LocalEngineKind): {
  canSelectFolders: boolean;
  canSelectFiles: boolean;
  filters: Record<string, string[]>;
} {
  return kind === 'ovgenai'
    ? { canSelectFolders: false, canSelectFiles: true, filters: { 'OpenVINO IR model': ['xml'] } }
    : kind === 'mlx'
      ? { canSelectFolders: true, canSelectFiles: true, filters: {} }
      : { canSelectFolders: false, canSelectFiles: true, filters: { 'GGUF model': ['gguf'] } };
}
