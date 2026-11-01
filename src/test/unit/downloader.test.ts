import { createServer, Server } from 'http';
import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { downloadFile, proxyUrlFromEnv } from '../../local_engine/downloader';

describe('downloadFile', () => {
  let server: Server;
  let baseUrl: string;
  let dir: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/file') {
        const body = Buffer.from('0123456789'.repeat(100));
        res.writeHead(200, { 'content-length': body.length });
        res.end(body);
      } else if (req.url === '/hang') {
        res.writeHead(200);
        res.write('chunk');
        req.on('close', () => res.destroy());
      } else if (req.url === '/drop') {
        // Server-side connection drop mid-body: content-length promises more
        // data than is ever sent.
        res.writeHead(200, { 'content-length': 1000 });
        res.write('chunk');
        setTimeout(() => res.destroy(), 50);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
    dir = await mkdtemp(join(tmpdir(), 'tlc-download-'));
  });

  afterAll(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('downloads to the destination with progress events', async () => {
    const destination = join(dir, 'file.bin');
    const progress: Array<{ downloadedBytes: number; totalBytes: number | undefined }> = [];
    await downloadFile({ url: `${baseUrl}/file`, destination, onProgress: (p) => progress.push(p) });
    expect(await readFile(destination, 'utf8')).toBe('0123456789'.repeat(100));
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toMatchObject({ downloadedBytes: 1000, totalBytes: 1000 });
    await expect(stat(`${destination}.part`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes the part file and destination on failure', async () => {
    const destination = join(dir, 'missing.bin');
    await expect(downloadFile({ url: `${baseUrl}/nope`, destination })).rejects.toThrow(/404/);
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(`${destination}.part`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans up when canceled mid-stream', async () => {
    const destination = join(dir, 'hang.bin');
    const controller = new AbortController();
    const pending = downloadFile({ url: `${baseUrl}/hang`, destination, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(`${destination}.part`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('wraps a server-side mid-stream connection drop with context', async () => {
    const destination = join(dir, 'drop.bin');
    await expect(downloadFile({ url: `${baseUrl}/drop`, destination })).rejects.toThrow(/Download failed after \d+ bytes: .+ \(.+\/drop\)/);
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(`${destination}.part`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('downloads through an HTTPS proxy when HTTPS_PROXY is set', async () => {
    // Minimal absolute-form HTTP proxy: forwards GET requests to the target.
    const proxy = createServer((req, res) => {
      const target = new URL(req.url ?? '/');
      const request = target.protocol === 'https:' ? require('node:https').get(target) : require('node:http').get(target);
      request.on('response', (up: import('http').IncomingMessage) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      request.on('error', () => {
        res.writeHead(502);
        res.end();
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    const proxyPort = typeof address === 'object' && address !== null ? address.port : 0;
    const previous = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
    try {
      const destination = join(dir, 'via-proxy.bin');
      await downloadFile({ url: `${baseUrl}/file`, destination });
      expect(await readFile(destination, 'utf8')).toBe('0123456789'.repeat(100));
      expect(proxyUrlFromEnv()).toBe(process.env.HTTPS_PROXY);
    } finally {
      if (previous === undefined) {
        delete process.env.HTTPS_PROXY;
      } else {
        process.env.HTTPS_PROXY = previous;
      }
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});
