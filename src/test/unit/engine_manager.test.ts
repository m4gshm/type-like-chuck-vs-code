import { EventEmitter } from 'events';
import { mkdir, mkdtemp as mkdtempActual, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineManager, EngineManagerHost, EngineManagerSettings, EngineStatus, ENGINE_STATUS } from '../../local_engine/engine_manager';
import { DownloadProgress } from '../../local_engine/downloader';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  args: string[];
  killed = false;

  constructor(args: string[]) {
    super();
    this.args = args;
  }

  kill(): void {
    this.killed = true;
    this.exitCode = 0;
    this.emit('close', 0);
  }
}

interface Fixture {
  host: EngineManagerHost;
  statuses: EngineStatus[];
  downloads: Array<{ url: string; destination: string }>;
  extracts: Array<{ archivePath: string; destDir: string }>;
  spawned: Array<{ child: FakeChild; env: NodeJS.ProcessEnv }>;
  root: string;
  notify: string[];
}

const settings = (overrides: Partial<EngineManagerSettings> = {}): EngineManagerSettings => ({
  modelId: '1.5b',
  device: 'auto',
  engineKind: 'llama.cpp',
  npuContextLength: 8192,
  releaseTag: 'b1',
  engineBinary: '',
  distroDir: '',
  huggingfaceUrl: 'https://huggingface.co',
  githubUrl: 'https://github.com',
  openvinoUrl: 'https://storage.openvinotoolkit.org',
  modelPath: '',
  modelUrls: {},
  apiKeyEnabled: true,
  ...overrides,
});

const makeFixture = async (
  overrides: Partial<EngineManagerHost> = {},
  settingsOverrides: Partial<EngineManagerSettings> = {},
  
): Promise<Fixture> => {
  const root = await mkdtempActual(join(tmpdir(), 'tlc-enginetest-'));
  const statuses: EngineStatus[] = [];
  const downloads: Fixture['downloads'] = [];
  const extracts: Fixture['extracts'] = [];
  const spawned: Fixture['spawned'] = [];
  const notify: string[] = [];
  const base: EngineManagerSettings = settings(settingsOverrides);
  const host: EngineManagerHost & { settings: () => EngineManagerSettings } = {
    platform: 'win32',
    arch: 'x64',
    paths: () => ({ engineRoot: join(root, 'engine'), modelDir: join(root, 'models'), modelCacheDir: join(root, 'cache') }),
    settings: () => base,
    onStatus: (s) => statuses.push(s),
    onProgress: undefined,
    notify: (m) => notify.push(m),
    warn: () => undefined,
    log: () => undefined,
    
    fetchImpl: (async () => new Response('{}', { status: 200 })) as never,
    spawnImpl: ((_: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      const child = new FakeChild(args);
      spawned.push({ child, env: opts.env });
      return child;
    }) as never,
    delayImpl: async () => undefined,
    pickPort: async () => 41000,
    download: (async (opts: { url: string; destination: string; onProgress?: (p: DownloadProgress) => void }) => {
      downloads.push({ url: opts.url, destination: opts.destination });
      opts.onProgress?.({ downloadedBytes: 10, totalBytes: 10 });
      await mkdir(join(opts.destination, '..'), { recursive: true });
      await writeFile(opts.destination, 'archive');
    }) as never,
    extract: (async (opts: { archivePath: string; destDir: string }) => {
      extracts.push({ archivePath: opts.archivePath, destDir: opts.destDir });
      await mkdir(opts.destDir, { recursive: true });
      await writeFile(join(opts.destDir, host.platform === 'win32' ? 'llama-server.exe' : 'llama-server'), 'bin');
    }) as never,
    ...overrides,
  };
  return { host, statuses, downloads, extracts, spawned, root, notify };
};

const last = (statuses: EngineStatus[]): EngineStatus => statuses[statuses.length - 1];

