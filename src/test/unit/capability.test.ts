import { describe, expect, it, vi } from 'vitest';
import { defaultEngineKind, npuDeviceGeneration, probeCapability, recommend } from '../../local_engine/capability';

describe('defaultEngineKind (untouched setting)', () => {
  it.each([
    ['win32', 'x64', 'Intel(R) Core(TM) Ultra 7 155H', 'ovgenai'],
    ['linux', 'x64', 'Intel(R) Xeon(R) Gold 6248', 'ovgenai'],
    ['win32', 'x64', 'AMD Ryzen 9 7950X', 'llama.cpp'],
    ['win32', 'arm64', 'Intel(R) Core(TM) i7', 'llama.cpp'],
    ['darwin', 'arm64', 'Apple M3', 'mlx'],
    ['darwin', 'x64', 'Intel(R) Core(TM) i9', 'llama.cpp'],
  ] as Array<[NodeJS.Platform, string, string, string]>)('resolves %s/%s (%s) to %s', (platform, arch, cpu, kind) => {
    expect(defaultEngineKind(platform, arch, cpu)).toBe(kind);
  });
});

describe('npuDeviceGeneration (pure map)', () => {
  it('maps NPU PCI device ids to generations, unknown to 0', () => {
    expect(npuDeviceGeneration('0x643e')).toBe(4);
    expect(npuDeviceGeneration('0xB03E')).toBe(5);
    expect(npuDeviceGeneration('0x7d1d')).toBe(3);
    expect(npuDeviceGeneration('0xdead')).toBe(0);
    expect(npuDeviceGeneration('')).toBe(0);
  });
});

describe('recommend (pure matrix)', () => {
  it.each([
    ['win32', 'arm64'],
    ['linux', 'arm64'],
  ] as Array<[NodeJS.Platform, string]>)('recommends llama.cpp on %s/%s (non-x64, non-darwin)', (platform, arch) => {
    const result = recommend(platform, arch, 'Intel(R) Core(TM) i7', 0);
    expect(result).toMatchObject({ kind: 'local', engineKind: 'llama.cpp', device: 'auto' });
  });

  it('recommends ovgenai with NPU on Intel x64 when the NPU is generation 4 or later', () => {
    const result = recommend('win32', 'x64', 'Intel(R) Core(TM) Ultra 7 255H', 4);
    expect(result).toMatchObject({ kind: 'local', engineKind: 'ovgenai', device: 'npu' });
  });

  it('recommends auto device on Intel x64 with an NPU older than generation 4', () => {
    const result = recommend('linux', 'x64', 'Intel(R) Core(TM) Ultra 7 155H', 3);
    expect(result).toMatchObject({ kind: 'local', engineKind: 'ovgenai', device: 'auto' });
  });

  it('recommends ovgenai with auto device on Intel x64 without an NPU', () => {
    const result = recommend('linux', 'x64', 'Intel(R) Core(TM) i5-10400', 0);
    expect(result).toMatchObject({ kind: 'local', engineKind: 'ovgenai', device: 'auto' });
  });

  it('recommends llama.cpp on non-Intel x64 (AMD etc.)', () => {
    const result = recommend('win32', 'x64', 'AMD Ryzen 9 7950X', 4);
    expect(result).toMatchObject({ kind: 'local', engineKind: 'llama.cpp', device: 'auto' });
  });

  it('recommends mlx on macOS arm64', () => {
    const result = recommend('darwin', 'arm64', 'Apple M3', 0);
    expect(result).toMatchObject({ kind: 'local', engineKind: 'mlx', device: 'gpu' });
  });

  it('recommends llama.cpp on macOS x64', () => {
    const result = recommend('darwin', 'x64', 'Intel(R) Core(TM) i9', 4);
    expect(result).toMatchObject({ kind: 'local', engineKind: 'llama.cpp', device: 'auto' });
  });

  it('recommends remote on unsupported platforms', () => {
    const result = recommend('freebsd', 'x64', 'Intel(R) Core(TM) i7', 4);
    expect(result).toEqual({ kind: 'remote', reason: expect.stringContaining('No local acceleration') });
  });
});

describe('probeCapability', () => {
  it('probes the NPU only on Windows/Linux x64', async () => {
    const detectNpu = vi.fn(async () => 4);
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
      detectNpu: async () => 0,
    });
    expect(result).toMatchObject({ kind: 'local' });
    expect(['ovgenai', 'llama.cpp']).toContain(result.kind === 'local' ? result.engineKind : undefined);
  });
});

