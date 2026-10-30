export type RecommendedPath =
  | { kind: 'local'; device: 'gpu' | 'cpu'; reason: string }
  | { kind: 'remote'; reason: string };

/**
 * Platform capability probe. Local mode defaults to the GPU (Metal on macOS,
 * where the mlx runner runs, or the llama.cpp vulkan build elsewhere);
 * the NPU is opt-in via tlc.local.device and is not recommended by default.
 */
export async function probeCapability(deps: { platform: NodeJS.Platform; arch: string }): Promise<RecommendedPath> {
  const supported = (deps.arch === 'x64' || deps.arch === 'arm64') && ['win32', 'linux', 'darwin'].includes(deps.platform);
  if (!supported) {
    return { kind: 'remote', reason: `No local acceleration for ${deps.platform}/${deps.arch}` };
  }
  const reason = deps.platform === 'darwin'
    ? 'Metal acceleration (mlx runner on Apple Silicon)'
    : 'llama.cpp vulkan build (GPU via NVIDIA/AMD/Intel, CPU fallback)';
  return { kind: 'local', device: 'gpu', reason };
}
