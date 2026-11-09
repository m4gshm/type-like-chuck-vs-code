import { describe, expect, it } from 'vitest';
import { defaultEngineKind, npuDeviceGeneration } from '../../local_engine/capability';

describe('defaultEngineKind (untouched setting)', () => {
  it.each([
    ['win32', 'x64', 'Intel(R) Core(TM) Ultra 7 155H', 'ovgenai'],
    ['linux', 'x64', 'Intel(R) Xeon(R) Gold 6248', 'ovgenai'],
    ['linux', 'arm64', 'Intel(R) Core(TM) Ultra 7', 'ovgenai'],
    ['win32', 'x64', 'AMD Ryzen 9 7950X', 'llama.cpp'],
    ['win32', 'arm64', 'Intel(R) Core(TM) i7', 'llama.cpp'],
    ['linux', 'arm64', 'Ampere(R) Altra(R) Max', 'llama.cpp'],
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
