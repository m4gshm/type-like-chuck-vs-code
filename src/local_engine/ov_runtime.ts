import { existsSync, readFileSync } from 'node:fs';

export const OV_GENAI_VERSION = '2026.4.1.0';
export const DEFAULT_OPENVINO_URL = 'https://storage.openvinotoolkit.org';

// The backend embeds this prefix plus its OpenVINO GenAI version into the
// binary. The runner cannot start without runtime DLLs matching its build
// (a mismatched runtime crashes at load), so the extension reads the version
// from the binary bytes instead of probing the process.
const RUNTIME_VERSION_MARKER = 'ovgenai-runtime-version: ';

export function runnerOvGenaiVersion(runnerPath: string | undefined): string | undefined {
  if (runnerPath === undefined || runnerPath.length === 0 || !existsSync(runnerPath)) {
    return undefined;
  }
  const text = readFileSync(runnerPath).toString('latin1');
  const at = text.indexOf(RUNTIME_VERSION_MARKER);
  if (at < 0) {
    return undefined;
  }
  const version = text.slice(at + RUNTIME_VERSION_MARKER.length, at + RUNTIME_VERSION_MARKER.length + 32).match(/^[0-9][0-9A-Za-z.\-]*/)?.[0];
  // "unknown" = a build without a version (raw cmake); fall back to the pin.
  return version !== undefined && version.length > 0 ? version : undefined;
}

export interface OvGenaiAsset {
  fileName: string;
  url: string;
}

/**
 * The OpenVINO GenAI archive bundles the OpenVINO Runtime, all device plugins
 * (CPU/GPU/NPU), TBB and the GenAI libs itself, so one download per platform
 * provides everything the ovgenai runner needs. The ubuntu22 build is used on
 * every Linux x64 distro: it satisfies the oldest glibc and runs on newer ones.
 */
export function resolveOvGenaiAsset(
  platform: NodeJS.Platform,
  arch: string,
  version: string = OV_GENAI_VERSION,
  baseUrl: string = DEFAULT_OPENVINO_URL,
): OvGenaiAsset | undefined {
  const base = `${baseUrl.replace(/\/+$/, '')}/repositories/openvino_genai/packages/${ovPackageVersion(version)}`;
  if (platform === 'win32' && arch === 'x64') {
    const fileName = `openvino_genai_windows_${version}_x86_64.zip`;
    return { fileName, url: `${base}/windows/${fileName}` };
  }
  if (platform === 'linux' && arch === 'x64') {
    const fileName = `openvino_genai_ubuntu22_${version}_x86_64.tar.gz`;
    return { fileName, url: `${base}/linux/${fileName}` };
  }
  return undefined;
}

/**
 * Storage-server package dir for a runtime version: patch-level 0 releases
 * live under "X.Y" (2026.4.0.0 → 2026.4), later patches under "X.Y.Z"
 * (2026.4.1.0 → 2026.4.1); rc versions live under pre-release/<full-version>/.
 */
export function ovPackageVersion(version: string): string {
  if (version.includes('rc')) {
    return `pre-release/${version}`;
  }
  const parts = version.split('.');
  return parts[2] === '0' ? parts.slice(0, 2).join('.') : parts.slice(0, 3).join('.');
}

/** Library directory inside the unpacked archive holding the runtime .so/.dll files. */
export function ovGenaiLibDir(platform: NodeJS.Platform, unpackedRoot: string): string {
  return platform === 'win32' ? `${unpackedRoot}/runtime/bin/intel64/Release` : `${unpackedRoot}/runtime/lib/intel64`;
}

/**
 * Windows only: the runner links tbb12.dll, which the OpenVINO bin dir does
 * not contain — it lives in the archive's bundled TBB and must be on PATH too
 * (a missing TBB dir crashes the process at load with 0xC0000135).
 */
export function ovGenaiTbbDir(platform: NodeJS.Platform, unpackedRoot: string): string | undefined {
  return platform === 'win32' ? `${unpackedRoot}/runtime/3rdparty/tbb/bin` : undefined;
}
