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
  /** Runtime library directory prepended to PATH (win) / LD_LIBRARY_PATH (linux). */
  libraryDir?: string;
  readyTimeoutMs?: number;
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

/**
 * Client for the bundled ovgenai runner: NDJSON over stdin/stdout. Requests
 * are serialized; a generate issued while another is running is rejected.
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
  if (options.libraryDir !== undefined) {
    if ((deps.platform ?? process.platform) === 'win32') {
      env.PATH = `${options.libraryDir};${env.PATH ?? ''}`;
    } else {
      env.LD_LIBRARY_PATH = `${options.libraryDir}${env.LD_LIBRARY_PATH ? `:${env.LD_LIBRARY_PATH}` : ''}`;
    }
  }

  const args = ['--model', options.modelPath];
  if (options.device !== undefined) {
    args.push('--device', options.device);
  }
  if (options.contextLength !== undefined && options.contextLength > 0) {
    args.push('--ctx', String(options.contextLength));
  }
  const child = spawnImpl(options.runnerPath, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  let exited: Error | undefined;
  let cleanStop = false;
  let nextId = 1;
  let active: {
    id: number;
    onToken: (text: string) => void;
    resolve: (result: GenerateResult) => void;
    reject: (err: Error) => void;
    finished: boolean;
  } | undefined;
  const lines = createInterface({ input: child.stdout! });
  lines.on('line', handleLine);
  child.stderr?.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (line.length > 0) {
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
    if (exited !== undefined) {
      active?.reject(exited);
    }
    active = undefined;
  });

  const readyInfo = await waitForReady(options.readyTimeoutMs ?? 600_000);

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
    const current = active;
    if (current === undefined || event.id !== current.id) {
      return;
    }
    if (type === 'token') {
      current.onToken(String(event.text ?? ''));
    } else if (type === 'done') {
      current.finished = true;
      current.resolve({ finishReason: (event.finishReason as GenerateResult['finishReason']) ?? 'stop' });
      active = undefined;
    } else if (type === 'error') {
      current.finished = true;
      current.reject(new Error(String(event.message)));
      active = undefined;
    }
  }

  function waitForReady(timeoutMs: number): Promise<{ model: string; device: string; ctx: number }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} runner did not become ready in time`)), timeoutMs);
      const checkDead = setInterval(() => {
        if (exited !== undefined) {
          clearInterval(checkDead);
          clearTimeout(timer);
          reject(exited);
        }
      }, 100);
      lines.once('line', (line) => {
        clearInterval(checkDead);
        clearTimeout(timer);
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.type === 'ready') {
            resolve({ model: String(event.model ?? ''), device: String(event.device ?? ''), ctx: Number(event.ctx ?? 0) });
          } else if (event.type === 'error') {
            reject(new Error(String(event.message)));
          } else {
            reject(new Error(`unexpected first runner event: ${line.slice(0, 200)}`));
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  async function* stream(prompt: string, maxTokens: number, stop: string[], signal?: AbortSignal): AsyncIterable<string> {
    if (exited !== undefined) {
      throw exited;
    }
    if (active !== undefined) {
      throw new Error(`${label} runner is busy`);
    }
    const id = nextId++;
    const queue: string[] = [];
    let result: GenerateResult | undefined;
    let error: Error | undefined;
    let cancelled = false;

    const onAbort = () => {
      cancelled = true;
      child.stdin?.write(`${JSON.stringify({ type: 'cancel', id })}\n`);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    active = {
      id,
      onToken: (text) => queue.push(text),
      resolve: (r) => {
        result = r;
      },
      reject: (e) => {
        error = e;
      },
      finished: false,
    };
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
      if (!cancelled && active !== undefined && !active.finished) {
        child.stdin?.write(`${JSON.stringify({ type: 'cancel', id })}\n`);
      }
      // Wait for the runner to acknowledge cancellation before allowing the
      // next request (the busy flag is cleared by the done event).
      while (active !== undefined && !active.finished && exited === undefined) {
        await new Promise<void>((r) => setTimeout(r, 1));
      }
      if (active !== undefined && active.id === id) {
        active = undefined;
      }
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
