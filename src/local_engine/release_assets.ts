export interface ResolvedEngineAsset {
  fileName: string;
  url: string;
}

export const DEFAULT_RELEASE_TAG = 'b11935';
export const DEFAULT_GITHUB_BASE = 'https://github.com';

interface AssetEntry {
  platform: NodeJS.Platform;
  arch: string;
  fileName: (tag: string) => string;
}

const ASSETS: AssetEntry[] = [
  { platform: 'win32', arch: 'x64', fileName: (t) => `llama-${t}-bin-win-vulkan-x64.zip` },
  { platform: 'win32', arch: 'arm64', fileName: (t) => `llama-${t}-bin-win-vulkan-arm64.zip` },
  { platform: 'linux', arch: 'x64', fileName: (t) => `llama-${t}-bin-ubuntu-vulkan-x64.tar.gz` },
  { platform: 'linux', arch: 'arm64', fileName: (t) => `llama-${t}-bin-ubuntu-vulkan-arm64.tar.gz` },
  { platform: 'darwin', arch: 'x64', fileName: (t) => `llama-${t}-bin-macos-x64.tar.gz` },
  { platform: 'darwin', arch: 'arm64', fileName: (t) => `llama-${t}-bin-macos-arm64.tar.gz` },
];

export function releaseDownloadUrl(base: string, tag: string, fileName: string, owner: string = 'ggml-org/llama.cpp'): string {
  return `${base.replace(/\/+$/, '')}/${owner}/releases/download/${tag}/${fileName}`;
}

export function resolveEngineAsset(
  platform: NodeJS.Platform,
  arch: string,
  tag: string = DEFAULT_RELEASE_TAG,
  githubBase: string = DEFAULT_GITHUB_BASE,
): ResolvedEngineAsset | undefined {
  const entry = ASSETS.find((a) => a.platform === platform && a.arch === arch);
  if (entry === undefined) {
    return undefined;
  }
  const fileName = entry.fileName(tag);
  return { fileName, url: releaseDownloadUrl(githubBase, tag, fileName) };
}
