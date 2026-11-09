import { spawnSync } from 'child_process';
import { createWriteStream } from 'fs';
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { extractArchive } from '../../local_engine/extract';

const dirs: string[] = [];
const tmp = async (): Promise<string> => {
  const dir = join(tmpdir(), `tlc-extract-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  while (dirs.length > 0) {
    await rm(dirs.pop() ?? '', { recursive: true, force: true });
  }
});

const makeZip = async (dest: string, files: Record<string, string>): Promise<void> => {
  const zipfile = new yazl.ZipFile();
  for (const [name, content] of Object.entries(files)) {
    zipfile.addBuffer(Buffer.from(content), name);
  }
  zipfile.end();
  await new Promise<void>((resolve, reject) => {
    zipfile.outputStream.pipe(createWriteStream(dest)).on('close', resolve).on('error', reject);
  });
};

describe('extractArchive', () => {
  it('unpacks a zip and writes the install marker', async () => {
    const dest = await tmp();
    const archive = join(dest, 'engine.zip');
    await writeFile(archive, Buffer.alloc(0));
    await makeZip(archive, { 'bin/llama-server.exe': 'stub', 'README.md': 'hi' });
    const progress: Array<[number, number | undefined]> = [];
    await extractArchive({ archivePath: archive, destDir: dest, onProgress: (a, b) => progress.push([a, b]) });
    expect(await readFile(join(dest, 'bin', 'llama-server.exe'), 'utf8')).toBe('stub');
    expect(progress[progress.length - 1]).toEqual([2, 2]);
  });

  it('unpacks a tar.gz', async () => {
    const src = await tmp();
    const dest = await tmp();
    await writeFile(join(src, 'hello.txt'), 'tarred');
    const archive = join(src, 'engine.tar.gz');
    const tar = spawnSync('tar', ['-czf', 'engine.tar.gz', '-C', src, 'hello.txt'], { cwd: src, windowsHide: true });
    if (tar.status !== 0) {
      throw new Error('tar is unavailable in this environment');
    }
    await extractArchive({ archivePath: archive, destDir: dest });
    expect(await readFile(join(dest, 'hello.txt'), 'utf8')).toBe('tarred');
  });

  it('removes the destination on cancelation and leaves no marker', async () => {
    const dest = await tmp();
    const archive = join(dest, 'engine.zip');
    await makeZip(archive, { 'bin/llama-server.exe': 'stub' });
    const controller = new AbortController();
    controller.abort();
    await expect(extractArchive({ archivePath: archive, destDir: dest, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    await expect(stat(dest)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects unknown archive formats', async () => {
    const dest = await tmp();
    const archive = join(dest, 'engine.rar');
    await writeFile(archive, Buffer.alloc(0));
    await expect(extractArchive({ archivePath: archive, destDir: dest })).rejects.toThrow(/Unsupported/);
    await expect(stat(dest)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
