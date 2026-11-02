import { LocalEngineKind } from '../config';
import { isLocalModelId, LOCAL_MODEL_IDS, LocalModelId, localModel } from './model_catalog';
import { irModel } from './ir_model_catalog';
import { mlxModel } from './mlx_model_catalog';

export type LocalModelPickValue = LocalModelId | 'disk';

/** The model the engine actually uses: a customPath applies only while the
 * model id is "custom" — a stale path must not override a catalog choice. */
export function effectiveLocalModel(modelId: string, modelPath: string): string {
  return modelId === 'custom' && modelPath.length > 0 ? `path:${modelPath}` : `id:${modelId}`;
}

/** Catalog spec (label, FIM template, size) for a model id under an engine kind. */
export function localModelSpec(kind: LocalEngineKind, id: string): { label: string; template: string; approximateBytes: number } | undefined {
  return isLocalModelId(id)
    ? (kind === 'ovgenai' ? irModel(id) : kind === 'mlx' ? mlxModel(id) : localModel(id))
    : undefined;
}

/** Catalog label without the device-specific IR format suffix (the actual
 * format is resolved per device at engine start: nf4 for NPU, int8 for GPU/CPU). */
export function localModelDisplayName(kind: LocalEngineKind, id: string): string {
  const label = localModelSpec(kind, id)?.label ?? 'model';
  return label.replace(/ \(OpenVINO IR, (?:nf4|int8)\)$/, '');
}

export interface LocalModelPickItem {
  label: string;
  description?: string;
  detail: string;
  value: LocalModelPickValue;
}

/** QuickPick items for TLC: Select Local Model, including the "From disk…" offline entry. */
export function localModelPickerItems(kind: LocalEngineKind, currentId: string): LocalModelPickItem[] {
  const items: LocalModelPickItem[] = LOCAL_MODEL_IDS.map((id) => {
    const model = localModelSpec(kind, id)!;
    return {
      label: model.label,
      description: currentId === id ? '$(check) current' : undefined,
      detail: `${(model.approximateBytes / 1_000_000_000).toFixed(1)} GB download · id: ${id}`,
      value: id,
    };
  });
  items.push({
    label: '$(folder-opened) From disk…',
    description: currentId === 'custom' ? '$(check) current' : undefined,
    detail: 'Use a local model without downloading: '
      + (kind === 'ovgenai'
        ? 'an OpenVINO IR model directory (folder with openvino_model.xml/.bin and tokenizer files)'
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
  // The ovgenai runner takes a model directory, not a bare .xml file.
  return kind === 'ovgenai'
    ? { canSelectFolders: true, canSelectFiles: false, filters: {} }
    : kind === 'mlx'
      ? { canSelectFolders: true, canSelectFiles: true, filters: {} }
      : { canSelectFolders: false, canSelectFiles: true, filters: { 'GGUF model': ['gguf'] } };
}
