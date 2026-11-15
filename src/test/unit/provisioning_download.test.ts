import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForPeerDownload } from '../../local_engine/provisioning';
import { isPidAlive } from '../../local_engine/runner_discovery';

vi.mock('../../local_engine/runner_discovery', () => ({ isPidAlive: vi.fn() }));

const alive = vi.mocked(isPidAlive);

afterEach(() => {
  vi.clearAllMocks();
});

describe('waitForPeerDownload', () => {
  it('skips the download when a live peer already produced the destination', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlc-prov-'));
    try {
      const destination = join(dir, 'archive.tar.gz');
      writeFileSync(destination, 'x');
      writeFileSync(`${destination}.downloading`, JSON.stringify({ pid: 4242 }));
      alive.mockReturnValue(true);
      expect(await waitForPeerDownload(destination, undefined)).toBe(true);
      expect(rmSync.toString()).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes over when the marker owner is dead', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlc-prov-'));
    try {
      const destination = join(dir, 'archive.tar.gz');
      writeFileSync(`${destination}.downloading`, JSON.stringify({ pid: 4242 }));
      alive.mockReturnValue(false);
      expect(await waitForPeerDownload(destination, undefined)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('downloads immediately without a marker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlc-prov-'));
    try {
      expect(await waitForPeerDownload(join(dir, 'archive.tar.gz'), undefined)).toBe(false);
      expect(alive).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
