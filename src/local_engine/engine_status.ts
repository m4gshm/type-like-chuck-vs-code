import { LocalDevice } from '../config';

/** Engine lifecycle phase names: the discriminant values of EngineStatus below, shared with its consumers. */
export const ENGINE_STATUS = {
  notInstalled: 'not-installed',
  awaitingInput: 'awaiting-input',
  preparingEngine: 'preparing-engine',
  preparingModel: 'preparing-model',
  starting: 'starting',
  ready: 'ready',
  error: 'error',
} as const;

export type EngineStatus =
  | { status: typeof ENGINE_STATUS.notInstalled }
  | { status: typeof ENGINE_STATUS.awaitingInput; prompt: string }
  | { status: typeof ENGINE_STATUS.preparingEngine }
  | { status: typeof ENGINE_STATUS.preparingModel }
  | { status: typeof ENGINE_STATUS.starting; /** Only the NPU compiles the model graph; the hint is shown just for it. */ npuCompile?: boolean }
  | { status: typeof ENGINE_STATUS.ready; baseUrl: string; apiKey: string | undefined; model: string; modelPath: string; device?: LocalDevice }
  | { status: typeof ENGINE_STATUS.error; message: string };
