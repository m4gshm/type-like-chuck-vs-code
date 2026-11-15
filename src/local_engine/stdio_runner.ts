import { spawn } from 'child_process';
import { connect as netConnect } from 'net';
import type { Socket } from 'net';
import { createInterface } from 'readline';

export interface StdioRunnerStartOptions {
  runnerPath: string;
  modelPath: string;
  /** OpenVINO GenAI device string: CPU, GPU or NPU. Omitted for engines without a device choice (mlx). */
  device?: string;
  /** Log prefix for diagnostics (defaults to the ovgenai runner). */
  label?: string;
  contextLength?: number;
  /** OpenVINO plugin properties passed as --prop KEY=VALUE (e.g. CACHE_DIR). */
  props?: Record<string, string>;
  /** Runtime library directories prepended to PATH (win) / LD_LIBRARY_PATH (linux). */
  libraryDirs?: string[];
  /**
   * Listen mode (shared runner): when set, the runner is started with
   * --listen/--listen-tcp instead of private stdin/stdout, and stop()
   * only disconnects — the runner self-terminates when its last client
   * leaves.
   */
  listen?: { transport: 'pipe'; pipeName: string; socketPath?: string } | { transport: 'tcp' };
  /** Per-instance shared-runner secret; also sent as the first auth message by connecting clients. */
  token?: string;
  /** Ready-wait limit; Infinity waits forever (NPU graph compilation can take unbounded time). */
  readyTimeoutMs?: number;
  /**
   * Ready-wait idle limit: re-armed on every stderr line, so only a silent
   * runner trips it (a hung compiler pass); use instead of a wall-clock
   * readyTimeoutMs when compilation time is unbounded.
   */
  readyIdleTimeoutMs?: number;
  /** Cancels the ready wait: the child is killed and the start rejects with AbortError. */
  signal?: AbortSignal;
  /** Called right after the child process exists (before the model loads): the shared-runner discovery record is written here. */
  onSpawned?: (pid: number) => void;
  onUnexpectedExit?: (message: string) => void;
  onStderr?: (line: string) => void;
}

export interface StdioRunnerDeps {
  spawnImpl?: typeof spawn;
  platform?: NodeJS.Platform;
  log?: (message: string) => void;
}

export interface GenerateResult {
  finishReason: 'stop' | 'length' | 'cancel';
}

/** Versions reported by `--version` (the app version may be "unknown"). */
export interface RunnerVersions {
  /** Runner's own application version from git. */
  app?: string;
  /** OpenVINO GenAI version the runner was built against. */
  ovGenai?: string;
}

export interface RunningStdioRunner {
  device: string;
  modelPath: string;
  pid?: number;
  /** Bound TCP port in listen-tcp mode (from the ready event). */
  port?: number;
  stream(prompt: string, maxTokens: number, stop: string[], signal?: AbortSignal): AsyncIterable<string>;
  stop(): Promise<void>;
}

/** Prepends the runtime library directories to the loader search path. */
function prependLibraryDirs(env: NodeJS.ProcessEnv, dirs: string[], platform: NodeJS.Platform): void {
  if (dirs.length === 0) {
    return;
  }
  if (platform === 'win32') {
    env.PATH = `${dirs.join(';')};${env.PATH ?? ''}`;
  } else {
    env.LD_LIBRARY_PATH = `${dirs.join(':')}${env.LD_LIBRARY_PATH ? `:${env.LD_LIBRARY_PATH}` : ''}`;
  }
}

interface PendingRequest {
  id: number;
  onToken: (text: string) => void;
  resolve: (result: GenerateResult) => void;
  reject: (err: Error) => void;
}

/**
 * The NDJSON request/response machine shared by the spawned (stdin/stdout)
 * client and the shared-runner (socket) client: one request map, token
 * routing (by id when the runner supplies it, otherwise to the oldest
 * pending request — the single-client legacy order), and the async stream.
 */
interface ProtocolClient {
  handleLine(line: string): void;
  /** Marks the transport dead and rejects every pending request. */
  markExited(err: Error): void;
  exitedError(): Error | undefined;
  stream(prompt: string, maxTokens: number, stop: string[], signal?: AbortSignal): AsyncIterable<string>;
}

