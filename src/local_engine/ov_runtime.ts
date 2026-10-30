export const OV_GENAI_VERSION = '2026.4.0.0';
export const DEFAULT_OPENVINO_URL = 'https://storage.openvinotoolkit.org';

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

/** 2026.4.0.0 → package dir "2026.4"; rc versions live under pre-release/<full-version>/. */
export function ovPackageVersion(version: string): string {
  return version.includes('rc') ? `pre-release/${version}` : version.split('.').slice(0, 2).join('.');
}

/** Library directory inside the unpacked archive holding the runtime .so/.dll files. */
export function ovGenaiLibDir(platform: NodeJS.Platform, unpackedRoot: string): string {
  return platform === 'win32' ? `${unpackedRoot}/runtime/bin/intel64/Release` : `${unpackedRoot}/runtime/lib/intel64`;
}
