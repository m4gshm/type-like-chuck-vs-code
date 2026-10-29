import { spawn } from 'child_process';
import { mkdir, rm, writeFile } from 'fs/promises';
import { dirname, join, parse, relative } from 'path';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import type { ZipFile } from 'yauzl';
import yauzl from 'yauzl';

export const INSTALL_MARKER = '.tlc-installed';

export interface ExtractOptions {
  archivePath: string;
  destDir: string;
  signal?: AbortSignal;
  onProgress?: (extracted: number, total: number | undefined) => void;
}

function openZip(archivePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err || zipfile === undefined) {
        reject(err ?? new Error('Cannot open the archive'));
      } else {
        resolve(zipfile);
      }
    });
  });
}

function openEntryStream(zipfile: ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || stream === undefined) {
        reject(err ?? new Error(`Cannot read entry ${entry.fileName}`));
      } else {
        resolve(stream);
      }
    });
  });
}

function isUnsafePath(name: string): boolean {
  return name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split(/[\\/]/).includes('..');
}

async function extractZip(archivePath: string, destDir: string, onProgress?: ExtractOptions['onProgress'], signal?: AbortSignal): Promise<void> {
  const zipfile = await openZip(archivePath);
  await mkdir(destDir, { recursive: true });
  const total = zipfile.entryCount;
  let extracted = 0;
  return new Promise<void>((resolve, reject) => {
    const fail = (err: Error) => {
      if (zipfile.isOpen) {
        zipfile.close();
      }
      reject(err);
    };
    zipfile.on('error', fail);
    zipfile.on('entry', (entry: yauzl.Entry) => {
      if (signal?.aborted) {
        fail(new DOMException('Download canceled', 'AbortError'));
        return;
      }
      if (isUnsafePath(entry.fileName)) {
        extracted += 1;
        zipfile.readEntry();
        return;
      }
      const target = join(destDir, entry.fileName);
      const finishEntry = () => {
        extracted += 1;
        onProgress?.(extracted, total);
        zipfile.readEntry();
      };
      if (entry.fileName.endsWith('/') || entry.fileName.endsWith('\\')) {
        mkdir(target, { recursive: true }).then(finishEntry).catch(fail);
        return;
      }
      mkdir(dirname(target), { recursive: true })
        .then(() => openEntryStream(zipfile, entry))
        .then((stream) => pipeline(stream, createWriteStream(target)))
        .then(finishEntry)
        .catch(fail);
    });
    zipfile.on('end', () => resolve());
    zipfile.readEntry();
  });
}

async function extractTar(archivePath: string, destDir: string, signal?: AbortSignal): Promise<void> {
  await mkdir(destDir, { recursive: true });
  // Run from destDir with a relative archive path: GNU tar treats "C:\..."
  // arguments as remote host:path specs regardless of --force-local on -C.
  const { dir, base } = parse(archivePath);
  const archiveRef = join(relative(destDir, dir), base);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archiveRef, '-C', '.'], { cwd: destDir, signal, windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar exited with code ${code}: ${stderr.trim()}`));
      }
    });
  });
}

/**
 * Unpacks a .zip or .tar.gz into destDir and writes the install marker on
 * success. On failure or cancelation the destination directory is removed so
 * no partial install can be mistaken for a complete one.
 */
export async function extractArchive({ archivePath, destDir, signal, onProgress }: ExtractOptions): Promise<void> {
  try {
    const lower = archivePath.toLowerCase();
    if (lower.endsWith('.zip')) {
      await extractZip(archivePath, destDir, onProgress, signal);
    } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
      await extractTar(archivePath, destDir, signal);
      onProgress?.(1, 1);
    } else {
      throw new Error(`Unsupported archive format: ${archivePath}`);
    }
    if (signal?.aborted) {
      throw new DOMException('Download canceled', 'AbortError');
    }
    await writeFile(join(destDir, INSTALL_MARKER), '');
  } catch (err) {
    await rm(destDir, { recursive: true, force: true });
    throw err;
  }
}
