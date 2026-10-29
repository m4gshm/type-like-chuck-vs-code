import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDirectory, resolveEnginePaths } from '../../local_engine/paths';

const dirs: string[] = [];
const tmp = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'tlc-paths-'));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  while (dirs.length > 0) {
    await rm(dirs.pop() ?? '', { recursive: true, force: true });
  }
});

describe('resolveEnginePaths', () => {
  it('falls back to the global storage root when settings are empty', () => {
    const paths = resolveEnginePaths({ engineDir: '', modelDir: '', modelCacheDir: '' }, '/store');
    expect(paths.engineRoot).toBe(join('/store', 'engine'));
    expect(paths.modelDir).toBe(join('/store', 'models'));
    expect(paths.modelCacheDir).toBe(join('/store', 'ov-cache'));
  });

  it('honors explicit directories', () => {
    const paths = resolveEnginePaths({ engineDir: '/e', modelDir: '/m', modelCacheDir: '/c' }, '/store');
    expect(paths).toEqual({ engineRoot: '/e', modelDir: '/m', modelCacheDir: '/c' });
  });
});

describe('migrateDirectory', () => {
  it('moves content to an absent destination and removes the old directory', async () => {
    const old = await tmp();
    await mkdir(join(old, 'engine'));
    await writeFile(join(old, 'engine', 'llama-server.exe'), 'bin');
    const parent = await tmp();
    const moved = await migrateDirectory(join(old, 'engine'), join(parent, 'engine'));
    expect(moved).toBe(join(parent, 'engine'));
    expect(await readFile(join(parent, 'engine', 'llama-server.exe'), 'utf8')).toBe('bin');
    expect(existsSync(join(old, 'engine'))).toBe(false);
  });

  it('keeps existing content when the destination is populated', async () => {
    const old = await tmp();
    const dest = await tmp();
    await writeFile(join(old, 'a.txt'), 'old');
    await writeFile(join(dest, 'b.txt'), 'new');
    expect(await migrateDirectory(old, dest)).toBeUndefined();
    expect(await readFile(join(dest, 'b.txt'), 'utf8')).toBe('new');
    expect(await readFile(join(old, 'a.txt'), 'utf8')).toBe('old');
  });

  it('is a no-op for the same path or missing source', async () => {
    const dir = await tmp();
    expect(await migrateDirectory(dir, dir)).toBeUndefined();
    expect(await migrateDirectory(join(dir, 'missing'), join(dir, 'other'))).toBeUndefined();
  });

  it('migrates into an existing empty destination', async () => {
    const old = await tmp();
    await writeFile(join(old, 'm.gguf'), 'model');
    const dest = await tmp();
    expect(await migrateDirectory(old, dest)).toBe(dest);
    expect((await readdir(dest)).sort()).toEqual(['m.gguf']);
  });
});