function createProtocolClient(label: string, write: (line: string) => void): ProtocolClient {
  let nextId = 1;
  let exited: Error | undefined;
  const requests = new Map<number, PendingRequest>();

  const send = (obj: Record<string, unknown>): void => write(`${JSON.stringify(obj)}\n`);

  function handleLine(line: string): void {
    if (line.length === 0) {
      return;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Non-JSON lines (e.g. OpenVINO logs from old runner builds) are dropped.
      return;
    }
    const type = event.type;
    if (type === 'error' && event.id === null) {
      return;
    }
    // Tokens route by request id when the runner supplies it (listen mode,
    // multi-client); the id-less legacy form belongs to the oldest pending
    // request (send order = runner processing order).
    if (type === 'token') {
      const byId = typeof event.id === 'number' ? requests.get(event.id) : undefined;
      (byId ?? requests.values().next().value)?.onToken(String(event.text ?? ''));
      return;
    }
    const current = typeof event.id === 'number' ? requests.get(event.id) : undefined;
    if (current === undefined) {
      return;
    }
    if (type === 'done') {
      requests.delete(current.id);
      current.resolve({ finishReason: (event.finishReason as GenerateResult['finishReason']) ?? 'stop' });
    } else if (type === 'error') {
      requests.delete(current.id);
      current.reject(new Error(String(event.message)));
    }
  }

  async function* stream(prompt: string, maxTokens: number, stop: string[], signal?: AbortSignal): AsyncIterable<string> {
    if (exited !== undefined) {
      throw exited;
    }
    const id = nextId++;
    const queue: string[] = [];
    let result: GenerateResult | undefined;
    let error: Error | undefined;
    let cancelled = false;
    let finished = false;

    const onAbort = () => {
      cancelled = true;
      send({ type: 'cancel', id });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    requests.set(id, {
      id,
      onToken: (text) => queue.push(text),
      resolve: (r) => {
        finished = true;
        result = r;
      },
      reject: (e) => {
        finished = true;
        error = e;
      },
    });
    send({ type: 'generate', id, prompt, maxTokens, stop });

    try {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (error !== undefined) {
          throw error;
        }
        if (result !== undefined) {
          return;
        }
        if (exited !== undefined) {
          throw exited;
        }
        // Wait for the next event without spinning: a tiny macrotask sleep
        // keeps this simple and correct for the token rates involved.
        await new Promise<void>((r) => setTimeout(r, 1));
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (!finished && !cancelled) {
        send({ type: 'cancel', id });
      }
      // The request stays in the map until its terminal done/error event
      // arrives: straggler tokens of a canceled generation must not misroute
      // to the next request.
    }
  }

  return {
    handleLine,
    markExited: (err: Error) => {
      exited = err;
      for (const pending of requests.values()) {
        pending.reject(err);
      }
      requests.clear();
    },
    exitedError: () => exited,
    stream,
  };
}

/**
 * Runs `<runner> --version` (one short-lived process; needs the runtime
 * libraries on the loader path, so only callable once the runtime is ready)
 * and parses the version event. Undefined when the runner cannot start, hangs
 * past the timeout, or predates the --version flag.
 */
export async function probeRunnerVersion(runnerPath: string, libraryDirs: string[] = [], deps: StdioRunnerDeps = {}): Promise<RunnerVersions | undefined> {
  const spawnImpl = deps.spawnImpl ?? spawn;
  const env: NodeJS.ProcessEnv = { ...process.env };
  prependLibraryDirs(env, libraryDirs, deps.platform ?? process.platform);
  return await new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (result: RunnerVersions | undefined) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(result);
      }
    };
    const child = spawnImpl(runnerPath, ['--version'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', () => finish(undefined));
    child.on('close', () => {
      for (const line of out.split('\n')) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.type === 'version') {
            finish({
              app: typeof event.app === 'string' ? event.app : undefined,
              ovGenai: typeof event.ovGenai === 'string' ? event.ovGenai : undefined,
            });
            return;
          }
        } catch {
          // Not JSON — e.g. loader error text from an old runner; keep scanning.
        }
      }
      finish(undefined);
    });
  });
}

