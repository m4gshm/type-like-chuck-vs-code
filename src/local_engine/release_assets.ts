export type EngineVariant = 'llama-std' | 'llama-openvino';

export interface ResolvedEngineAsset {
  variant: EngineVariant;
  fileName: string;
  url: string;
}

export const DEFAULT_RELEASE_TAG = 'b11935';
/** OpenVINO runtime version the llama.cpp openvino build is tied to (asset name part). */
export const OPENVINO_BUILD_VERSION = '2026.4.1';
export const DEFAULT_GITHUB_BASE = 'https://github.com';

interface AssetEntry {
  platform: NodeJS.Platform;
  arch: string;
  variant: EngineVariant;
  fileName: (tag: string) => string;
}

const OV_ASSET = (kind: 'win' | 'ubuntu') => (t: string) => kind === 'win'
  ? `llama-${t}-bin-win-openvino-${OPENVINO_BUILD_VERSION}-x64.zip`
  : `llama-${t}-bin-ubuntu-openvino-${OPENVINO_BUILD_VERSION}-x64.tar.gz`;

const ASSETS: AssetEntry[] = [
  { platform: 'win32', arch: 'x64', variant: 'llama-std', fileName: (t) => `llama-${t}-bin-win-vulkan-x64.zip` },
  { platform: 'win32', arch: 'arm64', variant: 'llama-std', fileName: (t) => `llama-${t}-bin-win-vulkan-arm64.zip` },
  { platform: 'linux', arch: 'x64', variant: 'llama-std', fileName: (t) => `llama-${t}-bin-ubuntu-vulkan-x64.tar.gz` },
  { platform: 'linux', arch: 'arm64', variant: 'llama-std', fileName: (t) => `llama-${t}-bin-ubuntu-vulkan-arm64.tar.gz` },
  { platform: 'darwin', arch: 'x64', variant: 'llama-std', fileName: (t) => `llama-${t}-bin-macos-x64.tar.gz` },
  { platform: 'darwin', arch: 'arm64', variant: 'llama-std', fileName: (t) => `llama-${t}-bin-macos-arm64.tar.gz` },
  { platform: 'win32', arch: 'x64', variant: 'llama-openvino', fileName: OV_ASSET('win') },
  { platform: 'linux', arch: 'x64', variant: 'llama-openvino', fileName: OV_ASSET('ubuntu') },
];

export function releaseDownloadUrl(base: string, tag: string, fileName: string, owner: string = 'ggml-org/llama.cpp'): string {
  return `${base.replace(/\/+$/, '')}/${owner}/releases/download/${tag}/${fileName}`;
}

export function resolveEngineAsset(
  platform: NodeJS.Platform,
  arch: string,
  tag: string = DEFAULT_RELEASE_TAG,
  githubBase: string = DEFAULT_GITHUB_BASE,
  variant: EngineVariant = 'llama-std',
): ResolvedEngineAsset | undefined {
  const entry = ASSETS.find((a) => a.platform === platform && a.arch === arch && a.variant === variant);
  if (entry === undefined) {
    return undefined;
  }
  const fileName = entry.fileName(tag);
  return { variant: entry.variant, fileName, url: releaseDownloadUrl(githubBase, tag, fileName) };
}
