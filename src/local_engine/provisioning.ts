import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { mkdir, readdir, rename, rm, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { DownloadProgress, downloadFile } from './downloader';
import { extractArchive } from './extract';
import { ENGINE_STATUS, EngineStatus } from './engine_status';
import { DirModelSpec, dirModelFileUrl } from './kind_catalog';
import { LocalModelSpec, localModelUrl } from './model_catalog';
import { EnginePaths } from './paths';
import { isPidAlive } from './runner_discovery';
import { OV_GENAI_VERSION, ovGenaiLibDir, resolveOvGenaiAsset, runnerOvGenaiVersion } from './ov_runtime';
import { resolveEngineAsset } from './release_assets';

/** Marker `askDistroOrDownload` returns when the user opts into downloading. */
export const DISTRO_CHOICE_DOWNLOAD = 'download';

export interface ProvisioningHost {
  platform: NodeJS.Platform;
  arch: string;
  onStatus: (status: EngineStatus) => void;
  onProgress?: (kind: 'engine' | 'model', progress: DownloadProgress) => void;
  download?: typeof downloadFile;
  extract?: typeof extractArchive;
  /** Returns a picked distro folder, DISTRO_CHOICE_DOWNLOAD, or undefined when dismissed. */
  askDistroOrDownload?: (kind: 'ovgenai' | 'llama.cpp') => Promise<string | typeof DISTRO_CHOICE_DOWNLOAD | undefined>;
  /**
   * Claims the cross-window provisioning leadership: the caller (the window
   * whose user answered "Download") becomes the one that downloads/compiles;
   * the call blocks while a peer holds the claim.
   */
  claimProvisioning?: (engineRoot: string) => Promise<void>;
  /** Whether this window currently has focus: setup questions go only here. */
  isWindowFocused?: () => boolean;
}

export function findBinary(dir: string, platform: NodeJS.Platform, kind: 'llama-server'): string | undefined {
  const binary = platform === 'win32' ? `${kind}.exe` : kind;
  if (!existsSync(dir)) {
    return undefined;
  }
  for (const entry of readdirSync(dir)) {
    if (entry === binary) {
      return join(dir, entry);
    }
  }
  return undefined;
}

/**
 * The ask-or-download seam shared by both engine kinds: with a picker wired,
 * the user first chooses between an existing distro folder and downloading;
 * a dismissal cancels the start.
 */
async function askDistroThenDownload<T>(deps: {
  host: ProvisioningHost;
  signal: AbortSignal | undefined;
  kind: 'ovgenai' | 'llama.cpp';
  prompt: string;
  engineRoot: string;
  useLocalDistro: (choice: string) => Promise<T>;
  downloadAsset: () => Promise<T>;
}): Promise<T> {
  const ask = deps.host.askDistroOrDownload;
  if (ask !== undefined) {
    // Only the focused window asks: background windows wait until they are
    // activated (or until a peer takes over provisioning and the question
    // becomes moot).
    for (;;) {
      if (isProvisioningLocked(deps.engineRoot)) {
        break;
      }
      if ((deps.host.isWindowFocused?.() ?? true)) {
        break;
      }
      deps.host.onStatus({
        status: ENGINE_STATUS.awaitingInput,
        prompt: 'waiting: activate this window to choose the local engine runtime setup',
      });
      await sleep(2000, deps.signal);
    }
    if (!isProvisioningLocked(deps.engineRoot)) {
      // A status before the question: it blocks the flow, and the progress
      // toast would otherwise keep showing the previous stage.
      deps.host.onStatus({ status: ENGINE_STATUS.awaitingInput, prompt: deps.prompt });
      const choice = await ask(deps.kind);
      if (choice === undefined) {
        throw new DOMException('Canceled', 'AbortError');
      }
      if (choice !== DISTRO_CHOICE_DOWNLOAD) {
        return deps.useLocalDistro(choice);
      }
      await deps.host.claimProvisioning?.(deps.engineRoot);
    }
  }
  return deps.downloadAsset();
}

/** The provisioning lock owner within this process (claims are idempotent). */
let claimedBy: number | undefined;

/** Pauses with abort support; shared by the provisioning wait loops. */
export const sleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Download canceled', 'AbortError'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Download canceled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort);
  });

/**
 * Cross-window download coordination: a `<destination>.downloading` marker
 * with the owner pid. A second window with the same target waits for the
 * first download to finish and reuses its file instead of re-downloading.
 * Returns true when the destination is already there (skip the download).
 */
