import { existsSync, readdirSync, statSync } from 'fs';
import { mkdir, readdir, rename, rm } from 'fs/promises';
import { join } from 'path';
import { DownloadProgress, downloadFile } from './downloader';
import { extractArchive } from './extract';
import { ENGINE_STATUS, EngineStatus } from './engine_status';
import { DirModelSpec, dirModelFileUrl } from './kind_catalog';
import { LocalModelSpec, localModelUrl } from './model_catalog';
import { EnginePaths } from './paths';
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
  useLocalDistro: (choice: string) => Promise<T>;
  downloadAsset: () => Promise<T>;
}): Promise<T> {
  const ask = deps.host.askDistroOrDownload;
  if (ask !== undefined) {
    // A status before the question: it blocks the flow, and the progress toast
    // would otherwise keep showing the previous stage.
    deps.host.onStatus({ status: ENGINE_STATUS.awaitingInput, prompt: deps.prompt });
    const choice = await ask(deps.kind);
    if (choice === undefined) {
      throw new DOMException('Canceled', 'AbortError');
    }
    if (choice !== DISTRO_CHOICE_DOWNLOAD) {
      return deps.useLocalDistro(choice);
    }
  }
  return deps.downloadAsset();
}

async function downloadTo(
  host: ProvisioningHost,
  signal: AbortSignal | undefined,
  opts: { url: string; destination: string; kind: 'engine' | 'model'; onProgress?: (p: DownloadProgress) => void },
): Promise<void> {
  await (host.download ?? downloadFile)({
    url: opts.url,
    destination: opts.destination,
    signal,
    onProgress: opts.onProgress ?? ((p) => host.onProgress?.(opts.kind, p)),
  });
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
      await downloadTo(host, signal, { url: asset.url, destination: archivePath, kind: 'engine' });
      await (host.extract ?? extractArchive)({ archivePath, destDir: tagDir, signal });
      await rm(archivePath, { force: true });
      const binary = findBinary(tagDir, host.platform, 'llama-server');
      if (binary === undefined) {
        throw new Error(`llama-server not found in the extracted engine (${tagDir}).`);
      }
      return binary;
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
      await downloadTo(host, signal, { url: asset.url, destination: archivePath, kind: 'engine' });
      // Extract into a staging dir (extractArchive wipes destDir on failure and
      // engineRoot holds other engines), then move the archive's top folder up.
      const stagingDir = join(paths.engineRoot, `${topDir}.staging`);
      await (host.extract ?? extractArchive)({ archivePath, destDir: stagingDir, signal });
      // A previous interrupted install can leave the target shell behind; rename
      // onto an existing directory fails on Windows.
      await rm(runtimeRoot, { recursive: true, force: true });
      await rename(join(stagingDir, topDir), runtimeRoot);
      await rm(stagingDir, { recursive: true, force: true });
      await rm(archivePath, { force: true });
      for (const entry of await readdir(paths.engineRoot)) {
        // Stale installs from the previous two-level layout (ov-genai-<version>/...).
        if (entry.startsWith('ov-genai-')) {
          await rm(join(paths.engineRoot, entry), { recursive: true, force: true });
        }
      }
      return runtimeRoot;
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
