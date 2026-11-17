import { createHash, randomBytes } from 'crypto';
import { mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import type { EngineKind } from './kind_catalog';

/** Start options that decide whether two windows may share one runner. */
export interface SharedRunnerOptions {
  kind: EngineKind;
  modelPath: string;
  device?: string;
  contextLength?: number;
}

export interface RunnerRecord {
  pid: number;
  transport: 'pipe' | 'tcp';
  /** Named pipe name (Windows) or unix socket path (Linux/macOS); transport: pipe. */
  endpoint?: string;
  /** Localhost TCP port; transport: tcp. */
  port?: number;
  token: string;
  options: SharedRunnerOptions;
}

/**
 * The fields two runners must agree on to be shareable, per engine kind:
 * the ovgenai NPU graph is compiled per context length, so different
 * context lengths are different instances; mlx compiles once (dynamic KV
 * cache) and matches on the model alone.
 */
export function matchFields(kind: EngineKind, options: SharedRunnerOptions): string[] {
  if (kind === 'mlx') {
    return [options.modelPath];
  }
  return [options.modelPath, options.device ?? '', String(options.contextLength ?? 0)];
}

export function recordKey(options: SharedRunnerOptions): string {
  return createHash('sha1').update(matchFields(options.kind, options).join('\u0000')).digest('hex').slice(0, 12);
}

/**
 * Per-instance token for the opt-in TCP transport (any local user can reach a
 * localhost port, so the runner rejects unauthenticated clients). Pipe
 * clients need no token: the pipe lives in the creating user's namespace.
 */
export function newToken(): string {
  return randomBytes(16).toString('hex');
}

export function discoveryDir(engineRoot: string): string {
  return join(engineRoot, 'runners');
}

export function localListenEndpoint(engineRoot: string, options: SharedRunnerOptions): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\tlc-runner-${recordKey(options)}` : join(discoveryDir(engineRoot), `${recordKey(options)}.sock`);
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function matchesOptions(record: RunnerRecord, options: SharedRunnerOptions): boolean {
  const a = matchFields(record.options.kind, record.options);
  const b = matchFields(options.kind, options);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export async function writeRecord(engineRoot: string, record: RunnerRecord): Promise<string> {
  const dir = discoveryDir(engineRoot);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${record.options.kind}-${recordKey(record.options)}.json`);
  await writeFile(file, JSON.stringify(record));
  return file;
}

export interface ScannedRecord {
  file: string;
  record: RunnerRecord;
}

/** Reads every well-formed discovery file; malformed ones are skipped (reaped by the caller via pid checks). */
export async function scanRecords(engineRoot: string): Promise<ScannedRecord[]> {
  const dir = discoveryDir(engineRoot);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const found: ScannedRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue;
    }
    try {
      const record = JSON.parse(await readFile(join(dir, name), 'utf8')) as RunnerRecord;
      if (typeof record.pid === 'number' && typeof record.transport === 'string' && record.options !== undefined) {
        found.push({ file: name, record });
      }
    } catch {
      // A torn write or foreign file: ignore, it will never match.
    }
  }
  return found;
}

export async function deleteRecord(engineRoot: string, file: string): Promise<void> {
  await unlink(join(discoveryDir(engineRoot), file)).catch(() => undefined);
}

/**
 * Finds a discovery file whose options match and whose runner process is
 * still alive. A matching file with a dead PID is stale: it is reaped and
 * skipped.
 */
export async function findLiveMatch(
  engineRoot: string,
  options: SharedRunnerOptions,
  isAlive: (pid: number) => boolean = isPidAlive,
): Promise<ScannedRecord | undefined> {
  const records = await scanRecords(engineRoot);
  for (const entry of records) {
    if (!matchesOptions(entry.record, options)) {
      continue;
    }
    if (isAlive(entry.record.pid)) {
      return entry;
    }
    await deleteRecord(engineRoot, entry.file);
  }
  return undefined;
}
