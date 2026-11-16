import net from 'net';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { EngineManager, EngineManagerHost, EngineManagerSettings } from '../../local_engine/engine_manager';
import { ENGINE_STATUS, EngineStatus } from '../../local_engine/engine_status';
import { OV_GENAI_VERSION } from '../../local_engine/ov_runtime';
import { writeRecord } from '../../local_engine/runner_discovery';
import { defaultEngineManagerSettings, FakeRunnerChild } from './fixtures';

/** FakeRunnerChild whose stdin.end() ends the process (listen-mode stop waits for close). */
class ListenFakeChild extends FakeRunnerChild {
  constructor(args: string[], env: NodeJS.ProcessEnv) {
    super(args, env);
    this.stdin.end = (() => {
      setTimeout(() => this.emit('close', 0), 0);
    }) as unknown as FakeRunnerChild['stdin']['end'];
  }
}

type ReadyStatus = Extract<EngineStatus, { status: typeof ENGINE_STATUS.ready }>;

const readyStatus = async (manager: EngineManager): Promise<ReadyStatus> => {
  const s = await manager.ensureReady();
  expect(s.status).toBe(ENGINE_STATUS.ready);
  return s as ReadyStatus;
};

/** Speaks the shared-runner server side: skips auth (pipe semantics), sends ready. */
class FakeSharedRunner {
  readonly server = net.createServer();
  port = 0;

  constructor(private readonly model: string) {}

  async listen(): Promise<number> {
    return await new Promise((resolve) => {
      this.server.on('error', () => undefined);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as net.AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  serve(): void {
    this.server.on('connection', (socket) => {
      socket.on('error', () => undefined);
      socket.setEncoding('utf8');
      socket.write(JSON.stringify({ type: 'ready', model: this.model, device: 'NPU', pid: process.pid, port: this.port }) + '\n');
    });
  }

  close(): void {
    this.server.close();
  }
}

interface Fixture {
  host: EngineManagerHost;
  spawned: FakeRunnerChild[];
  root: string;
  engineRoot: string;
  modelPath: string;
  shared: FakeSharedRunner;
  /** Makes the first connect (the adoption attempt) fail with ENOENT. */
  rejectFirstConnect: boolean;
}

const makeFixture = async (
  settingsOverrides: Partial<EngineManagerSettings> = {},
  spawnImpl?: EngineManagerHost['spawnImpl'],
): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), 'tlc-shared-test-'));
  const engineRoot = join(root, 'engine');
  const modelDir = join(root, 'models');
  await mkdir(engineRoot, { recursive: true });
  await mkdir(modelDir, { recursive: true });
  const libDir = join(engineRoot, `openvino_genai_ubuntu22_${OV_GENAI_VERSION}_x86_64`, 'runtime', 'lib', 'intel64');
  await mkdir(libDir, { recursive: true });
  await writeFile(join(libDir, 'libopenvino.so'), 'lib');
  // NPU → nf4 format: this is the catalog path the manager will request.
  const modelPath = join(modelDir, 'm4gshm', 'Qwen2.5-Coder-1.5B-nf4-sym-g-1-se-awq');
  await mkdir(modelPath, { recursive: true });
  for (const file of ['openvino_model.xml', 'openvino_model.bin', 'openvino_tokenizer.xml', 'openvino_tokenizer.bin', 'openvino_detokenizer.xml', 'openvino_detokenizer.bin', 'tokenizer.json']) {
    await writeFile(join(modelPath, file), 'data');
  }
  const shared = new FakeSharedRunner(modelPath);
  await shared.listen();
  shared.serve();
  const spawned: FakeRunnerChild[] = [];
  const base = defaultEngineManagerSettings({
    engineKind: 'ovgenai',
    ovgenaiRunnerPath: '/ext/binaries/ovgenai/linux-x64/tlc-ovgenai-runner',
    sharedRunner: true,
    device: 'npu',
    ...settingsOverrides,
  });
  let connects = 0;
  const fixture: Fixture = {
    spawned,
    root,
    engineRoot,
    modelPath,
    shared,
    rejectFirstConnect: false,
    host: {
      platform: 'linux',
      arch: 'x64',
      paths: () => ({ engineRoot, modelDir, modelCacheDir: join(root, 'cache') }),
      settings: () => base,
      onStatus: () => undefined,
      notify: () => undefined,
      warn: () => undefined,
      log: () => undefined,
      download: (async () => undefined) as never,
      extract: (async () => undefined) as never,
      spawnImpl: (spawnImpl ?? ((_path: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
        const child = new FakeRunnerChild(args, opts.env);
        spawned.push(child);
        setTimeout(() => child.stdout.write(`${JSON.stringify({ type: 'ready', model: args[1], device: 'NPU', ctx: 8192 })}\n`), 0);
        return child;
      })) as never,
      delayImpl: async () => undefined,
      pickPort: async () => 0,
      probeRunnerVersion: async () => ({ app: 'test-runner', ovGenai: OV_GENAI_VERSION }),
      npuGeneration: async () => 0,
      // Every connect lands on the fake shared runner regardless of the
      // requested pipe/port; rejectFirstConnect simulates an empty endpoint
      // for the adoption attempt.
      connectImpl: async (target: { path?: string; port?: number }) => {
        if (fixture.rejectFirstConnect && connects++ === 0) {
          throw Object.assign(new Error(`connect ${target.path ?? target.port} ENOENT`), { code: 'ENOENT' });
        }
        return await new Promise<net.Socket>((resolve, reject) => {
          const s = net.connect(shared.port, '127.0.0.1', () => resolve(s));
          s.once('error', reject);
        });
      },
    },
  };
  return fixture;
};