export async function waitForPeerDownload(
  host: ProvisioningHost,
  destination: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const marker = `${destination}.downloading`;
  for (;;) {
    let ownerPid: number | undefined;
    try {
      ownerPid = (JSON.parse(readFileSync(marker, 'utf8')) as { pid: number }).pid;
    } catch {
      // No marker or unreadable: nobody is downloading.
    }
    if (ownerPid !== undefined && isPidAlive(ownerPid)) {
      if (existsSync(destination)) {
        return true;
      }
      host.onStatus({
        status: ENGINE_STATUS.awaitingInput,
        prompt: `waiting: another VS Code window is already downloading ${basename(destination)}…`,
      });
      await sleep(2000, signal);
      continue;
    }
    if (ownerPid !== undefined) {
      await rm(marker, { force: true });
    }
    return existsSync(destination);
  }
}

/** True while a live window owns the provisioning leadership. */
export function isProvisioningLocked(engineRoot: string): boolean {
  try {
    const { pid } = JSON.parse(readFileSync(join(engineRoot, 'provisioning.lock'), 'utf8')) as { pid: number };
    return pid !== process.pid && isPidAlive(pid);
  } catch {
    return false;
  }
}

/**
 * Cross-window provisioning lock: only one window asks questions, downloads,
 * installs and compiles; the others wait quietly and show a progress label.
 * A dead owner (crashed window) is taken over. Idempotent per process: a
 * window that already leads re-claims for free. Returns the release callback.
 */
export async function acquireProvisionLock(
  engineRoot: string,
  signal: AbortSignal | undefined,
  host: ProvisioningHost,
): Promise<() => Promise<void>> {
  if (claimedBy === process.pid) {
    return async () => undefined;
  }
  const lock = join(engineRoot, 'provisioning.lock');
  for (;;) {
    let ownerPid: number | undefined;
    try {
      ownerPid = (JSON.parse(readFileSync(lock, 'utf8')) as { pid: number }).pid;
    } catch {
      // No lock or unreadable: nobody is preparing.
    }
    if (ownerPid !== undefined && ownerPid !== process.pid && isPidAlive(ownerPid)) {
      host.onStatus({
        status: ENGINE_STATUS.awaitingInput,
        prompt: 'waiting: another VS Code window is preparing the local engine (download, install, compile)…',
      });
      await sleep(2000, signal);
      continue;
    }
    if (ownerPid !== undefined) {
      await rm(lock, { force: true });
    }
    try {
      await mkdir(engineRoot, { recursive: true });
      await writeFile(lock, JSON.stringify({ pid: process.pid }));
      claimedBy = process.pid;
      break;
    } catch {
      await sleep(2000, signal);
    }
  }
  return async () => {
    claimedBy = undefined;
    try {
      const own = (JSON.parse(readFileSync(lock, 'utf8')) as { pid: number }).pid === process.pid;
      if (own) {
        await rm(lock, { force: true });
      }
    } catch {
      // Already gone.
    }
  };
}

async function downloadTo(
  host: ProvisioningHost,
  signal: AbortSignal | undefined,
  opts: { url: string; destination: string; kind: 'engine' | 'model'; onProgress?: (p: DownloadProgress) => void; after?: () => Promise<void> },
): Promise<void> {
  if (await waitForPeerDownload(host, opts.destination, signal)) {
    return;
  }
  const marker = `${opts.destination}.downloading`;
  await writeFile(marker, JSON.stringify({ pid: process.pid }));
  try {
    await (host.download ?? downloadFile)({
      url: opts.url,
      destination: opts.destination,
      signal,
      onProgress: opts.onProgress ?? ((p) => host.onProgress?.(opts.kind, p)),
    });
    // The marker must cover unpacking too: a waiter that starts extracting
    // while the owner is mid-install corrupts both installs.
    await opts.after?.();
  } finally {
    await rm(marker, { force: true });
  }
}