describe('EngineManager (llama.cpp engine)', () => {
  it('downloads engine and model once, then starts the server ready on gpu', async () => {
    const f = await makeFixture();
    const manager = new EngineManager(f.host);
    const status = await manager.ensureReady();
    expect(f.downloads.map((d) => d.url)).toEqual([
      'https://github.com/ggml-org/llama.cpp/releases/download/b1/llama-b1-bin-win-vulkan-x64.zip',
      'https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
    ]);
    expect(f.statuses.map((s) => s.status)).toEqual([ENGINE_STATUS.preparingEngine, ENGINE_STATUS.preparingModel, ENGINE_STATUS.starting, ENGINE_STATUS.ready]);
    expect(status).toMatchObject({ status: 'ready', model: '1.5b', device: 'gpu' });
    const args = f.spawned[0].child.args;
    expect(args.join(' ')).toContain('qwen2.5-coder-1.5b-instruct-q4_k_m.gguf');
    expect(args.indexOf('-ngl')).toBeGreaterThanOrEqual(0);
    expect(args[args.indexOf('-ngl') + 1]).toBe('999');

    await manager.stop();
    expect(f.spawned[0].child.killed).toBe(true);
  });

  it('restarts the engine automatically after a crash and guards against crash loops', async () => {
    const children: FakeChild[] = [];
    const f = await makeFixture({
      warn: vi.fn(),
      spawnImpl: ((_: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
        const child = new FakeChild(args);
        children.push(child);
        return child;
      }) as never,
    });
    const manager = new EngineManager(f.host);
    await manager.ensureReady();
    expect(children).toHaveLength(1);

    // Simulate a crash of the healthy server: the manager must bring it back.
    children[0].emit('close', 1, null);
    await vi.waitFor(() => expect(children.length).toBe(2));
    expect(last(f.statuses).status).toBe('ready');
    expect(f.host.warn).toHaveBeenCalledWith(expect.stringContaining('exited (code 1); restarting'));

    // Crash loop: the 4th accepted crash within a minute → error, no restart.
    const m = manager as unknown as { handleUnexpectedExit: (message: string) => void };
    for (let i = 0; i < 5; i++) {
      const before = children.length;
      m.handleUnexpectedExit(`llama-server exited (code 1), crash ${i + 2}`);
      await vi.waitFor(() => f.statuses.some((s) => s.status === 'error') || children.length > before, { timeout: 5000 });
      if (f.statuses.some((s) => s.status === 'error')) {
        break;
      }
      await manager.ensureReady();
    }
    // The guard tripped: an error status was reported and spawning stopped.
    expect(f.statuses.some((s) => s.status === 'error')).toBe(true);
    const after = children.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(children.length).toBe(after);
  });

  it('spawns without OpenVINO env for the vulkan build', async () => {
    const f = await makeFixture();
    await new EngineManager(f.host).ensureReady();
    const envKeys = Object.keys(f.spawned[0].env).filter((k) => k.startsWith('GGML_OPENVINO_'));
    expect(envKeys).toEqual([]);
  });

  it('does not re-download when engine and model are already present', async () => {
    const f = await makeFixture();
    await new EngineManager(f.host).ensureReady();
    const second = await new EngineManager(f.host).ensureReady();
    expect(second.status).toBe('ready');
    expect(f.downloads.length).toBe(2);
    expect(f.extracts.length).toBe(1);
  });

  it('runs llama-server without a key when apiKeyEnabled is false (debugging)', async () => {
    const f = await makeFixture({}, { apiKeyEnabled: false });
    const status = await new EngineManager(f.host).ensureReady();
    expect(status.status).toBe('ready');
    if (status.status !== 'ready') {
      throw new Error('unreachable');
    }
    expect(status.apiKey).toBeUndefined();
    expect(f.spawned[0].child.args).not.toContain('--api-key');
  });

  it('honors mirror base urls, per-model url overrides and a local model path', async () => {
    const mirrored = await makeFixture({}, {
      modelId: '0.5b',
      releaseTag: 'b2',
      engineBinary: '',
      huggingfaceUrl: 'https://hf-mirror.internal',
      githubUrl: 'https://ghmirror.internal',
    });
    await new EngineManager(mirrored.host).ensureReady();
    expect(mirrored.downloads[0].url).toBe('https://ghmirror.internal/ggml-org/llama.cpp/releases/download/b2/llama-b2-bin-win-vulkan-x64.zip');
    expect(mirrored.downloads[1].url).toBe('https://hf-mirror.internal/bartowski/Qwen2.5-Coder-0.5B-GGUF/resolve/main/Qwen2.5-Coder-0.5B-Q4_K_M.gguf');

    const overridden = await makeFixture({}, {
      modelUrls: { '1.5b': 'https://example.org/moved-model.gguf' },
    });
    await new EngineManager(overridden.host).ensureReady();
    expect(overridden.downloads.at(-1)?.url).toBe('https://example.org/moved-model.gguf');

    const localFile = join((await import('os')).tmpdir(), `tlc-local-${Date.now()}.gguf`);
    await writeFile(localFile, 'gguf');
    const offline = await makeFixture({}, { modelPath: localFile });
    await new EngineManager(offline.host).ensureReady();
    expect(offline.downloads.filter((d) => d.url.includes('gguf')).length).toBe(0);
    expect(offline.spawned[0].child.args.join(' ')).toContain(localFile);
    await rm(localFile, { force: true });
  });

  it('uses a locally unpacked engine binary and skips the engine download', async () => {
    const localEngine = join(await mkdtempActual(join((await import('os')).tmpdir(), 'tlc-enginetest-')), 'llama-server.exe');
    await writeFile(localEngine, 'bin');
    const f = await makeFixture({}, { engineBinary: localEngine });
    const status = await new EngineManager(f.host).ensureReady();
    expect(status).toMatchObject({ status: 'ready' });
    expect(f.downloads.length).toBe(1);
    expect(f.extracts.length).toBe(0);
    await new EngineManager(f.host).stop();
  });

  it('uses a local llama.cpp distribution folder and skips the engine download', async () => {
    const distro = await mkdtempActual(join((await import('os')).tmpdir(), 'tlc-distro-'));
    await writeFile(join(distro, 'llama-server.exe'), 'bin');
    const f = await makeFixture({}, { distroDir: distro });
    const status = await new EngineManager(f.host).ensureReady();
    expect(status).toMatchObject({ status: 'ready' });
    expect(f.downloads.length).toBe(1);
    expect(f.downloads[0].url).toContain('gguf');
    expect(f.extracts.length).toBe(0);
    expect(f.downloads.filter((d) => d.url.includes('vulkan') || d.url.includes('openvino'))).toHaveLength(0);
    await new EngineManager(f.host).stop();
  });

  it('fails on a local llama.cpp distribution folder with an unexpected layout', async () => {
    const distro = await mkdtempActual(join((await import('os')).tmpdir(), 'tlc-distro-empty-'));
    const f = await makeFixture({}, { distroDir: distro });
    await expect(new EngineManager(f.host).ensureReady()).rejects.toThrow(/unexpected layout.*llama-server/s);
    expect(last(f.statuses)).toMatchObject({ status: 'error' });
  });

  it('reports an error when the local engine binary is missing', async () => {
    const f = await makeFixture({}, { engineBinary: join('nowhere', 'llama-server.exe') });
    await expect(new EngineManager(f.host).ensureReady()).rejects.toThrow(/Local engine binary not found/);
    expect(last(f.statuses).status).toBe('error');
  });

  it('warns when the resolved model is not a Qwen2.5-Coder catalog entry', async () => {
    const localFile = join((await import('os')).tmpdir(), `tlc-custom-${Date.now()}.gguf`);
    await writeFile(localFile, 'gguf');
    const warns: string[] = [];
    const offline = await makeFixture({ warn: (m) => warns.push(m) }, { modelPath: localFile });
    await new EngineManager(offline.host).ensureReady();
    expect(warns.some((w) => /not a Qwen2\.5-Coder catalog entry/.test(w))).toBe(true);
    await rm(localFile, { force: true });

    const catalog = await makeFixture({ warn: (m) => warns.push(m) });
    const countBefore = warns.length;
    await new EngineManager(catalog.host).ensureReady();
    expect(warns.slice(countBefore).some((w) => /not a Qwen2\.5-Coder catalog entry/.test(w))).toBe(false);
    await new EngineManager(catalog.host).stop();
  });

  it('restart picks a changed model and skips its download when cached', async () => {
    const f = await makeFixture();
    const manager = new EngineManager(f.host);
    await manager.ensureReady();
    const base = f.host.settings;
    f.host.settings = () => ({ ...base(), modelId: '3b' });
    await manager.restart();
    expect(f.downloads.filter((d) => d.url.includes('gguf')).map((d) => d.url)).toEqual([
      'https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
      'https://huggingface.co/bartowski/Qwen2.5-Coder-3B-GGUF/resolve/main/Qwen2.5-Coder-3B-Q4_K_M.gguf',
    ]);
    expect(f.spawned[1].child.args.join(' ')).toContain('Qwen2.5-Coder-3B-Q4_K_M.gguf');
  });

  it.each(['engine', 'model', 'cache'] as const)('reset(%s) clears the target and restarts', async (target) => {
    const f = await makeFixture();
    const manager = new EngineManager(f.host);
    await manager.ensureReady();
    await manager.reset(target);
    const { existsSync } = await import('fs');
    if (target === 'cache') {
      expect(existsSync(join(f.root, 'cache'))).toBe(true);
    }
    expect(f.spawned.length).toBeGreaterThanOrEqual(2);
    expect(last(f.statuses).status).toBe('ready');
  });
});

