import { execFile } from 'child_process';
import { readdir, readFile } from 'fs/promises';
import { cpus } from 'os';

export type RecommendedEngineKind = 'llama.cpp' | 'ovgenai' | 'mlx';

export type RecommendedPath =
  | { kind: 'local'; engineKind: RecommendedEngineKind; device: 'npu' | 'gpu' | 'auto'; reason: string }
  | { kind: 'remote'; reason: string };

/**
 * Pure recommendation matrix: engine kind + device from the platform,
 * CPU vendor and NPU presence. GPU presence is not probed — the engine's
 * start-fallback chain (GPU → CPU) resolves it at start.
 */
export function recommend(
  platform: NodeJS.Platform,
  arch: string,
  cpuModel: string,
  hasNpu: boolean,
): RecommendedPath {
  const supported = (arch === 'x64' || arch === 'arm64') && ['win32', 'linux', 'darwin'].includes(platform);
  if (!supported) {
    return { kind: 'remote', reason: `No local acceleration for ${platform}/${arch}` };
  }
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? { kind: 'local', engineKind: 'mlx', device: 'gpu', reason: 'Metal acceleration (mlx runner on Apple Silicon)' }
      : { kind: 'local', engineKind: 'llama.cpp', device: 'auto', reason: 'llama.cpp vulkan build (GPU via NVIDIA/AMD/Intel, CPU fallback)' };
  }
  if (arch === 'x64' && /intel/i.test(cpuModel)) {
    return hasNpu
      ? { kind: 'local', engineKind: 'ovgenai', device: 'npu', reason: 'OpenVINO GenAI runner with native IR models on the Intel NPU' }
      : { kind: 'local', engineKind: 'ovgenai', device: 'auto', reason: 'OpenVINO GenAI runner (GPU via Intel iGPU/Arc, CPU fallback)' };
  }
  return { kind: 'local', engineKind: 'llama.cpp', device: 'auto', reason: 'llama.cpp vulkan build (GPU via NVIDIA/AMD/Intel, CPU fallback)' };
}

function execOut(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 10_000 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

/** Windows: WMI PnP device named "Intel(R) AI Boost". */
async function npuWindows(): Promise<boolean> {
  const out = await execOut('powershell', [
    '-NoProfile',
    '-Command',
    'Get-CimInstance -Query "SELECT Name FROM Win32_PnPEntity WHERE Name LIKE \'%AI Boost%\'"',
  ]);
  return out.trim().length > 0;
}

/** Linux: PCI device with Intel vendor (0x8086) and accelerator class (0x118000). */
async function npuLinux(): Promise<boolean> {
  try {
    for (const dev of await readdir('/sys/bus/pci/devices')) {
      const [vendor, cls] = await Promise.all([
        readFile(`/sys/bus/pci/devices/${dev}/vendor`, 'utf8'),
        readFile(`/sys/bus/pci/devices/${dev}/class`, 'utf8'),
      ]);
      if (vendor.trim() === '0x8086' && cls.trim() === '0x118000') {
        return true;
      }
    }
  } catch {
    // No sysfs or no access — treat as no NPU.
  }
  return false;
}

// Cached per session: the hardware does not change while VS Code runs.
let npuProbe: Promise<boolean> | undefined;
const detectIntelNpu = (platform: NodeJS.Platform): Promise<boolean> => {
  if (npuProbe === undefined) {
    npuProbe = (platform === 'win32' ? npuWindows() : npuLinux()).catch(() => false);
  }
  return npuProbe;
};

export async function probeCapability(deps: {
  platform: NodeJS.Platform;
  arch: string;
  /** Override the CPU model string (defaults to os.cpus()). */
  cpuModel?: string;
  /** Override NPU detection (defaults to platform WMI/PCI probing). */
  detectNpu?: (platform: NodeJS.Platform) => Promise<boolean>;
}): Promise<RecommendedPath> {
  const cpuModel = deps.cpuModel ?? cpus()[0]?.model ?? '';
  const detect = deps.detectNpu ?? detectIntelNpu;
  const hasNpu = ['win32', 'linux'].includes(deps.platform) && deps.arch === 'x64' ? await detect(deps.platform) : false;
  return recommend(deps.platform, deps.arch, cpuModel, hasNpu);
}
