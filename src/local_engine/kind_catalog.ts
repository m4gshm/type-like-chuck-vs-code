import { rm } from 'fs/promises';
import { join } from 'path';
import { isLocalModelId, LocalModelId, LocalModelSpec, localModel, DEFAULT_HF_BASE } from './model_catalog';
import { IrFormat, IrModelSpec, irModel } from './ir_model_catalog';
import { MlxModelSpec, mlxModel } from './mlx_model_catalog';
import { EnginePaths } from './paths';

export type EngineKind = 'llama.cpp' | 'ovgenai' | 'mlx';

/** ovgenai IR and mlx models download as a directory of files; llama.cpp downloads a single GGUF. */
export type DirModelSpec = IrModelSpec | MlxModelSpec;

export const dirModelSpec = (kind: 'ovgenai' | 'mlx', id: LocalModelId, format: IrFormat): DirModelSpec =>
  kind === 'mlx' ? mlxModel(id) : irModel(id, format);

export const catalogSpec = (kind: EngineKind, id: LocalModelId, format: IrFormat): DirModelSpec | LocalModelSpec =>
  kind === 'llama.cpp' ? localModel(id) : dirModelSpec(kind, id, format);

/** The files whose presence marks the model as downloaded. */
export const catalogModelFiles = (kind: EngineKind, id: LocalModelId, format: IrFormat): string[] =>
  kind === 'llama.cpp' ? [localModel(id).fileName] : dirModelSpec(kind, id, format).files;

/**
 * Directory holding the model's files: `models/<owner>/<repo>` mirrors the
 * Hugging Face layout; unknown ids keep a flat format-suffixed folder so
 * families never collide.
 */
export const catalogModelDir = (paths: EnginePaths, kind: EngineKind, modelId: string, format: IrFormat): string => {
  if (kind === 'llama.cpp') {
    return paths.modelDir;
  }
  const spec = isLocalModelId(modelId) ? dirModelSpec(kind, modelId, format) : undefined;
  return spec !== undefined ? join(paths.modelDir, spec.repo) : join(paths.modelDir, kind === 'mlx' ? `${modelId}-mlx` : `${modelId}-${format}-ov`);
};

export const dirModelFileUrl = (spec: DirModelSpec, fileName: string, hfBase: string = DEFAULT_HF_BASE): string =>
  `${hfBase.replace(/\/+$/, '')}/${spec.repo}/resolve/main/${fileName}`;

const ggufFilePath = (paths: EnginePaths, modelId: string): string => {
  const model = isLocalModelId(modelId) ? localModel(modelId) : undefined;
  return model !== undefined ? join(paths.modelDir, model.fileName) : join(paths.modelDir, modelId);
};

/** Deletes the managed files of a catalog model. A custom (From-disk) model path is user-owned and never touched. */
export const removeCatalogModel = async (paths: EnginePaths, kind: EngineKind, modelId: string): Promise<void> => {
  if (kind === 'ovgenai') {
    for (const format of ['nf4', 'int8'] as const) {
      await rm(catalogModelDir(paths, kind, modelId, format), { recursive: true, force: true });
    }
  } else if (kind === 'mlx') {
    await rm(catalogModelDir(paths, kind, modelId, 'nf4'), { recursive: true, force: true });
  } else {
    await rm(ggufFilePath(paths, modelId), { force: true });
  }
};

/** "From disk…" hint wording for the model picker, per engine kind. */
export const diskModelHint = (kind: EngineKind): string =>
  kind === 'ovgenai'
    ? 'an OpenVINO IR model directory (folder with openvino_model.xml/.bin and tokenizer files)'
    : kind === 'mlx'
      ? 'an mlx model directory'
      : 'a GGUF file';

/** File dialog options for the "From disk…" entry: the ovgenai runner takes a model directory, not a bare .xml file. */
export const diskModelDialog = (kind: EngineKind): { canSelectFolders: boolean; canSelectFiles: boolean; filters: Record<string, string[]> } =>
  kind === 'ovgenai'
    ? { canSelectFolders: true, canSelectFiles: false, filters: {} }
    : kind === 'mlx'
      ? { canSelectFolders: true, canSelectFiles: true, filters: {} }
      : { canSelectFolders: false, canSelectFiles: true, filters: { 'GGUF model': ['gguf'] } };
