import { spawn } from 'child_process';
import { createServer } from 'net';
import { randomBytes } from 'crypto';
import { LocalDevice } from '../config';

export interface EngineStartOptions {
  serverPath: string;
  /** GGUF or OV IR model path; logged in the ready message. */
  modelPath: string;
  /** Runner name for log lines and the ready message (defaults from engine kind). */
  serverName?: string;
  /**
   * Full argument template. `{PORT}` is replaced with the picked loopback port,
   * `{KEY}` with the generated session key.
   */
  args: string[];
  /** Readiness path polled until 200 (default `/health`). */
  readyPath?: string;
  /** Base path of the returned endpoint URL (default `/v1`). */
  basePath?: string;
  /** Extra env; `{KEY}` is replaced with the generated session key (empty when key auth is off). */
  env: Record<string, string>;
  /** When false the server runs without key authentication (debugging). */
  apiKeyEnabled?: boolean;
  readyTimeoutMs?: number;
  /** Called when the server process dies on its own (not via stop()). */
  onUnexpectedExit?: (message: string) => void;
}

/** Replaces a llama-args placeholder with the model path. */
export function withModelPlaceholder(args: string[], modelPath: string): string[] {
  return args.map((arg) => (arg === '{MODEL}' ? modelPath : arg));
}

export interface RunningEngine {
  baseUrl: string;
  /** The per-session key, or undefined when key authentication is disabled. */
  apiKey: string | undefined;
  modelPath: string;
  stop: () => Promise<void>;
}

export interface RunnerDeps {
  log: (message: string) => void;
  spawnImpl?: typeof spawn;
  fetchImpl?: typeof fetch;
  delayImpl?: (ms: number) => Promise<void>;
  pickPort?: () => Promise<number>;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('Cannot allocate a free port'))));
    });
  });
}

export function sessionApiKey(): string {
  return randomBytes(32).toString('base64url');
}

export function llamaArgs(contextLength: number, device: LocalDevice): string[] {
  const offload = device === 'cpu' ? [] : ['-ngl', '999'];
  return [...offload, '--host', '127.0.0.1', '--port', '{PORT}', '-m', '{MODEL}', '-c', String(contextLength), '--api-key', '{KEY}'];
}

/**
 * Starts a local engine server bound to loopback with a per-session key
 * (only the extension knows it) and resolves when /health (or the engine's
 * readiness path) responds. The key is never persisted; a new one is
 * generated for every start.
 */
export async function startEngine(options: EngineStartOptions, deps: RunnerDeps): Promise<RunningEngine> {
  const spawnImpl = deps.spawnImpl ?? spawn;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const delay = deps.delayImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pickPort = deps.pickPort ?? freePort;
  const serverName = options.serverName ?? 'llama-server';
  const port = await pickPort();
  const apiKey = options.apiKeyEnabled === false ? undefined : sessionApiKey();

  const args = options.args.flatMap((arg, i) => {
    if (arg === '{PORT}') {
      return [String(port)];
    }
    if (arg === '{KEY}') {
      return apiKey === undefined ? [] : [apiKey];
    }
    // Drop the flag preceding a removed {KEY} placeholder (key auth off).
    if (apiKey === undefined && options.args[i + 1] === '{KEY}') {
      return [];
    }
    if (arg === '{MODEL}') {
      return [options.modelPath];
    }
    return [arg];
  });
  const env = Object.fromEntries(
    Object.entries(options.env).map(([k, v]) => [
      k,
      apiKey === undefined ? v.replace(/\{KEY\}/g, '') : v.replace(/\{KEY\}/g, apiKey),
    ]),
  );

  const child = spawnImpl(options.serverPath, args, { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let exited: Error | undefined;
  let cleanExit = false;
  child.on('close', (code, signal) => {
    if (!cleanExit) {
      options.onUnexpectedExit?.(`${serverName} exited (code ${code ?? signal})`);
    }
  });
  // Last log lines of the server, surfaced in startup errors for debugging.
  const logTail: string[] = [];
  const pushTail = (line: string): void => {
    logTail.push(line);
    if (logTail.length > 15) {
      logTail.shift();
    }
  };
  const tailText = (): string => (logTail.length > 0 ? `; last output: ${logTail.join(' | ')}` : '');
  child.on('error', (err) => {
    exited = err;
  });
  // Forward the server's own logs (device selection, token metrics) so the
  // device actually in use can be verified in the output channel.
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (d: Buffer) => {
      const line = d.toString('utf8').trimEnd();
      if (line.length > 0) {
        pushTail(line);
        deps.log(`${serverName}: ${line}`);
      }
    });
  }
  if (Object.keys(env).length > 0) {
    deps.log(`${serverName} start env: ${JSON.stringify(env)}`);
  }
  deps.log(`${serverName} starting on port ${port} (${apiKey === undefined ? 'no key auth' : 'session key auth'})`);

  const timeoutMs = options.readyTimeoutMs ?? 300_000;
  const deadline = Date.now() + timeoutMs;
  const readyUrl = `http://127.0.0.1:${port}${options.readyPath ?? '/health'}`;
  for (;;) {
    if (exited !== undefined) {
      throw new Error(`${serverName} failed to start: ${exited.message}${tailText()}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${serverName} exited during startup${tailText()}`);
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`${serverName} did not become ready within ${Math.round(timeoutMs / 1000)}s${tailText()}`);
    }
    let status: number | undefined;
    try {
      const baseHeaders: Record<string, string> = apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey}` };
      // Build default per-session headers (key auth) unless the runner
      // disables key authentication (`apiKeyEnabled: false`).
      status = (await fetchImpl(readyUrl, { headers: baseHeaders, signal: AbortSignal.timeout(2000) })).status;
    } catch {
      status = undefined;
    }
    if (status === 200) {
      break;
    }
    if (status !== undefined && status !== 503 && status !== 401) {
      child.kill();
      throw new Error(`${serverName} readiness check failed with status ${status}`);
    }
    await delay(250);
  }
  deps.log(`${serverName} ready on port ${port} (model: ${options.modelPath})`);

  let stopped = false;
  return {
    baseUrl: `http://127.0.0.1:${port}${options.basePath ?? '/v1'}`,
    apiKey: apiKey,
    modelPath: options.modelPath,
    stop: () =>
      new Promise<void>((resolve) => {
        if (stopped || child.exitCode !== null) {
          stopped = true;
          cleanExit = true;
          resolve();
          return;
        }
        stopped = true;
        cleanExit = true;
        child.once('close', () => resolve());
        child.kill();
      }),
  };
}