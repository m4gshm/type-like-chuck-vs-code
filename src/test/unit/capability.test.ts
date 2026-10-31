import { describe, expect, it, vi } from 'vitest';
import { probeCapability, recommend } from '../../local_engine/capability';

describe('recommend (pure matrix)', () => {
  it.each([
    ['win32', 'arm64'],
    ['linux', 'arm64'],
  ] as Array<[NodeJS.Platform, string]>)('recommends llama.cpp on %s/%s (non-x64, non-darwin)', (platform, arch) => {
    const result = recommend(platform, arch, 'Intel(R) Core(TM) i7', false);
    expect(result).toMatchObject({ kind: 'local', engineKind: 'llama.cpp', device: 'auto' });
  });

  it('recommends ovgenai with NPU on Intel x64 when an Intel NPU is present', () => {
    const result = recommend('win32', 'x64', 'Intel(R) Core(TM) Ultra 7 155H', true);
    expect(result).toMatchObject({ kind: 'local', engineKind: 'ovgenai', device: 'npu' });
  });

  it('recommends ovgenai with auto device on Intel x64 without an NPU', () => {
    const result = recommend('linux', 'x64', 'Intel(R) Core(TM) i5-10400', false);
    expect(result).toMatchObject({ kind: 'local', engineKind: 'ovgenai', device: 'auto' });
  });

  it('recommends llama.cpp on non-Intel x64 (AMD etc.)', () => {
    const result = recommend('win32', 'x64', 'AMD Ryzen 9 7950X', false);
    expect(result).toMatchObject({ kind: 'local', engineKind: 'llama.cpp', device: 'auto' });
  });

  it('recommends mlx on macOS arm64', () => {
    const result = recommend('darwin', 'arm64', 'Apple M3', false);
    expect(result).toMatchObject({ kind: 'local', engineKind: 'mlx', device: 'gpu' });
  });

  it('recommends llama.cpp on macOS x64', () => {
    const result = recommend('darwin', 'x64', 'Intel(R) Core(TM) i9', true);
    expect(result).toMatchObject({ kind: 'local', engineKind: 'llama.cpp', device: 'auto' });
  });

  it('recommends remote on unsupported platforms', () => {
    const result = recommend('freebsd', 'x64', 'Intel(R) Core(TM) i7', true);
    expect(result).toEqual({ kind: 'remote', reason: expect.stringContaining('No local acceleration') });
  });
});

describe('probeCapability', () => {
  it('probes the NPU only on Windows/Linux x64', async () => {
    const detectNpu = vi.fn(async () => true);
    await probeCapability({ platform: 'darwin', arch: 'arm64', detectNpu });
    await probeCapability({ platform: 'win32', arch: 'arm64', detectNpu });
    expect(detectNpu).not.toHaveBeenCalled();

    const local = await probeCapability({ platform: 'win32', arch: 'x64', cpuModel: 'Intel(R) Core(TM) Ultra 7', detectNpu });
    expect(detectNpu).toHaveBeenCalledWith('win32');
    expect(local).toMatchObject({ kind: 'local', engineKind: 'ovgenai', device: 'npu' });
  });

  it('uses the default cpu model when no override is given', async () => {
    const result = await probeCapability({
      platform: 'win32',
      arch: 'x64',
      detectNpu: async () => false,
    });
    expect(result).toMatchObject({ kind: 'local' });
    expect(['ovgenai', 'llama.cpp']).toContain(result.kind === 'local' ? result.engineKind : undefined);
  });
});