export async function startStdioRunner(options: StdioRunnerStartOptions, deps: StdioRunnerDeps = {}): Promise<RunningStdioRunner> {
  const spawnImpl = deps.spawnImpl ?? spawn;
  const log = deps.log ?? (() => undefined);
  const label = options.label ?? 'ovgenai';
  const shared = options.listen !== undefined;

  const env: NodeJS.ProcessEnv = { ...process.env };
  prependLibraryDirs(env, options.libraryDirs ?? [], deps.platform ?? process.platform);

  const args = ['--model', options.modelPath];
  if (options.device !== undefined) {
    args.push('--device', options.device);
  }
  if (options.contextLength !== undefined && options.contextLength > 0) {
    args.push('--ctx', String(options.contextLength));
  }
  for (const [key, value] of Object.entries(options.props ?? {})) {
    args.push('--prop', `${key}=${value}`);
  }
  if (options.listen?.transport === 'pipe') {
    args.push('--listen', options.listen.pipeName);
  } else if (options.listen?.transport === 'tcp') {
    args.push('--listen-tcp', '0');
  }
  if (options.token !== undefined && options.token.length > 0) {
    args.push('--token', options.token);
  }
  const child = spawnImpl(options.runnerPath, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  if (child.pid !== undefined) {
    options.onSpawned?.(child.pid);
  }
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  let cleanStop = false;
  const client = createProtocolClient(label, (line) => child.stdin?.write(line));
  const progressListeners: Array<() => void> = [];
  const lines = createInterface({ input: child.stdout! });
  lines.on('line', client.handleLine);
  child.stderr?.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (line.length > 0) {
        progressListeners.forEach((fn) => fn());
        options.onStderr?.(line);
      }
    }
  });
  child.on('error', (err) => {
    client.markExited(err);
  });
  child.on('close', (code, signal) => {
    if (!cleanStop) {
      const err = new Error(`${label} runner exited (code ${code ?? signal})`);
      client.markExited(err);
      options.onUnexpectedExit?.(err.message);
    }
  });

  const readyInfo = await waitForReady(
    // The NPU compile has no bound (the idle timeout below guards hangs), so
    // the wall-clock cap only applies when no idle guard is armed.
    options.readyTimeoutMs ?? (options.readyIdleTimeoutMs !== undefined ? Infinity : 600_000),
    options.readyIdleTimeoutMs,
    options.signal,
  );

  function waitForReady(timeoutMs: number, idleTimeoutMs: number | undefined, signal: AbortSignal | undefined): Promise<{ model: string; device: string; ctx: number; pid?: number; port?: number }> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const armIdle: (() => void) | undefined = idleTimeoutMs === undefined
        ? undefined
        : () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
              cleanup();
              child.kill();
              reject(new Error(`${label} runner produced no output for ${idleTimeoutMs} ms during startup`));
            }, idleTimeoutMs);
          };
      const cleanup = (): void => {
        clearInterval(checkDead);
        clearTimeout(timer);
        clearTimeout(idleTimer);
        lines.off('line', onLine);
        if (armIdle) {
          const at = progressListeners.indexOf(armIdle);
          if (at >= 0) {
            progressListeners.splice(at, 1);
          }
        }
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        child.kill();
        reject(new DOMException('Canceled', 'AbortError'));
      };
      if (armIdle) {
        progressListeners.push(armIdle);
        armIdle();
      }
      timer = Number.isFinite(timeoutMs)
        ? setTimeout(() => {
            cleanup();
            reject(new Error(`${label} runner did not become ready in time`));
          }, timeoutMs)
        : undefined;
      const checkDead = setInterval(() => {
        if (client.exitedError() !== undefined) {
          cleanup();
          reject(client.exitedError()!);
        }
      }, 100);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      // Non-JSON stdout lines (e.g. OpenVINO logs from old runner builds) are
      // skipped: keep scanning until a real event arrives.
      const onLine = (line: string): void => {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          log(`${label}: non-JSON stdout line dropped: ${line.slice(0, 200)}`);
          return;
        }
        if (event.type === 'ready') {
          cleanup();
          resolve({
            model: String(event.model ?? ''),
            device: String(event.device ?? ''),
            ctx: Number(event.ctx ?? 0),
            pid: typeof event.pid === 'number' ? event.pid : undefined,
            port: typeof event.port === 'number' ? event.port : undefined,
          });
        } else if (event.type === 'error') {
          cleanup();
          reject(new Error(String(event.message)));
        }
      };
      lines.on('line', onLine);
    });
  }

  return {
    device: readyInfo.device,
    modelPath: options.modelPath,
    pid: child.pid,
    port: readyInfo.port,
    stream: client.stream,
    stop: () =>
      new Promise((resolve) => {
        cleanStop = true;
        if (shared) {
          // Disconnect only: a shared runner self-terminates when its last
          // client leaves; other windows may still be using it.
          child.stdin?.end();
          child.once('close', () => resolve());
          return;
        }
        child.stdin?.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
        child.stdin?.end();
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 2000);
        child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      }),
  };
}

