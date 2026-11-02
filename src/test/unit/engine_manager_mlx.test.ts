import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineManager, EngineManagerHost, EngineManagerSettings, EngineStatus } from '../../local_engine/engine_manager';

class FakeRunnerChild extends EventEmitter {
  stdin = {
    write: vi.fn(() => true),
    end: vi.fn(),
  };
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  constructor(public args: string[], public env: NodeJS.ProcessEnv) {
    super();
  }

  kill(): void {
    this.killed = true;
    this.emit('close', 0);
  }
}

const last = (statuses: EngineStatus[]): EngineStatus => statuses[statuses.length - 1];

interface Fixture {
  host: EngineManagerHost;
  statuses: EngineStatus[];
  downloads: Array<{ url: string; destination: string }>;
  spawned: FakeRunnerChild[];
  root: string;
}

const MLX_FILES = ['config.json', 'model.safetensors', 'tokenizer.json', 'tokenizer_config.json', 'generation_config.json'];

const makeFixture = async (settingsOverrides: Partial<EngineManagerSettings> = {}): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), 'tlc-mlx-test-'));
  const statuses: EngineStatus[] = [];
  const downloads: Fixture['downloads'] = [];
  const spawned: FakeRunnerChild[] = [];
  const base: EngineManagerSettings = {
    modelId: 'Qwen2.5-Coder 1.5B',
    device: 'gpu',
    engineKind: 'mlx',
    npuContextLength: 8192,
    releaseTag: 'b1',
    distroDir: '',
    huggingfaceUrl: 'https://huggingface.co',
    githubUrl: 'https://github.com',
    openvinoUrl: 'https://storage.openvinotoolkit.org',
    modelPath: '',
    modelUrls: {},
    mlxRunnerPath: '/ext/binaries/mlx/darwin-arm64/tlc-mlx-runner',
    apiKeyEnabled: true,
    ...settingsOverrides,
  };
  const modelDir = join(root, 'models');
  const engineRoot = join(root, 'engine');
  await mkdir(modelDir, { recursive: true });
  await mkdir(engineRoot, { recursive: true });
  const modelPath = join(modelDir, 'mlx-community', 'Qwen2.5-Coder-1.5B-Instruct-4bit');
  await mkdir(modelPath, { recursive: true });
  for (const file of MLX_FILES) {
    await writeFile(join(modelPath, file), 'data');
  }
  const host: EngineManagerHost = {
    platform: 'darwin',
    arch: 'arm64',
    paths: () => ({ engineRoot, modelDir, modelCacheDir: join(root, 'cache') }),
    settings: () => base,
    onStatus: (s) => statuses.push(s),
    onProgress: undefined,
    notify: () => undefined,
    warn: () => undefined,
    log: () => undefined,
    download: (async (opts: { url: string; destination: string }) => {
      downloads.push({ url: opts.url, destination: opts.destination });
      await mkdir(join(opts.destination, '..'), { recursive: true });
      await writeFile(opts.destination, 'data');
    }) as never,
    extract: (async () => undefined) as never,
    spawnImpl: ((_path: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      const child = new FakeRunnerChild(args, opts.env);
      spawned.push(child);
      setTimeout(() => child.stdout.write(`${JSON.stringify({ type: 'ready', model: args[1], device: 'gpu', ctx: 32768 })}\n`), 0);
      return child;
    }) as never,
    delayImpl: async () => undefined,
    pickPort: async () => 0,
  };
  return { host, statuses, downloads, spawned, root };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EngineManager (mlx engine)', () => {
  it('starts the bundled runner with the mlx model and reports ready on gpu without an endpoint', async () => {
    const f = await makeFixture();
    const manager = new EngineManager(f.host);
    const status = await manager.ensureReady();
    expect(status).toMatchObject({ status: 'ready', model: 'Qwen2.5-Coder 1.5B', device: 'gpu', baseUrl: '', apiKey: undefined });
    expect(f.downloads).toHaveLength(0);
    expect(f.spawned[0].args).toEqual(['--model', expect.stringContaining('Qwen2.5-Coder-1.5B-Instruct-4bit'), '--ctx', '32768']);    expect(f.spawned[0].args).not.toContain('--device');
    expect(manager.stdioRunner()).toBeDefined();
    await manager.stop();
  });

  it('reports an error when no runner binary is bundled for the platform', async () => {
    const f = await makeFixture({ mlxRunnerPath: undefined });
    const manager = new EngineManager(f.host);
    await expect(manager.ensureReady()).rejects.toThrow('not bundled');
    expect(last(f.statuses).status).toBe('error');
  });

  it('downloads missing mlx model files from the mlx-community repo', async () => {
    const f = await makeFixture({ modelId: 'Qwen2.5-Coder 0.5B' });
    const manager = new EngineManager(f.host);
    await manager.ensureReady();
    expect(f.downloads.length).toBeGreaterThan(0);
    expect(f.downloads[0].url).toContain('mlx-community/Qwen2.5-Coder-0.5B-Instruct-4bit/resolve/main/');
    await manager.stop();
  });

  it('reset(model) re-downloads the mlx model directory', async () => {
    const f = await makeFixture({ modelId: 'Qwen2.5-Coder 0.5B' });
    const manager = new EngineManager(f.host);
    await manager.ensureReady();
    const downloadsBefore = f.downloads.length;
    const { rmSync } = await import('fs');
    rmSync(join(f.root, 'models', 'mlx-community', 'Qwen2.5-Coder-0.5B-Instruct-4bit'), { recursive: true, force: true });
    await manager.reset('model');
    expect(f.downloads.length).toBeGreaterThan(downloadsBefore);
    const { existsSync } = await import('fs');
    expect(existsSync(join(f.root, 'models', 'mlx-community', 'Qwen2.5-Coder-0.5B-Instruct-4bit', 'model.safetensors'))).toBe(true);
    await manager.stop();
  });
});