export async function ensureLlamaEngine(
  host: ProvisioningHost,
  paths: EnginePaths,
  settings: { distroDir: string; releaseTag: string; githubUrl: string },
  signal: AbortSignal | undefined,
): Promise<string> {
  if (settings.distroDir.length > 0) {
    // The setting accepts either a llama-server binary file or a folder
    // containing one (a full distribution layout).
    const isFile = existsSync(settings.distroDir) && statSync(settings.distroDir).isFile();
    const binary = isFile ? settings.distroDir : findBinary(settings.distroDir, host.platform, 'llama-server');
    if (binary === undefined) {
      throw new Error(`Local llama.cpp distribution has an unexpected layout: no llama-server binary in ${settings.distroDir}.`);
    }
    return binary;
  }
  const tag = settings.releaseTag;
  const tagDir = join(paths.engineRoot, `${tag}-llama-std`);
  const serverPath = findBinary(tagDir, host.platform, 'llama-server');
  if (serverPath !== undefined) {
    return serverPath;
  }
  const asset = resolveEngineAsset(host.platform, host.arch, tag, settings.githubUrl);
  if (asset === undefined) {
    throw new Error(`No llama.cpp release asset for ${host.platform}/${host.arch}.`);
  }
  return askDistroThenDownload({
    host,
    signal,
    kind: 'llama.cpp',
    prompt: 'choose: download the llama.cpp build or use an existing unpacked folder',
    engineRoot: paths.engineRoot,
    useLocalDistro: async (choice) => {
      const binary = findBinary(choice, host.platform, 'llama-server');
      if (binary === undefined) {
        throw new Error(`Local llama.cpp distribution has an unexpected layout: no llama-server binary in ${choice}.`);
      }
      return binary;
    },
    downloadAsset: async () => {
      host.onStatus({ status: ENGINE_STATUS.preparingEngine });
      await mkdir(paths.engineRoot, { recursive: true });
      const archivePath = join(paths.engineRoot, asset.fileName);
      const releaseClaim = await acquireProvisionLock(paths.engineRoot, signal, host);
      try {
        // Wait out a peer's download+install first: it may fill tagDir (and
        // remove the archive) before we spend our own download.
        await waitForPeerDownload(host, archivePath, signal);
        const existing = findBinary(tagDir, host.platform, 'llama-server');
        if (existing !== undefined) {
          return existing;
        }
        await downloadTo(host, signal, {
          url: asset.url,
          destination: archivePath,
          kind: 'engine',
          after: async () => {
            await (host.extract ?? extractArchive)({ archivePath, destDir: tagDir, signal });
          },
        });
        await rm(archivePath, { force: true });
        const binary = findBinary(tagDir, host.platform, 'llama-server');
        if (binary === undefined) {
          throw new Error(`llama-server not found in the extracted engine (${tagDir}).`);
        }
        return binary;
      } finally {
        await releaseClaim();
      }
    },
  });
}

/** Returns the unpacked OpenVINO GenAI runtime root (lib dirs derive from it). */
export async function ensureOvGenaiRuntime(
  host: ProvisioningHost,
  paths: EnginePaths,
  settings: { distroDir: string; openvinoUrl: string; ovgenaiRunnerPath?: string },
  signal: AbortSignal | undefined,
): Promise<string> {
  const libDirOf = (root: string): string => ovGenaiLibDir(host.platform, root);
  if (settings.distroDir.length > 0) {
    if (!existsSync(libDirOf(settings.distroDir))) {
      throw new Error(`Local OpenVINO GenAI distribution has an unexpected layout: no runtime libraries under ${libDirOf(settings.distroDir)}.`);
    }
    return settings.distroDir;
  }
  // Version negotiation: the runner is compiled against a specific OpenVINO
  // GenAI version and crashes on a mismatched runtime, so the backend embeds
  // its version in the binary and we download exactly that archive. Runners
  // without the marker (older builds) fall back to the pinned latest.
  const version = runnerOvGenaiVersion(settings.ovgenaiRunnerPath) ?? OV_GENAI_VERSION;
  const asset = resolveOvGenaiAsset(host.platform, host.arch, version, settings.openvinoUrl);
  if (asset === undefined) {
    throw new Error(`No OpenVINO GenAI runtime archive for ${host.platform}/${host.arch}.`);
  }
  const topDir = asset.fileName.replace(/\.(zip|tar\.gz)$/, '');
  // Single-level install keeping the archive's own (version-bearing) folder
  // name; the ov-genai-<version> wrapper would only duplicate it.
  const runtimeRoot = join(paths.engineRoot, topDir);
  const legacyRoot = join(paths.engineRoot, `ov-genai-${version}`, topDir);
  if (existsSync(libDirOf(runtimeRoot))) {
    return runtimeRoot;
  }
  if (existsSync(libDirOf(legacyRoot))) {
    return legacyRoot;
  }
  const root = await askDistroThenDownload({
    host,
    signal,
    kind: 'ovgenai',
    prompt: 'choose: download the OpenVINO GenAI runtime or use an existing unpacked folder',
    engineRoot: paths.engineRoot,
    useLocalDistro: async (choice) => {
      if (!existsSync(libDirOf(choice))) {
        throw new Error(`Local OpenVINO GenAI distribution has an unexpected layout: no runtime libraries under ${libDirOf(choice)}.`);
      }
      return choice;
    },
    downloadAsset: async () => {
      host.onStatus({ status: ENGINE_STATUS.preparingEngine });
      await mkdir(paths.engineRoot, { recursive: true });
      const archivePath = join(paths.engineRoot, asset.fileName);
      // Leadership first: windows that skipped the question must not download
      // while the answering window is mid-provisioning — they wait here, then
      // reuse its files.
      const releaseClaim = await acquireProvisionLock(paths.engineRoot, signal, host);
      try {
        // Wait out a peer's download+install first: it may install the runtime
        // (and remove the archive) before we spend our own download. A leftover
        // archive from an interrupted session must not be raced by several
        // windows extracting it at once — the marker serializes that too.
        await waitForPeerDownload(host, archivePath, signal);
        // The wait (or an earlier session) may have produced the runtime already.
        if (existsSync(libDirOf(runtimeRoot))) {
          return runtimeRoot;
        }
        await downloadTo(host, signal, {
          url: asset.url,
          destination: archivePath,
          kind: 'engine',
          after: async () => {
            // Extract into a staging dir (extractArchive wipes destDir on failure and
            // engineRoot holds other engines), then move the archive's top folder up.
            const stagingDir = join(paths.engineRoot, `${topDir}.staging`);
            await (host.extract ?? extractArchive)({ archivePath, destDir: stagingDir, signal });
            // A previous interrupted install can leave the target shell behind; rename
            // onto an existing directory fails on Windows.
            await rm(runtimeRoot, { recursive: true, force: true });
            if (!existsSync(join(stagingDir, topDir))) {
              await rm(archivePath, { force: true });
              throw new Error(`OpenVINO runtime archive is corrupt or incomplete — deleted ${archivePath}, retry the start to re-download.`);
            }
            await rename(join(stagingDir, topDir), runtimeRoot);
            await rm(stagingDir, { recursive: true, force: true });
          for (const entry of await readdir(paths.engineRoot)) {
            // Stale installs from the previous two-level layout (ov-genai-<version>/...).
            if (entry.startsWith('ov-genai-')) {
              await rm(join(paths.engineRoot, entry), { recursive: true, force: true });
            }
          }
        },
        });
        await rm(archivePath, { force: true });
        return runtimeRoot;
      } finally {
        await releaseClaim();
      }
    },
  });
  if (!existsSync(libDirOf(root))) {
    throw new Error(`OpenVINO runtime libraries not found after unpacking (${libDirOf(root)}).`);
  }
  return root;
}

