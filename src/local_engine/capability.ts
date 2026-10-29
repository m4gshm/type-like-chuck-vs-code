export type RecommendedPath =
  | { kind: 'local'; device: 'gpu' | 'cpu'; reason: string }
  | { kind: 'remote'; reason: string };

/**
 * Platform capability probe. The llama.cpp vulkan build accelerates
 * NVIDIA/AMD/Intel GPUs (Metal on macOS), so local mode defaults to the GPU;
 * the NPU is opt-in via tlc.local.device and is not recommended by default.
 */
export async function probeCapability(deps: { platform: NodeJS.Platform; arch: string }): Promise<RecommendedPath> {
  const supported = (deps.arch === 'x64' || deps.arch === 'arm64') && ['win32', 'linux', 'darwin'].includes(deps.platform);
  if (!supported) {
    return { kind: 'remote', reason: `No local acceleration for ${deps.platform}/${deps.arch}` };
  }
  const reason = deps.platform === 'darwin'
    ? 'Metal-accelerated llama.cpp build'
    : 'llama.cpp vulkan build (GPU via NVIDIA/AMD/Intel, CPU fallback)';
  return { kind: 'local', device: 'gpu', reason };
}
