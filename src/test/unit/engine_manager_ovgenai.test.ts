import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdir, rm, writeFile } from 'fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineManager, EngineManagerHost, EngineManagerSettings, EngineStatus } from '../../local_engine/engine_manager';
import { OV_GENAI_VERSION, ovGenaiLibDir } from '../../local_engine/ov_runtime';

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

const makeFixture = async (settingsOverrides: Partial<EngineManagerSettings> = {}): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), 'tlc-ovgenai-test-'));
  const statuses: EngineStatus[] = [];
  const downloads: Fixture['downloads'] = [];
  const spawned: FakeRunnerChild[] = [];
  const base: EngineManagerSettings = {
    modelId: '1.5b',
    device: 'auto',
    engineKind: 'ovgenai',
    npuContextLength: 8192,
    releaseTag: 'b1',
    engineBinary: '',
    distroDir: '',
    huggingfaceUrl: 'https://huggingface.co',
    githubUrl: 'https://github.com',
    openvinoUrl: 'https://storage.openvinotoolkit.org',
    modelPath: '',
    modelUrls: {},
    ovgenaiRunnerPath: '/ext/binaries/ovgenai/linux-x64/tlc-ovgenai-runner',
    apiKeyEnabled: true,
    ...settingsOverrides,
  };
  const modelDir = join(root, 'models');
  const engineRoot = join(root, 'engine');
  await mkdir(modelDir, { recursive: true });
  await mkdir(engineRoot, { recursive: true });
  // Pre-create the runtime libs and the IR model so no download is needed.
  const libDir = join(engineRoot, `ov-genai-${OV_GENAI_VERSION}`, `openvino_genai_ubuntu22_${OV_GENAI_VERSION}_x86_64`, 'runtime', 'lib', 'intel64');
  await mkdir(libDir, { recursive: true });
  await writeFile(join(libDir, 'libopenvino.so'), 'lib');
  const modelPath = join(modelDir, '1.5b-int8-ov');
  await mkdir(modelPath, { recursive: true });
  for (const file of ['openvino_model.xml', 'openvino_model.bin', 'openvino_tokenizer.xml', 'openvino_tokenizer.bin', 'openvino_detokenizer.xml', 'openvino_detokenizer.bin', 'tokenizer.json']) {
    await writeFile(join(modelPath, file), 'data');
  }
  const host: EngineManagerHost = {
    platform: 'linux',
    arch: 'x64',
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
      setTimeout(() => child.stdout.write(`${JSON.stringify({ type: 'ready', model: args[1], device: 'GPU', ctx: 32768 })}\n`), 0);
      return child;
    }) as never,
    delayImpl: async () => undefined,
    pickPort: async () => 0,
    // Avoids the real --version probe: the fake engine child never closes, and
    // the probe process would otherwise become spawned[0].
    probeRunnerVersion: async () => ({ app: 'test-runner', ovGenai: OV_GENAI_VERSION }),
  };
  return { host, statuses, downloads, spawned, root };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EngineManager (ovgenai engine)', () => {
  it('starts the bundled runner with the IR model and reports ready without an endpoint', async () => {
    const f = await makeFixture();
    const manager = new EngineManager(f.host);
    const status = await manager.ensureReady();
    expect(status).toMatchObject({ status: 'ready', model: '1.5b', device: 'gpu', baseUrl: '', apiKey: undefined });
    expect(f.downloads).toHaveLength(0);
    expect(f.spawned[0].args).toEqual(['--model', expect.stringContaining('1.5b-int8-ov'), '--device', 'GPU', '--ctx', '32768']);
    expect(manager.stdioRunner()).toBeDefined();
    await manager.stop();
  });

  it('restarts the runner when the model changes', async () => {
    const f = await makeFixture();
    const manager = new EngineManager(f.host);
    await manager.ensureReady();
    const before = f.spawned.length;
    const settings = f.host.settings();
    (settings as { modelId: string }).modelId = '0.5b';
    const modelPath = join(f.root, 'models', '0.5b-int8-ov');
    const { mkdir: mk, writeFile: wf } = await import('fs/promises');
    await mk(modelPath, { recursive: true });
    for (const file of ['openvino_model.xml', 'openvino_model.bin', 'openvino_tokenizer.xml', 'openvino_tokenizer.bin', 'openvino_detokenizer.xml', 'openvino_detokenizer.bin', 'tokenizer.json']) {
      await wf(join(modelPath, file), 'data');
    }
    await manager.restart();
    expect(f.spawned.length).toBe(before + 1);
    expect(last(f.statuses).status).toBe('ready');
    await manager.stop();
  });

  it('falls back to CPU when the requested device fails to start', async () => {
    const f = await makeFixture({ device: 'npu' });
    let first = true;
    f.host.spawnImpl = ((_path: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      const child = new FakeRunnerChild(args, opts.env);
      f.spawned.push(child);
      setTimeout(() => {
        if (first && args.includes('NPU')) {
          first = false;
          child.emit('close', 1);
          return;
        }
        child.stdout.write(`${JSON.stringify({ type: 'ready', model: args[1], device: 'CPU', ctx: 32768 })}\n`);
      }, 0);
      return child;
    }) as never;
    const manager = new EngineManager(f.host);
    const status = await manager.ensureReady();
    expect(status).toMatchObject({ status: 'ready', device: 'cpu' });
    await manager.stop();
  });

  it('reports an error when no runner binary is bundled for the platform', async () => {
    const f = await makeFixture({ ovgenaiRunnerPath: undefined });
    const manager = new EngineManager(f.host);
    await expect(manager.ensureReady()).rejects.toThrow('not bundled');
    expect(last(f.statuses).status).toBe('error');
  });

  it('cancels the preparation when the distro question is dismissed', async () => {
    const f = await makeFixture();
    await rm(join(f.root, 'engine'), { recursive: true, force: true }); // no runtime present
    f.host.askDistroOrDownload = async () => undefined;
    const manager = new EngineManager(f.host);
    await expect(manager.ensureReady()).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.downloads).toHaveLength(0);
  });

  it('uses the folder picked in the distro question instead of downloading', async () => {
    const f = await makeFixture();
    await rm(join(f.root, 'engine'), { recursive: true, force: true }); // no runtime present
    const picked = await mkdtemp(join(tmpdir(), 'tlc-ov-picked-'));
    await mkdir(join(picked, 'runtime', 'lib', 'intel64'), { recursive: true });
    await writeFile(join(picked, 'runtime', 'lib', 'intel64', 'libopenvino.so'), 'lib');
    f.host.askDistroOrDownload = async () => picked;
    const manager = new EngineManager(f.host);
    const status = await manager.ensureReady();
    expect(status).toMatchObject({ status: 'ready' });
    expect(f.downloads).toHaveLength(0);
    await manager.stop();
  });

  it('uses a local OpenVINO GenAI distribution folder and skips the runtime download', async () => {
    const distro = await mkdtemp(join(tmpdir(), 'tlc-ov-distro-'));
    const libDir = ovGenaiLibDir('linux', distro);
    await mkdir(join(distro, 'runtime', 'lib', 'intel64'), { recursive: true });
    await writeFile(join(distro, 'runtime', 'lib', 'intel64', 'libopenvino.so'), 'lib');
    const f = await makeFixture({ distroDir: distro });
    const manager = new EngineManager(f.host);
    const status = await manager.ensureReady();
    expect(status).toMatchObject({ status: 'ready' });
    expect(f.downloads).toHaveLength(0);
    expect(f.spawned[0].env.LD_LIBRARY_PATH).toContain(libDir);
    await manager.stop();
  });

  it('fails on a local OpenVINO GenAI distribution folder with an unexpected layout', async () => {
    const distro = await mkdtemp(join(tmpdir(), 'tlc-ov-distro-empty-'));
    const f = await makeFixture({ distroDir: distro });
    await expect(new EngineManager(f.host).ensureReady()).rejects.toThrow(/unexpected layout/);
    expect(last(f.statuses).status).toBe('error');
  });

  it('negotiates the runtime version from the runner binary marker', async () => {
    // A runner built against a newer OpenVINO GenAI embeds its version; the
    // engine must download/use the matching runtime folder, not the pin.
    const runnerPath = join(await mkdtemp(join(tmpdir(), 'tlc-ovgenai-runner-')), 'tlc-ovgenai-runner');
    await writeFile(runnerPath, Buffer.concat([Buffer.alloc(64, 0x90), Buffer.from('ovgenai-runtime-version: 2026.5.0.0\0')]));
    const f = await makeFixture({ ovgenaiRunnerPath: runnerPath });
    const negotiated = `ov-genai-2026.5.0.0`;
    const libDir = ovGenaiLibDir('linux', join(f.root, 'engine', negotiated, 'openvino_genai_ubuntu22_2026.5.0.0_x86_64'));
    await mkdir(libDir, { recursive: true });
    await writeFile(join(libDir, 'libopenvino.so'), 'lib');
    const manager = new EngineManager(f.host);
    const status = await manager.ensureReady();
    expect(status).toMatchObject({ status: 'ready' });
    expect(f.downloads).toHaveLength(0);
    expect(f.spawned[0].env.LD_LIBRARY_PATH).toContain(libDir);
    await manager.stop();
  });

  it('downloads the runtime archive when the lib dir is missing', async () => {
    const f = await makeFixture();
    const { rm } = await import('fs/promises');
    const libDir = join(f.root, 'engine', `ov-genai-${OV_GENAI_VERSION}`, `openvino_genai_ubuntu22_${OV_GENAI_VERSION}_x86_64`, 'runtime', 'lib', 'intel64');
    await rm(libDir, { recursive: true, force: true });
    f.host.extract = (async (opts: { archivePath: string; destDir: string }) => {
      const lib = join(opts.destDir, `openvino_genai_ubuntu22_${OV_GENAI_VERSION}_x86_64`, 'runtime', 'lib', 'intel64');
      const { mkdir: mk, writeFile: wf } = await import('fs/promises');
      await mk(lib, { recursive: true });
      await wf(join(lib, 'libopenvino.so'), 'lib');
    }) as never;
    const manager = new EngineManager(f.host);
    await manager.ensureReady();
    expect(f.downloads.some((d) => d.url.includes(`openvino_genai_ubuntu22_${OV_GENAI_VERSION}_x86_64.tar.gz`))).toBe(true);
    await manager.stop();
  });
});