const cleanup = async (f: Fixture): Promise<void> => {
  f.shared.close();
  await rm(f.root, { recursive: true, force: true });
};

const busyPipeSpawn = (f: Fixture): EngineManagerHost['spawnImpl'] =>
  ((_path: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    const child = new FakeRunnerChild(args, opts.env);
    f.spawned.push(child);
    // The winning window publishes its record while this one is retrying.
    void writeRecord(f.engineRoot, {
      pid: process.pid,
      transport: 'tcp',
      port: f.shared.port,
      token: '',
      options: { kind: 'ovgenai', modelPath: f.modelPath, device: 'NPU', contextLength: 8192 },
    });
    setTimeout(() => child.stdout.write(`${JSON.stringify({ type: 'error', message: 'listen endpoint already in use: \\\\.\\pipe\\tlc-runner-x' })}\n`), 0);
    return child;
  }) as never;

describe('EngineManager (shared runner)', () => {
  it('connects to a live discovery record instead of spawning', { timeout: 20_000 }, async () => {
    const f = await makeFixture();
    await writeRecord(f.engineRoot, {
      pid: process.pid,
      transport: 'tcp',
      port: f.shared.port,
      token: '',
      options: { kind: 'ovgenai', modelPath: f.modelPath, device: 'NPU', contextLength: 8192 },
    });
    const manager = new EngineManager(f.host);
    const status = await readyStatus(manager);
    expect(status.sharedPid).toBe(process.pid);
    expect(f.spawned).toHaveLength(0);
    await manager.stop();
    await cleanup(f);
  });

  it('adopts a live runner with no discovery record (busy pipe means join, not fallback)', { timeout: 20_000 }, async () => {
    const f = await makeFixture();
    const manager = new EngineManager(f.host);
    const status = await readyStatus(manager);
    expect(status.device).toBe('npu');
    expect(f.spawned).toHaveLength(0);
    await manager.stop();
    await cleanup(f);
  });

  it('a busy pipe retries, then connects to the peer record the winner wrote', { timeout: 40_000 }, async () => {
    const f = await makeFixture();
    f.rejectFirstConnect = true;
    (f.host as EngineManagerHost).spawnImpl = busyPipeSpawn(f) as never;
    const manager = new EngineManager(f.host);
    const status = await readyStatus(manager);
    expect(status.device).toBe('npu');
    expect(f.spawned.length).toBeGreaterThan(0);
    expect(status.sharedPid).toBe(process.pid);
    await manager.stop();
    await cleanup(f);
  });

  it('auto transport falls back from a failing pipe to tcp', { timeout: 40_000 }, async () => {
    const f = await makeFixture({ sharedRunnerTransport: 'auto' }, ((_path: string, args: string[]) => {
      const child = new ListenFakeChild(args, {});
      f.spawned.push(child);
      if (!args.includes('--listen-tcp')) {
        setTimeout(() => child.stdout.write(`${JSON.stringify({ type: 'error', message: 'listen endpoint already in use: pipe-x' })}\n`), 0);
        return child;
      }
      setTimeout(() => child.stdout.write(`${JSON.stringify({ type: 'ready', model: f.modelPath, device: 'NPU', ctx: 8192 })}\n`), 0);
      return child;
    }) as never);
    f.rejectFirstConnect = true;
    const manager = new EngineManager(f.host);
    const status = await readyStatus(manager);
    expect(status.device).toBe('npu');
    const tcpSpawns = f.spawned.filter((c) => c.args.includes('--listen-tcp'));
    expect(tcpSpawns).toHaveLength(1);
    expect(tcpSpawns[0].args).toContain('0');
    await manager.stop();
    await cleanup(f);
  });
});