describe('EngineManager (llama.cpp devices)', () => {
  it('redirects an explicit npu to gpu with a warning (the llama.cpp build has no NPU path)', async () => {
    const warns: string[] = [];
    const f = await makeFixture({ warn: (m) => warns.push(m) }, { device: 'npu' });
    const status = await new EngineManager(f.host).ensureReady();
    expect(status).toMatchObject({ status: 'ready', device: 'gpu' });
    expect(f.downloads[0].url).toContain('vulkan');
    expect(warns.some((w) => /NPU is supported only by the OpenVINO GenAI engine/.test(w))).toBe(true);
    await new EngineManager(f.host).stop();
  });

  it('auto on gpu falls back to cpu on the std build', async () => {
    const f = await makeFixture({});
    const spawned: FakeChild[] = [];
    f.host.spawnImpl = ((_: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      const child = new FakeChild(args);
      spawned.push(child);
      expect(opts.env.GGML_OPENVINO_DEVICE).toBeUndefined();
      if (spawned.length < 2) {
        child.exitCode = 1;
      }
      return child;
    }) as never;
    const status = await new EngineManager(f.host).ensureReady();
    expect(status).toMatchObject({ status: 'ready', device: 'cpu' });
    expect(f.downloads[0].url).not.toContain('openvino');
    expect(f.notify).toHaveLength(1);
    expect(f.notify[0]).toMatch(/started on CPU — GPU unavailable/);
    await new EngineManager(f.host).stop();
  });

  it('explicit npu on the std build falls back to cpu after gpu fails', async () => {
    const f = await makeFixture({}, { device: 'npu' });
    const spawned: FakeChild[] = [];
    f.host.spawnImpl = ((_: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      const child = new FakeChild(args);
      spawned.push(child);
      expect(opts.env.GGML_OPENVINO_DEVICE).toBeUndefined();
      if (spawned.length < 2) {
        child.exitCode = 1;
      }
      return child;
    }) as never;
    const status = await new EngineManager(f.host).ensureReady();
    expect(status).toMatchObject({ status: 'ready', device: 'cpu' });
    expect(f.downloads[0].url).toContain('vulkan');
    expect(f.notify).toHaveLength(1);
    expect(f.notify[0]).toMatch(/started on CPU — GPU unavailable/);
  });

});

afterEach(() => {
  vi.restoreAllMocks();
});