/** Where and how to reach an already-running shared runner. */
export interface SharedConnectOptions {
  transport: 'pipe' | 'tcp';
  /** Named pipe name (Windows) or unix socket path (Linux/macOS). */
  endpoint?: string;
  /** TCP port on 127.0.0.1 (transport: tcp). */
  port?: number;
  token: string;
  /** Expected model path: the ready handshake must match, else the connect fails. */
  modelPath: string;
  label?: string;
  readyTimeoutMs?: number;
  signal?: AbortSignal;
  onUnexpectedExit?: (message: string) => void;
}

export interface SharedConnectDeps {
  /** Injectable socket factory (defaults to net.connect). */
  connectImpl?: (options: { path?: string; port?: number; host?: string }) => Promise<Socket>;
  log?: (message: string) => void;
}

/**
 * Connects to an already-running shared runner (named pipe, unix socket or
 * localhost TCP), authenticates with the per-instance token and verifies the
 * ready handshake against the expected model. stop() only disconnects — the
 * runner's client refcount decides when it terminates.
 */
export async function connectSharedRunner(options: SharedConnectOptions, deps: SharedConnectDeps = {}): Promise<RunningStdioRunner> {
  const label = options.label ?? 'ovgenai';
  const doConnect = deps.connectImpl ?? ((target: { path?: string; port?: number; host?: string }) => new Promise<Socket>((resolve, reject) => {
    const targetOpts = target.port !== undefined ? { port: target.port, host: target.host } : { path: target.path ?? '' };
    const s = netConnect(targetOpts, () => resolve(s));
    s.once('error', reject);
  }));

  const socket = await doConnect(options.transport === 'tcp'
    ? { port: options.port, host: '127.0.0.1' }
    : { path: options.endpoint });
  socket.setEncoding('utf8');

  let cleanStop = false;
  const client = createProtocolClient(label, (line) => socket.write(line));
  const lines = createInterface({ input: socket });
  lines.on('line', client.handleLine);
  socket.on('close', () => {
    if (!cleanStop) {
      const err = new Error(`${label} shared runner connection lost`);
      client.markExited(err);
      options.onUnexpectedExit?.(err.message);
    }
  });
  socket.on('error', (err) => {
    client.markExited(err);
  });

  const readyInfo = await new Promise<{ model: string; device: string; port?: number }>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      clearTimeout(timer);
      lines.off('line', onLine);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const fail = (err: Error): void => {
      cleanup();
      socket.destroy();
      reject(err);
    };
    const onAbort = (): void => fail(new DOMException('Canceled', 'AbortError'));
    // A client can connect while the runner is mid-NPU-compile (15+ min for a
    // 3B nf4 model): the wait must outlast the compile, not a 10-min default.
    timer = setTimeout(() => fail(new Error(`${label} shared runner did not become ready in time`)), options.readyTimeoutMs ?? 30 * 60_000);
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const onLine = (line: string): void => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (event.type === 'ready') {
        cleanup();
        resolve({
          model: String(event.model ?? ''),
          device: String(event.device ?? ''),
          port: typeof event.port === 'number' ? event.port : undefined,
        });
      } else if (event.type === 'error') {
        fail(new Error(String(event.message)));
      }
    };
    // The runner gates listen-mode traffic on auth: it must be the first
    // message on the connection, before any request is accepted.
    socket.write(`${JSON.stringify({ type: 'auth', token: options.token })}\n`);
    lines.on('line', onLine);
  });

  if (readyInfo.model !== options.modelPath) {
    socket.destroy();
    throw new Error(`${label} shared runner model mismatch: expected ${options.modelPath}, got ${readyInfo.model}`);
  }

  return {
    device: readyInfo.device,
    modelPath: options.modelPath,
    stream: client.stream,
    stop: () =>
      new Promise((resolve) => {
        cleanStop = true;
        socket.end();
        resolve();
      }),
  };
}
