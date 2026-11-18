import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findLiveMatch,
  ensureListenDir,
  localListenEndpoint,
  matchFields,
  newToken,
  recordKey,
  scanRecords,
  writeRecord,
  type RunnerRecord,
} from '../../local_engine/runner_discovery';

const record = (overrides: Partial<RunnerRecord> = {}): RunnerRecord => ({
  pid: process.pid,
  transport: 'pipe',
  endpoint: '\\\\.\\pipe\\x',
  token: 't',
  options: { kind: 'ovgenai', modelPath: '/m', device: 'NPU', contextLength: 4096 },
  ...overrides,
});

describe('runner_discovery', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tlc-discovery-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('ovgenai instances differ by context length, mlx ones do not', () => {
    expect(matchFields('ovgenai', { kind: 'ovgenai', modelPath: '/m', device: 'NPU', contextLength: 4096 }))
      .not.toEqual(matchFields('ovgenai', { kind: 'ovgenai', modelPath: '/m', device: 'NPU', contextLength: 8192 }));
    expect(recordKey({ kind: 'ovgenai', modelPath: '/m', device: 'NPU', contextLength: 4096 }))
      .not.toBe(recordKey({ kind: 'ovgenai', modelPath: '/m', device: 'NPU', contextLength: 8192 }));

    expect(matchFields('mlx', { kind: 'mlx', modelPath: '/m', contextLength: 4096 }))
      .toEqual(matchFields('mlx', { kind: 'mlx', modelPath: '/m', contextLength: 8192 }));
    expect(recordKey({ kind: 'mlx', modelPath: '/m', contextLength: 4096 }))
      .toBe(recordKey({ kind: 'mlx', modelPath: '/m', contextLength: 8192 }));
  });

  it('the pipe name is keyed by the match fields; tcp tokens are per-instance', () => {
    const a = localListenEndpoint(root, { kind: 'ovgenai', modelPath: '/m', device: 'NPU', contextLength: 4096 });
    const b = localListenEndpoint(root, { kind: 'ovgenai', modelPath: '/m', device: 'NPU', contextLength: 8192 });
    expect(a).not.toBe(b);
    expect(newToken()).not.toBe(newToken());
  });

  it('the unix socket endpoint stays within the 104-byte sun_path limit', () => {
    if (process.platform === 'win32') {
      return;
    }
    const endpoint = localListenEndpoint(join(root, 'a-very-long-globalstorage-path'), { kind: 'mlx', modelPath: '/m' });
    expect(endpoint.startsWith(tmpdir())).toBe(true);
    expect(Buffer.byteLength(endpoint)).toBeLessThanOrEqual(103);
  });

  it('ensureListenDir creates the socket parent directory and skips Windows pipes', async () => {
    if (process.platform !== 'win32') {
      const socket = join(root, 'nested', 'dir', 'runner-x.sock');
      await ensureListenDir(socket);
      await expect(readdir(join(root, 'nested', 'dir'))).resolves.toEqual([]);
    }
    await expect(ensureListenDir('\\\\.\\pipe\\tlc-runner-x')).resolves.toBeUndefined();
  });

  it('scan finds a written record with its options intact', async () => {
    const r = record();
    await writeRecord(root, r);
    const found = await scanRecords(root);
    expect(found).toHaveLength(1);
    expect(found[0].record.options).toEqual(r.options);
    expect(JSON.parse(await readFile(join(root, 'runners', `${r.options.kind}-${recordKey(r.options)}.json`), 'utf8')).token).toBe('t');
  });

  it('a matching record with a dead pid is reaped and skipped', async () => {
    await writeRecord(root, record({ pid: 0x4f4f4f4f }));
    const deadPidFile = join(root, 'runners', 'ovgenai-x.json');
    await writeFile(deadPidFile, JSON.stringify(record({ pid: 0x4f4f4f4f })));
    const match = await findLiveMatch(root, { kind: 'ovgenai', modelPath: '/m', device: 'NPU', contextLength: 4096 });
    expect(match).toBeUndefined();
  });

  it('a matching record with a live pid is returned; non-matching options are skipped', async () => {
    await writeRecord(root, record());
    const alive = await findLiveMatch(root, { kind: 'ovgenai', modelPath: '/m', device: 'NPU', contextLength: 4096 });
    expect(alive?.record.options.modelPath).toBe('/m');
    const mismatch = await findLiveMatch(root, { kind: 'ovgenai', modelPath: '/m', device: 'NPU', contextLength: 8192 });
    expect(mismatch).toBeUndefined();
    const mlxMismatch = await findLiveMatch(root, { kind: 'mlx', modelPath: '/m' });
    expect(mlxMismatch).toBeUndefined();
  });
});
