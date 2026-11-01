import { LocalDevice } from '../config';

export interface DeviceOptions {
  args: string[];
  extraEnv: Record<string, string>;
  activeDevice: LocalDevice;
  warning?: string;
}

export type SupportedDevice = Exclude<LocalDevice, 'auto'>;

/** Context window used on the NPU: the compiled graph is built for it, and
 * generation speed and compile time grow with it. */
export const NPU_CONTEXT_LENGTH = 8192;

/**
 * Devices to try for the requested preference, in priority order: `auto`
 * follows GPU → CPU (the default), an explicit device is tried first with CPU
 * as the last retry. The llama.cpp build has no NPU path, so an explicit `npu`
 * is redirected to GPU; the ovgenai runner supports it and falls back through
 * GPU (how the backend interprets a device string is the backend's own
 * responsibility).
 */
export function deviceChain(device: LocalDevice, kind: 'llama.cpp' | 'ovgenai' = 'llama.cpp'): SupportedDevice[] {
  if (device === 'auto') {
    return ['gpu', 'cpu'];
  }
  if (device === 'npu') {
    return kind === 'ovgenai' ? ['npu', 'gpu', 'cpu'] : ['gpu', 'cpu'];
  }
  return [device, 'cpu'].filter((d, i, all) => all.indexOf(d) === i) as SupportedDevice[];
}