export async function ensureGgufModel(
  host: ProvisioningHost,
  paths: EnginePaths,
  model: LocalModelSpec | undefined,
  settings: { modelPath: string; modelId: string; huggingfaceUrl: string },
  signal: AbortSignal | undefined,
): Promise<string> {
  if (settings.modelPath.length > 0) {
    if (!existsSync(settings.modelPath)) {
      throw new Error(`Local model file or directory not found: ${settings.modelPath}`);
    }
    return settings.modelPath;
  }
  if (model === undefined) {
    throw new Error(`Unknown local model "${settings.modelId}".`);
  }
  const url = localModelUrl(model.id, settings.huggingfaceUrl);
  const modelPath = join(paths.modelDir, model.fileName);
  if (existsSync(modelPath)) {
    return modelPath;
  }
  host.onStatus({ status: ENGINE_STATUS.preparingModel });
  await mkdir(paths.modelDir, { recursive: true });
  await downloadTo(host, signal, { url, destination: modelPath, kind: 'model' });
  return modelPath;
}

/** ovgenai IR and mlx models: a custom path wins, then the catalog directory when all its files are present, else the missing files download. */
export async function ensureDirModel(
  host: ProvisioningHost,
  paths: EnginePaths,
  spec: DirModelSpec | undefined,
  settings: { modelPath: string; modelId: string; huggingfaceUrl: string },
  signal: AbortSignal | undefined,
): Promise<string> {
  if (settings.modelPath.length > 0) {
    if (!existsSync(settings.modelPath)) {
      throw new Error(`Local model file or directory not found: ${settings.modelPath}`);
    }
    return settings.modelPath;
  }
  if (spec === undefined) {
    throw new Error(`Unknown local model "${settings.modelId}".`);
  }
  const modelDir = join(paths.modelDir, spec.repo);
  const missing = spec.files.filter((file) => !existsSync(join(modelDir, file)));
  if (missing.length === 0) {
    return modelDir;
  }
  host.onStatus({ status: ENGINE_STATUS.preparingModel });
  await mkdir(modelDir, { recursive: true });
  for (const [index, file] of missing.entries()) {
    await downloadTo(host, signal, {
      url: dirModelFileUrl(spec, file, settings.huggingfaceUrl),
      destination: join(modelDir, file),
      kind: 'model',
      onProgress: (p) => host.onProgress?.('model', { ...p, fileName: file, fileIndex: index + 1, fileCount: missing.length }),
    });
  }
  return modelDir;
}
