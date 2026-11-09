import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineStartOptions, freePort, sessionApiKey, startEngine } from '../../local_engine/engine_runner';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  args: string[];
  env: NodeJS.ProcessEnv;
  killed = false;

  constructor(args: string[], env: NodeJS.ProcessEnv) {
    super();
    this.args = args;
    this.env = env;
  }

  kill(): void {
    this.killed = true;
    this.exitCode = 0;
    this.emit('close', 0);
  }
}

const baseOptions = (overrides: Partial<EngineStartOptions> = {}): EngineStartOptions => ({
  serverPath: '/engine/llama-server.exe',
  modelPath: '/models/m.gguf',
  args: [
    '--host', '127.0.0.1', '--port', '{PORT}',
    '--api-key', '{KEY}',
    '-m', '{MODEL}',
    '-c', '32768',
  ],
  env: { SAMPLE_ENV: '1' },
  ...overrides,
});

const okFetch = vi.fn(async () => new Response('{}', { status: 200 }));
const noFetch = vi.fn(async () => new Response('{}', { status: 503 }));

afterEach(() => {
  vi.restoreAllMocks();
  okFetch.mockClear();
  noFetch.mockClear();
});

describe('startEngine', () => {
  it('reports an unexpected exit but stays silent on a clean stop', async () => {
    const onUnexpectedExit = vi.fn();
    const spawned: FakeChild[] = [];
    const startOpts = baseOptions({ onUnexpectedExit });
    const deps = {
      log: () => undefined,
      spawnImpl: ((_c: string, args: string[], o: { env: NodeJS.ProcessEnv }) => {
        const child = new FakeChild(args, o.env);
        spawned.push(child);
        return child;
      }) as never,
      fetchImpl: okFetch as never,
      pickPort: async () => 51236,
    };
    const engine = await startEngine(startOpts, deps);
    spawned[0].emit('close', 1, null);
    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
    expect(onUnexpectedExit).toHaveBeenCalledWith(expect.stringContaining('exited (code 1)'));
    await engine.stop();
    spawned[0].emit('close', 0, null);
    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
  });
  it('replaces the {KEY} placeholder in env values with the session key', async () => {
    const spawned: FakeChild[] = [];
    await startEngine(
      baseOptions({ env: { API_KEY: '{KEY}', FIXED: 'x' } }),
      {
        log: () => undefined,
        spawnImpl: ((command: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
          const child = new FakeChild(args, opts.env);
          spawned.push(child);
          return child;
        }) as never,
        fetchImpl: okFetch as never,
        pickPort: async () => 51235,
      },
    );
    expect(spawned[0].env.FIXED).toBe('x');
    expect(spawned[0].env.API_KEY).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });
  it('spawns llama-server with loopback, api key, model and device env, then reports ready', async () => {
    const spawned: FakeChild[] = [];
    const engine = await startEngine(
      baseOptions(),
      {
        log: () => undefined,
        spawnImpl: ((command: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
          const child = new FakeChild(args, opts.env);
          spawned.push(child);
          return child;
        }) as never,
        fetchImpl: okFetch as never,
        pickPort: async () => 51234,
      },
    );
    const child = spawned[0];
    expect(child.args[0]).toBe('--host');
    expect(child.args[1]).toBe('127.0.0.1');
    expect(child.args[2]).toBe('--port');
    expect(child.args[3]).toBe('51234');
    expect(child.args[4]).toBe('--api-key');
    expect(child.args[4 + 1].length).toBeGreaterThan(20);
    expect(child.args).toContain('-m');
    expect(child.args).toContain('/models/m.gguf');
    expect(child.args).toContain('-c');
    expect(child.env.SAMPLE_ENV).toBe('1');
    expect(engine.baseUrl).toBe('http://127.0.0.1:51234/v1');
    expect(engine.apiKey).toBe(child.args[5]);
    await engine.stop();
    expect(child.killed).toBe(true);
  });

  it('generates a fresh key on every start', () => {
    expect(sessionApiKey()).not.toBe(sessionApiKey());
  });

  it('runs without key authentication when apiKeyEnabled is false', async () => {
    const spawned: FakeChild[] = [];
    let authHeaders: unknown;
    const engine = await startEngine(
      baseOptions({ apiKeyEnabled: false }),
      {
        log: () => undefined,
        spawnImpl: ((_: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
          const child = new FakeChild(args, opts.env);
          spawned.push(child);
          return child;
        }) as never,
        fetchImpl: ((url: string, init: { headers: unknown }) => {
          authHeaders = init.headers;
          return okFetch();
        }) as never,
        pickPort: async () => 51235,
      },
    );
    expect(spawned[0].args).not.toContain('--api-key');
    expect(engine.apiKey).toBeUndefined();
    expect(authHeaders).toEqual({});
  });

  it('uses the ovms base and readiness paths with the ovms log prefix', async () => {
    const spawned: FakeChild[] = [];
    const logged: string[] = [];
    const readyUrls: string[] = [];
    const engine = await startEngine(
      baseOptions({
        serverPath: '/engine/ovms.bat',
        modelPath: '/models/OpenVINO/q',
        serverName: 'ovms',
        args: ['--model_name', 'q', '--rest_port', '{PORT}'],
        basePath: '/v3',
        readyPath: '/health',
        env: {},
      }),
      {
        log: (m) => logged.push(m),
        spawnImpl: ((_: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
          const child = new FakeChild(args, opts.env);
          spawned.push(child);
          return child;
        }) as never,
        fetchImpl: ((url: string) => {
          readyUrls.push(url);
          return okFetch();
        }) as never,
        pickPort: async () => 51236,
      },
    );
    expect(engine.baseUrl).toBe('http://127.0.0.1:51236/v3');
    expect(readyUrls[0]).toBe('http://127.0.0.1:51236/health');
    expect(spawned[0].args).toEqual(['--model_name', 'q', '--rest_port', '51236']);
    expect(spawned[0].env.GGML_OPENVINO_DEVICE).toBeUndefined();
    expect(logged.some((l) => l.startsWith('ovms ready on port 51236'))).toBe(true);
  });

  it('rejects when the process exits during startup', async () => {
    await expect(
      startEngine(
        baseOptions(),
        {
          log: () => undefined,
          spawnImpl: (() => {
            const child = new FakeChild([], {});
            setTimeout(() => {
              child.exitCode = 1;
              child.emit('close', 1);
            }, 0);
            return child;
          }) as never,
          fetchImpl: noFetch as never,
          pickPort: async () => 1,
          delayImpl: async () => {
            await new Promise((r) => setTimeout(r, 5));
          },
        },
      ),
    ).rejects.toThrow(/exited during startup/);
  });

  it('stops and reports timeout when the server never becomes healthy', async () => {
    const spawned: FakeChild[] = [];
    await expect(
      startEngine(
        baseOptions({ readyTimeoutMs: 30 }),
        {
          log: () => undefined,
          spawnImpl: ((_: string, args: string[]) => {
            const child = new FakeChild(args, {});
            spawned.push(child);
            return child;
          }) as never,
          fetchImpl: noFetch as never,
          pickPort: async () => 2,
          delayImpl: async () => {
            await new Promise((r) => setTimeout(r, 5));
          },
        },
      ),
    ).rejects.toThrow(/did not become ready/);
    expect(spawned[0].killed).toBe(true);
  });
});

describe('freePort', () => {
  it('returns a usable port number', async () => {
    expect(await freePort()).toBeGreaterThan(0);
  });
});
