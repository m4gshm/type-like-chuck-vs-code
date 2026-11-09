import { execFile } from 'child_process';
import { readdir, readFile } from 'fs/promises';

export type RecommendedEngineKind = 'llama.cpp' | 'ovgenai' | 'mlx';

/**
 * Untouched-setting default engine kind: the kind half of the
 * recommendation matrix (NPU presence is async and only affects the device).
 */
export function defaultEngineKind(platform: NodeJS.Platform, arch: string, cpuModel: string): RecommendedEngineKind {
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'mlx' : 'llama.cpp';
  }
  if (platform === 'linux' && arch === 'arm64' && /intel/i.test(cpuModel)) {
    return 'ovgenai';
  }
  return (platform === 'win32' || platform === 'linux') && arch === 'x64' && /intel/i.test(cpuModel)
    ? 'ovgenai'
    : 'llama.cpp';
}

/** NPU hardware generation by PCI device ID (Linux ivpu driver naming:
 * 37XX = Core Ultra 100 generation, 40XX = NPU 4, 50XX/60XX = NPU 5/6).
 * Unknown ids resolve to 0: present but with no NPU priority. */
const NPU_DEVICE_GENERATIONS: Record<string, number> = {
  '0x7d1d': 3, // Meteor Lake (Core Ultra 100)
  '0xad1d': 3, // Arrow Lake
  '0x643e': 4, // Lunar Lake — NPU 4
  '0xb03e': 5, // Panther Lake — NPU 5
  '0xfd3e': 5, // Wildcat Lake
  '0xd71d': 6, // Nova Lake — NPU 6
};

export function npuDeviceGeneration(deviceId: string): number {
  return NPU_DEVICE_GENERATIONS[deviceId.toLowerCase()] ?? 0;
}

function execOut(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 10_000 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

/** Windows: the NPU device is identified by its PCI device ID from Win32_PnPEntity. */
async function npuWindows(): Promise<number> {
  const out = await execOut('powershell', [
    '-NoProfile',
    '-Command',
    'Get-CimInstance -Query "SELECT DeviceID FROM Win32_PnPEntity WHERE Name LIKE \'%Intel(R) NPU%\' OR Name LIKE \'%AI Boost%\' OR PNPClass = \'ComputeAccelerator\'" | Select-Object -ExpandProperty DeviceID',
  ]);
  const match = out.match(/DEV_([0-9a-f]{4})/i);
  return match !== null ? npuDeviceGeneration(`0x${match[1].toLowerCase()}`) : 0;
}

/** Linux: PCI device with Intel vendor (0x8086) and accelerator class (0x118000). */
async function npuLinux(): Promise<number> {
  try {
    for (const dev of await readdir('/sys/bus/pci/devices')) {
      const [vendor, cls, device] = await Promise.all([
        readFile(`/sys/bus/pci/devices/${dev}/vendor`, 'utf8'),
        readFile(`/sys/bus/pci/devices/${dev}/class`, 'utf8'),
        readFile(`/sys/bus/pci/devices/${dev}/device`, 'utf8'),
      ]);
      if (vendor.trim() === '0x8086' && cls.trim() === '0x118000') {
        return npuDeviceGeneration(device.trim());
      }
    }
  } catch {
    // No sysfs or no access — treat as no NPU.
  }
  return 0;
}

// Cached per session: the hardware does not change while VS Code runs.
let npuProbe: Promise<number> | undefined;
const detectIntelNpu = (platform: NodeJS.Platform): Promise<number> => {
  if (npuProbe === undefined) {
    npuProbe = (platform === 'win32' ? npuWindows() : npuLinux()).catch(() => 0);
  }
  return npuProbe;
};

/** Cached NPU hardware generation: 0 = no NPU or an unrecognized one. */
export async function npuGeneration(platform: NodeJS.Platform): Promise<number> {
  if (!['win32', 'linux'].includes(platform) || process.arch !== 'x64') {
    return 0;
  }
  return detectIntelNpu(platform);
}
