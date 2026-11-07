import { spawn } from 'child_process';
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

/**
 * Client for the bundled ovgenai runner: NDJSON over stdin/stdout. The runner
 * queues generate requests and serves them one at a time; several client
 * streams may be pending concurrently.
 */
export interface RunningStdioRunner {
  device: string;
  modelPath: string;
  stream(prompt: string, maxTokens: number, stop: string[], signal?: AbortSignal): AsyncIterable<string>;
  stop(): Promise<void>;
}

export async function startStdioRunner(options: StdioRunnerStartOptions, deps: StdioRunnerDeps = {}): Promise<RunningStdioRunner> {
  const spawnImpl = deps.spawnImpl ?? spawn;
  const log = deps.log ?? (() => undefined);
  const label = options.label ?? 'ovgenai';

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
  const child = spawnImpl(options.runnerPath, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  let exited: Error | undefined;
  let cleanStop = false;
  let nextId = 1;
  // Requests the runner has accepted but not yet answered with a terminal
  // done/error event. Insertion order = send order = runner processing order:
  // token events (which carry no id) belong to the oldest pending request.
  const requests = new Map<number, {
    id: number;
    onToken: (text: string) => void;
    resolve: (result: GenerateResult) => void;
    reject: (err: Error) => void;
  }>();
  const progressListeners: Array<() => void> = [];
  const lines = createInterface({ input: child.stdout! });
  lines.on('line', handleLine);
  child.stderr?.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (line.length > 0) {
        progressListeners.forEach((fn) => fn());
        options.onStderr?.(line);
      }
    }
  });
  child.on('error', (err) => {
    exited = err;
  });
  child.on('close', (code, signal) => {
    if (!cleanStop) {
      exited = new Error(`${label} runner exited (code ${code ?? signal})`);
      options.onUnexpectedExit?.(exited.message);
    }
    const leftover = exited ?? new Error(`${label} runner closed`);
    for (const pending of requests.values()) {
      pending.reject(leftover);
    }
    requests.clear();
  });

  const readyInfo = await waitForReady(options.readyTimeoutMs ?? 600_000, options.readyIdleTimeoutMs, options.signal);
  function handleLine(line: string): void {
    if (line.length === 0) {
      return;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      log(`${label}: non-JSON stdout line dropped: ${line.slice(0, 200)}`);
      return;
    }
    const type = event.type;
    if (type === 'error' && event.id === null) {
      log(`${label}: startup error: ${String(event.message)}`);
      return;
    }
    // Token events carry no request id (the runner serves one generation at a
    // time); route them to the oldest pending request (send order = runner
    // processing order). done/error carry the id and close that request.
    if (type === 'token') {
      requests.values().next().value?.onToken(String(event.text ?? ''));
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

  function waitForReady(timeoutMs: number, idleTimeoutMs: number | undefined, signal: AbortSignal | undefined): Promise<{ model: string; device: string; ctx: number }> {
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
        if (exited !== undefined) {
          cleanup();
          reject(exited);
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
          resolve({ model: String(event.model ?? ''), device: String(event.device ?? ''), ctx: Number(event.ctx ?? 0) });
        } else if (event.type === 'error') {
          cleanup();
          reject(new Error(String(event.message)));
        }
      };
      lines.on('line', onLine);
    });
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
      child.stdin?.write(`${JSON.stringify({ type: 'cancel', id })}\n`);
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
    child.stdin?.write(`${JSON.stringify({ type: 'generate', id, prompt, maxTokens, stop })}\n`);

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
        child.stdin?.write(`${JSON.stringify({ type: 'cancel', id })}\n`);
      }
      // The request stays in the map until its terminal done/error event
      // arrives: straggler tokens of a canceled generation must not misroute
      // to the next request.
    }
  }

  return {
    device: readyInfo.device,
    modelPath: options.modelPath,
    stream,
    stop: () =>
      new Promise((resolve) => {
        cleanStop = true;
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
