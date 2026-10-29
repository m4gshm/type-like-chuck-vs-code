import { describe, expect, it } from 'vitest';
import { probeCapability } from '../../local_engine/capability';

describe('probeCapability', () => {
  it.each([
    ['win32', 'x64'],
    ['win32', 'arm64'],
    ['linux', 'x64'],
    ['darwin', 'arm64'],
  ] as Array<[NodeJS.Platform, string]>)('recommends the local gpu on %s/%s', async (platform, arch) => {
    const result = await probeCapability({ platform, arch });
    expect(result).toEqual({ kind: 'local', device: 'gpu', reason: expect.any(String) });
  });

  it('recommends the remote api on unsupported local platforms', async () => {
    const result = await probeCapability({ platform: 'freebsd' as NodeJS.Platform, arch: 'x64' });
    expect(result).toEqual({ kind: 'remote', reason: expect.stringContaining('No local acceleration') });
  });
});
