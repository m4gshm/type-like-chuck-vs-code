import { describe, expect, it } from 'vitest';
import { DEFAULT_RELEASE_TAG, OPENVINO_BUILD_VERSION, resolveEngineAsset } from '../../local_engine/release_assets';

describe('resolveEngineAsset', () => {
  it('resolves the vulkan build by default on windows x64', () => {
    const asset = resolveEngineAsset('win32', 'x64');
    expect(asset?.variant).toBe('llama-std');
    expect(asset?.fileName).toBe(`llama-${DEFAULT_RELEASE_TAG}-bin-win-vulkan-x64.zip`);
  });

  it('resolves vulkan builds on win/linux and cpu builds on darwin', () => {
    expect(resolveEngineAsset('win32', 'arm64')?.fileName).toBe(`llama-${DEFAULT_RELEASE_TAG}-bin-win-vulkan-arm64.zip`);
    expect(resolveEngineAsset('linux', 'x64')?.fileName).toBe(`llama-${DEFAULT_RELEASE_TAG}-bin-ubuntu-vulkan-x64.tar.gz`);
    expect(resolveEngineAsset('linux', 'arm64')?.fileName).toBe(`llama-${DEFAULT_RELEASE_TAG}-bin-ubuntu-vulkan-arm64.tar.gz`);
    expect(resolveEngineAsset('darwin', 'x64')?.fileName).toBe(`llama-${DEFAULT_RELEASE_TAG}-bin-macos-x64.tar.gz`);
    expect(resolveEngineAsset('darwin', 'arm64')?.fileName).toBe(`llama-${DEFAULT_RELEASE_TAG}-bin-macos-arm64.tar.gz`);
  });

  it('resolves the openvino build on win/linux x64 for npu', () => {
    expect(resolveEngineAsset('win32', 'x64', DEFAULT_RELEASE_TAG, undefined, 'llama-openvino')?.fileName)
      .toBe(`llama-${DEFAULT_RELEASE_TAG}-bin-win-openvino-${OPENVINO_BUILD_VERSION}-x64.zip`);
    expect(resolveEngineAsset('linux', 'x64', DEFAULT_RELEASE_TAG, undefined, 'llama-openvino')?.fileName)
      .toBe(`llama-${DEFAULT_RELEASE_TAG}-bin-ubuntu-openvino-${OPENVINO_BUILD_VERSION}-x64.tar.gz`);
    expect(resolveEngineAsset('win32', 'arm64', DEFAULT_RELEASE_TAG, undefined, 'llama-openvino')).toBeUndefined();
    expect(resolveEngineAsset('darwin', 'arm64', DEFAULT_RELEASE_TAG, undefined, 'llama-openvino')).toBeUndefined();
  });

  it('embeds the requested release tag in the url', () => {
    const asset = resolveEngineAsset('win32', 'x64', 'b99999');
    expect(asset?.url).toBe(`https://github.com/ggml-org/llama.cpp/releases/download/b99999/llama-b99999-bin-win-vulkan-x64.zip`);
  });

  it('returns undefined on unsupported platforms', () => {
    expect(resolveEngineAsset('freebsd', 'x64')).toBeUndefined();
    expect(resolveEngineAsset('linux', 's390x')).toBeUndefined();
  });
});
