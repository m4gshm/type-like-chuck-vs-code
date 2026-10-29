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
 * follows GPU → CPU (the default; the NPU turned out slower than the iGPU on
 * the llama.cpp openvino build), an explicit device (including the opt-in
 * `npu`) is tried first with CPU as the last retry.
 */
export function deviceChain(device: LocalDevice): SupportedDevice[] {
  return device === 'auto' ? ['gpu', 'cpu'] : [device, 'cpu'].filter((d, i, all) => all.indexOf(d) === i) as SupportedDevice[];
}
