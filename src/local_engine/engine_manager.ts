import { BRAND } from '../brand';
import { existsSync, readdirSync, statSync } from 'fs';
import { mkdir, readdir, rename, rm } from 'fs/promises';
import { join } from 'path';
import { LocalDevice } from '../config';
import { deviceChain, NPU_CONTEXT_LENGTH } from './device';
import { npuGeneration } from './capability';
import { downloadFile, DownloadProgress } from './downloader';
import { pickTemplateForModel } from '../model_selection';
import { extractArchive } from './extract';
import { llamaArgs, startEngine, RunningEngine, RunnerDeps, withModelPlaceholder } from './engine_runner';
import { IrFormat, irModel, irModelFileUrl } from './ir_model_catalog';
import { isLocalModelId, LOCAL_MODEL_IDS, LocalModelId, LocalModelSpec, localModel, localModelUrl } from './model_catalog';
import { mlxModel, mlxModelFileUrl } from './mlx_model_catalog';
import { EnginePaths } from './paths';
import { OV_GENAI_VERSION, ovGenaiLibDir, ovGenaiTbbDir, resolveOvGenaiAsset, runnerOvGenaiVersion } from './ov_runtime';
import { resolveEngineAsset } from './release_assets';
import { probeRunnerVersion, RunningStdioRunner, startStdioRunner } from './stdio_runner';

/** Engine lifecycle phase names: the discriminant values of EngineStatus below, shared with its consumers. */
export const ENGINE_STATUS = {
  notInstalled: 'not-installed',
  awaitingInput: 'awaiting-input',
  preparingEngine: 'preparing-engine',
  preparingModel: 'preparing-model',
  starting: 'starting',
  ready: 'ready',
  error: 'error',
} as const;

export type EngineStatus =
  | { status: typeof ENGINE_STATUS.notInstalled }
  | { status: typeof ENGINE_STATUS.awaitingInput; prompt: string }
  | { status: typeof ENGINE_STATUS.preparingEngine }
  | { status: typeof ENGINE_STATUS.preparingModel }
  | { status: typeof ENGINE_STATUS.starting; /** Only the NPU compiles the model graph; the hint is shown just for it. */ npuCompile?: boolean }
  | { status: typeof ENGINE_STATUS.ready; baseUrl: string; apiKey: string | undefined; model: string; modelPath: string; device: LocalDevice }
  | { status: typeof ENGINE_STATUS.error; message: string };

/** The running ovgenai stdio runner exposed for the completions transport. */
export type RunningLocalEngine = RunningEngine | RunningStdioRunner;

export const isStdioRunner = (engine: RunningLocalEngine): engine is RunningStdioRunner =>
  typeof (engine as RunningStdioRunner).stream === 'function';

export type ResetTarget = 'engine' | 'model' | 'cache';

// Context length for a custom (From-disk) model: the file's real context is
// unknown; this matches the catalog models' window.
const CUSTOM_MODEL_CONTEXT_LENGTH = 32_768;

export interface EngineManagerSettings {
  modelId: string;
  device: LocalDevice;
  engineKind: 'llama.cpp' | 'ovgenai' | 'mlx';
  npuContextLength: number;
  releaseTag: string;
  /** Locally unpacked engine distribution (or a llama-server binary file) used instead of downloading; for ovgenai an OpenVINO GenAI runtime folder. */
  distroDir: string;
  huggingfaceUrl: string;
  githubUrl: string;
  openvinoUrl: string;
  modelPath: string;
  /** Path of the bundled ovgenai runner binary; undefined when the platform is unsupported. */
  ovgenaiRunnerPath?: string;
  /** Path of the bundled mlx runner binary; undefined outside macOS arm64. */
  mlxRunnerPath?: string;
  /** When false the engine runs without key authentication (engine debugging). */
  apiKeyEnabled: boolean;
}

/** Marker `askDistroOrDownload` returns when the user opts into downloading. */
export const DISTRO_CHOICE_DOWNLOAD = 'download';

/** One entry of the "which model to download" picker. */
export interface ModelDownloadChoice {
  id: LocalModelId;
  label: string;
  detail: string;
  downloaded: boolean;
}

export interface EngineManagerHost extends RunnerDeps {
  platform: NodeJS.Platform;
  arch: string;
  paths: () => EnginePaths;
  settings: () => EngineManagerSettings;
  onStatus: (status: EngineStatus) => void;
  onProgress?: (kind: 'engine' | 'model', progress: DownloadProgress) => void;
  notify: (message: string) => void;
  warn: (message: string) => void;
  download?: typeof downloadFile;
  extract?: typeof extractArchive;
  /** Injectable runner `--version` probe (defaults to the real spawn). */
  probeRunnerVersion?: typeof probeRunnerVersion;
  /** Injectable NPU generation probe (defaults to cached platform WMI/PCI probing). */
  npuGeneration?: typeof npuGeneration;
  /** Returns a picked distro folder, DISTRO_CHOICE_DOWNLOAD, or undefined when dismissed. */
  askDistroOrDownload?: (kind: 'ovgenai' | 'llama.cpp') => Promise<string | typeof DISTRO_CHOICE_DOWNLOAD | undefined>;
  /** Offered when the configured catalog model is not downloaded yet; returns the picked id, or undefined when dismissed. */
  askModelDownload?: (currentId: string, choices: ModelDownloadChoice[]) => Promise<string | undefined>;
  /** Persists a model picked for download (tlc.local.model). */
  setLocalModel?: (id: string) => Promise<void>;
}

export class EngineManager {
  private engine: RunningLocalEngine | undefined;
  private runningModel: string | undefined;
  private runningDevice: LocalDevice | undefined;
  private startPromise: Promise<EngineStatus> | undefined;
  private crashTimes: number[] = [];
  /** The model-download question is asked once per start: device-fallback retries must not re-ask. */
  private modelDownloadAsked = false;

  constructor(private readonly host: EngineManagerHost) {}

  /** Auto-restart when the server process dies on its own (crash loop guard: 3 per minute). */
  private handleUnexpectedExit = (message: string): void => {
    if (this.engine === undefined) {
      // Exits during start()/stop() are handled by their own flows.
      return;
    }
    this.engine = undefined;
    this.runningModel = undefined;
    this.runningDevice = undefined;
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < 60_000);
    this.crashTimes.push(now);
    this.host.warn(`${BRAND} local engine: ${message}; restarting.`);
    if (this.crashTimes.length > 3) {
      this.host.onStatus({ status: 'error', message: `the local engine keeps exiting (${message}); restart manually via ${BRAND}: Reset Local Engine` });
      return;
    }
    void this.ensureReady().catch(() => undefined);
  };

  current(): EngineStatus {
    if (this.engine !== undefined && this.runningModel !== undefined && this.runningDevice !== undefined) {
      if (isStdioRunner(this.engine)) {
        return {
          status: 'ready',
          baseUrl: '',
          apiKey: undefined,
          model: this.runningModel,
          modelPath: this.engine.modelPath,
          device: this.runningDevice,
        };
      }
      return {
        status: 'ready',
        baseUrl: this.engine.baseUrl,
        apiKey: this.engine.apiKey,
        model: this.runningModel,
        modelPath: this.engine.modelPath,
        device: this.runningDevice,
      };
    }
    return { status: ENGINE_STATUS.notInstalled };
  }

  /**
   * Makes sure the engine and model are present and the server is running
   * with the configured model and device. Concurrent calls share one start.
   * `signal` cancels pending downloads.
   */
  async ensureReady(signal?: AbortSignal): Promise<EngineStatus> {
    if (this.startPromise === undefined) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = undefined;
      });
    }
    this.activeSignal = signal;
    return this.startPromise;
  }

  private activeSignal: AbortSignal | undefined;

  async stop(): Promise<void> {
    const engine = this.engine;
    this.engine = undefined;
    this.runningModel = undefined;
    this.runningDevice = undefined;
    await engine?.stop();
  }

  /** Stops the server and starts it again (model/device change, reset). */
  async restart(signal?: AbortSignal): Promise<EngineStatus> {
    await this.stop();
    return this.ensureReady(signal);
  }

  async reset(target: ResetTarget, signal?: AbortSignal): Promise<EngineStatus> {
    const paths = this.host.paths();
    if (target === 'engine') {
      await rm(paths.engineRoot, { recursive: true, force: true });
    } else if (target === 'model') {
      // A custom (From-disk) model file is user-owned — nothing managed to delete.
      if (this.host.settings().modelPath.length === 0) {
        if (this.host.settings().engineKind === 'ovgenai') {
          for (const format of ['nf4', 'int8'] as const) {
            await rm(irModelDir(paths, this.host.settings().modelId, format), { recursive: true, force: true });
          }
        } else if (this.host.settings().engineKind === 'mlx') {
          await rm(mlxModelDir(paths, this.host.settings().modelId), { recursive: true, force: true });
        } else {
          await rm(modelFilePath(paths, this.host.settings().modelId), { force: true });
        }
      }
    } else {
      await rm(paths.modelCacheDir, { recursive: true, force: true });
      await mkdir(paths.modelCacheDir, { recursive: true });
    }
    return this.restart(signal);
  }

  private async start(): Promise<EngineStatus> {
    try {
      await this.stop();
      this.modelDownloadAsked = false;
      const paths = this.host.paths();
      const settings = this.host.settings();
      if (settings.modelId === 'custom' && settings.modelPath.length === 0) {
        throw new Error('tlc.local.model is "custom" — set tlc.local.customModelPath to a model file (${BRAND}: Select Local Model → From disk…).`');
      }
      if (settings.modelPath.length > 0 && pickTemplateForModel(settings.modelPath) === undefined) {
        // Catalog models are validated Qwen2.5-Coder builds; an offline model
        // whose family cannot be recognized may not fit the FIM pipeline.
        this.host.warn(`${BRAND} local engine: model "${settings.modelPath}" was not validated for FIM completions — quality may vary.`);
      }
      if (settings.engineKind === 'ovgenai') {
        return await this.startOvgenai(paths, settings);
      }
      if (settings.engineKind === 'mlx') {
        return await this.startMlx(paths, settings);
      }
      if (settings.modelPath.length === 0 && !isLocalModelId(settings.modelId)) {
        throw new Error(`Unknown local model "${settings.modelId}".`);
      }
      let model = isLocalModelId(settings.modelId) ? localModel(settings.modelId) : undefined;
      if (model !== undefined) {
        await this.chooseModelToDownload(paths, settings);
        model = isLocalModelId(settings.modelId) ? localModel(settings.modelId) : model;
      }
      const contextLength = model !== undefined ? model.contextLength : CUSTOM_MODEL_CONTEXT_LENGTH;
      const devices = deviceChain(settings.device);
      if (settings.device === 'npu') {
        this.host.warn(`${BRAND} local engine: the NPU is supported only by the OpenVINO GenAI engine; using GPU instead.`);
      }

      const serverPath = await this.ensureLlamaEngine(paths, settings);
      const modelPath = await this.ensureGgufModel(paths, model, settings);
      this.host.onStatus({ status: ENGINE_STATUS.starting, npuCompile: false });

      const startOne = (active: (typeof devices)[number]): Promise<RunningEngine> => {
        const args = withModelPlaceholder(llamaArgs(contextLength, active), modelPath);
        return startEngine(
          {
            serverPath,
            modelPath,
            args,
            env: {},
            apiKeyEnabled: settings.apiKeyEnabled,
            onUnexpectedExit: (message) => this.handleUnexpectedExit(message),
          },
          this.host,
        );
      };

      let engine: RunningEngine | undefined;
      let activeDevice = devices[0];
      const fallbacks: string[] = [];
      for (;;) {
        try {
          engine = await startOne(activeDevice);
          break;
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            throw err;
          }
          const next = devices[devices.indexOf(activeDevice) + 1];
          if (next === undefined) {
            throw err;
          }
          const message = err instanceof Error ? err.message : String(err);
          this.host.warn(`${BRAND} local engine: start on ${activeDevice} failed (${message}); retrying on ${next}.`);
          fallbacks.push(`${activeDevice.toUpperCase()}: ${message}`);
          activeDevice = next;
        }
      }
      if (fallbacks.length > 0) {
        const failed = fallbacks.map((f) => f.split(':')[0]).join(', ');
        const reasons = fallbacks.map((f) => f.replace(': ', ' — ')).join('; ');
        this.host.notify(`${BRAND}: started on ${activeDevice.toUpperCase()} — ${failed} unavailable (${reasons})`);
      }
      this.engine = engine;
      this.runningModel = settings.modelId;
      this.runningDevice = activeDevice;
      const status: EngineStatus = {
        status: 'ready',
        baseUrl: engine.baseUrl,
        apiKey: engine.apiKey,
        model: settings.modelId,
        modelPath,
        device: activeDevice,
      };
      this.host.onStatus(status);
      return status;
    } catch (err) {
      // A user-initiated cancel (dismissed question, aborted download) is
      // already silent at the task level — don't paint the status bar red.
      if (err instanceof Error && err.name === 'AbortError') {
        // A user cancel must not leave the status bar spinning on "starting".
        this.host.onStatus({ status: ENGINE_STATUS.error, message: 'start canceled' });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.host.onStatus({ status: ENGINE_STATUS.error, message });
      }
      await this.stop();
      throw err;
    }
  }

  private async startOvgenai(paths: EnginePaths, settings: EngineManagerSettings): Promise<EngineStatus> {
    const runnerPath = settings.ovgenaiRunnerPath;
    if (runnerPath === undefined || runnerPath.length === 0) {
      throw new Error(`The OpenVINO GenAI runner is not bundled for ${this.host.platform}/${this.host.arch}.`);
    }
    if (settings.modelPath.length === 0 && !isLocalModelId(settings.modelId)) {
      throw new Error(`Unknown local model "${settings.modelId}".`);
    }
    const baseModel = isLocalModelId(settings.modelId) ? irModel(settings.modelId) : undefined;
    // The NPU leads the auto chain only for NPU generation 4+ hardware.
    const npuGen = settings.device === 'auto' ? await (this.host.npuGeneration ?? npuGeneration)(this.host.platform) : 0;
    const devices = deviceChain(settings.device, 'ovgenai', npuGen);
    // nf4 weights are the NPU format; GPU/CPU run int8. Resolved per attempt:
    // the device chain can fall back (npu -> gpu) and switch the format.
    const formatFor = (device: string): IrFormat => (device === 'npu' ? 'nf4' : 'int8');
    if (baseModel !== undefined) {
      await this.chooseModelToDownload(paths, settings, formatFor(devices[0]));
    }
    const model = isLocalModelId(settings.modelId) ? irModel(settings.modelId) : undefined;
    const runtimeRoot = await this.ensureOvGenaiRuntime(paths, settings);
    const libDir = ovGenaiLibDir(this.host.platform, runtimeRoot);
    // The Windows runner links TBB directly; its dlls sit outside the OpenVINO bin dir.
    const tbbDir = ovGenaiTbbDir(this.host.platform, runtimeRoot);
    const libraryDirs = tbbDir !== undefined && existsSync(tbbDir) ? [libDir, tbbDir] : [libDir];
    this.host.onStatus({ status: ENGINE_STATUS.starting });
    // Support diagnostics: the runner reports its own app version and the
    // OpenVINO GenAI version it was built against (undefined for old runners
    // without --version).
    const versions = await (this.host.probeRunnerVersion ?? probeRunnerVersion)(runnerPath, libraryDirs, this.host);
    this.host.log(`ovgenai runner version: app=${versions?.app ?? 'unknown'} ovGenai=${versions?.ovGenai ?? 'unknown'}`);

    const baseContextLength = model !== undefined ? model.contextLength : CUSTOM_MODEL_CONTEXT_LENGTH;
    const contextLength = devices[0] === 'npu' || settings.device === 'npu'
      ? Math.min(baseContextLength, settings.npuContextLength > 0 ? settings.npuContextLength : NPU_CONTEXT_LENGTH)
      : baseContextLength;

    if (baseModel === undefined && !existsSync(settings.modelPath)) {
      throw new Error(`Local model file or directory not found: ${settings.modelPath}`);
    }

    let runner: RunningStdioRunner | undefined;
    let activeDevice = devices[0];
    let lastModelPath = '';
    const fallbacks: string[] = [];
    for (;;) {
      const modelPath = model !== undefined ? await this.ensureIrModel(paths, irModel(model.id, formatFor(activeDevice)), settings) : settings.modelPath;
      lastModelPath = modelPath;
      try {
        this.host.log(`ovgenai: loading ${model?.label ?? settings.modelPath} on ${activeDevice.toUpperCase()} (${modelPath})`);
        this.host.onStatus({ status: ENGINE_STATUS.starting, npuCompile: activeDevice === 'npu' });
        runner = await startStdioRunner(
          {
            runnerPath,
            modelPath,
            device: activeDevice.toUpperCase(),
            contextLength,
            // The runner's own CACHE_DIR default is relative to its cwd (the
            // extension host's, unpredictable); pin it to the model cache so
            // compiled blobs persist across starts. Blob caches are
            // device-specific (incompatible blobs) — one folder per device.
            props: activeDevice === 'npu' || activeDevice === 'gpu' ? { CACHE_DIR: join(paths.modelCacheDir, `${activeDevice}-blobs`) } : undefined,
            signal: this.activeSignal,
            // First NPU start compiles the graph, which can take unbounded
            // time; a dead runner is still detected via the exit check.
            readyTimeoutMs: activeDevice === 'npu' ? Number.POSITIVE_INFINITY : undefined,
            libraryDirs,
            onUnexpectedExit: (message) => this.handleUnexpectedExit(`ovgenai ${message}`),
            onStderr: (line) => this.host.log(`ovgenai: ${line}`),
          },
          this.host,
        );
        break;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw err;
        }
        const next = devices[devices.indexOf(activeDevice) + 1];
        if (next === undefined) {
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        this.host.warn(`${BRAND} local engine: start on ${activeDevice} failed (${message}); retrying on ${next}.`);
        fallbacks.push(`${activeDevice.toUpperCase()}: ${message}`);
        activeDevice = next;
      }
    }
    if (fallbacks.length > 0) {
      const failed = fallbacks.map((f) => f.split(':')[0]).join(', ');
      const reasons = fallbacks.map((f) => f.replace(': ', ' — ')).join('; ');
      this.host.notify(`${BRAND}: started on ${activeDevice.toUpperCase()} — ${failed} unavailable (${reasons})`);
    }
    this.engine = runner;
    this.runningModel = settings.modelId;
    this.runningDevice = activeDevice;
    const status: EngineStatus = {
      status: 'ready',
      // The stdio runner has no HTTP endpoint; completions go through
      // `EngineManager.stdioRunner` instead of a base URL.
      baseUrl: '',
      apiKey: undefined,
      model: settings.modelId,
      modelPath: lastModelPath,
      device: activeDevice,
    };
    this.host.onStatus(status);
    return status;
  }

  /** The running stdio runner, for the completions transport (ovgenai kind). */
  stdioRunner(): RunningStdioRunner | undefined {
    return this.engine !== undefined && isStdioRunner(this.engine) ? this.engine : undefined;
  }

  private async startMlx(paths: EnginePaths, settings: EngineManagerSettings): Promise<EngineStatus> {
    const runnerPath = settings.mlxRunnerPath;
    if (runnerPath === undefined || runnerPath.length === 0) {
      throw new Error(`The MLX runner is not bundled for ${this.host.platform}/${this.host.arch} (macOS arm64 only).`);
    }
    if (settings.modelPath.length === 0 && !isLocalModelId(settings.modelId)) {
      throw new Error(`Unknown local model "${settings.modelId}".`);
    }
    let model = isLocalModelId(settings.modelId) ? mlxModel(settings.modelId) : undefined;
    if (model !== undefined) {
      await this.chooseModelToDownload(paths, settings);
      model = isLocalModelId(settings.modelId) ? mlxModel(settings.modelId) : model;
    }
    const modelPath = await this.ensureMlxModel(paths, model, settings);
    this.host.onStatus({ status: ENGINE_STATUS.starting });
    // Metal is the only MLX backend; no device fallback chain.
    const runner = await startStdioRunner(
      {
        runnerPath,
        modelPath,
        contextLength: model !== undefined ? model.contextLength : CUSTOM_MODEL_CONTEXT_LENGTH,
        label: 'mlx',
        onUnexpectedExit: (message) => this.handleUnexpectedExit(`mlx ${message}`),
        onStderr: (line) => this.host.log(`mlx: ${line}`),
        signal: this.activeSignal,
      },
      this.host,
    );
    this.engine = runner;
    this.runningModel = settings.modelId;
    this.runningDevice = 'gpu';
    const status: EngineStatus = {
      status: 'ready',
      baseUrl: '',
      apiKey: undefined,
      model: settings.modelId,
      modelPath,
      device: 'gpu',
    };
    this.host.onStatus(status);
    return status;
  }

  /**
   * When the configured catalog model is not downloaded yet, offers the whole
   * catalog instead of silently downloading the configured one. The pick is
   * persisted via `setLocalModel` and reflected into `settings.modelId` so the
   * running start uses it. Dismissing cancels the start.
   */
  private async chooseModelToDownload(
    paths: EnginePaths,
    settings: EngineManagerSettings,
    format: IrFormat = 'int8',
  ): Promise<void> {
    const ask = this.host.askModelDownload;
    if (ask === undefined || this.modelDownloadAsked || !isLocalModelId(settings.modelId)) {
      return;
    }
    const choices = this.modelDownloadChoices(paths, settings.engineKind, format);
    const current = choices.find((c) => c.id === settings.modelId);
    if (current === undefined || current.downloaded) {
      return;
    }
    this.modelDownloadAsked = true;
    this.host.onStatus({ status: ENGINE_STATUS.awaitingInput, prompt: 'choose which model to download' });
    const chosen = await ask(settings.modelId, choices);
    if (chosen === undefined) {
      throw new DOMException('Canceled', 'AbortError');
    }
    if (chosen !== settings.modelId) {
      settings.modelId = chosen;
      await this.host.setLocalModel?.(chosen);
    }
  }

  private modelDownloadChoices(paths: EnginePaths, kind: EngineManagerSettings['engineKind'], format: IrFormat): ModelDownloadChoice[] {
    const sizeLabel = (bytes: number): string => `${(bytes / 1_000_000_000).toFixed(1)} GB`;
    return LOCAL_MODEL_IDS.map((id) => {
      const downloaded = kind === 'mlx'
        ? mlxModel(id).files.every((file) => existsSync(join(mlxModelDir(paths, id), file)))
        : kind === 'ovgenai'
          ? irModel(id, format).files.every((file) => existsSync(join(irModelDir(paths, id, format), file)))
          : existsSync(join(paths.modelDir, localModel(id).fileName));
      const bytes = kind === 'mlx' ? mlxModel(id).approximateBytes : kind === 'ovgenai' ? irModel(id, format).approximateBytes : localModel(id).approximateBytes;
      return {
        id,
        label: kind === 'mlx' ? mlxModel(id).label : kind === 'ovgenai' ? irModel(id, format).label : localModel(id).label,
        detail: downloaded ? 'already downloaded' : `${sizeLabel(bytes)} download · id: ${id}`,
        downloaded,
      };
    });
  }

  private async ensureMlxModel(paths: EnginePaths, model: ReturnType<typeof mlxModel> | undefined, settings: EngineManagerSettings): Promise<string> {
    if (settings.modelPath.length > 0) {
      if (!existsSync(settings.modelPath)) {
        throw new Error(`Local model file or directory not found: ${settings.modelPath}`);
      }
      return settings.modelPath;
    }
    if (model === undefined) {
      throw new Error(`Unknown local model "${settings.modelId}".`);
    }
    const modelDir = mlxModelDir(paths, model.id);
    const missing = model.files.filter((file) => !existsSync(join(modelDir, file)));
    if (missing.length === 0) {
      return modelDir;
    }
    this.host.onStatus({ status: ENGINE_STATUS.preparingModel });
    await mkdir(modelDir, { recursive: true });
    for (const [index, file] of missing.entries()) {
      const url = mlxModelFileUrl(model, file, settings.huggingfaceUrl);
      await (this.host.download ?? downloadFile)({
        url,
        destination: join(modelDir, file),
        signal: this.activeSignal,
        onProgress: (p) => this.host.onProgress?.('model', { ...p, fileName: file, fileIndex: index + 1, fileCount: missing.length }),
      });
    }
    return modelDir;
  }

  /** Returns the unpacked OpenVINO GenAI runtime root (lib dirs derive from it). */
  private async ensureOvGenaiRuntime(paths: EnginePaths, settings: EngineManagerSettings): Promise<string> {
    const libDirOf = (root: string): string => ovGenaiLibDir(this.host.platform, root);
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
    const asset = resolveOvGenaiAsset(this.host.platform, this.host.arch, version, settings.openvinoUrl);
    if (asset === undefined) {
      throw new Error(`No OpenVINO GenAI runtime archive for ${this.host.platform}/${this.host.arch}.`);
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
    // A status before the question: it blocks the flow, and the progress toast
    // would otherwise keep showing the previous stage.
    const ask = this.host.askDistroOrDownload;
    if (ask !== undefined) {
      this.host.onStatus({ status: ENGINE_STATUS.awaitingInput, prompt: 'choose: download the OpenVINO GenAI runtime or use an existing unpacked folder' });
      const choice = await ask('ovgenai');
      if (choice === undefined) {
        throw new DOMException('Canceled', 'AbortError');
      }
      if (choice !== DISTRO_CHOICE_DOWNLOAD) {
        if (!existsSync(libDirOf(choice))) {
          throw new Error(`Local OpenVINO GenAI distribution has an unexpected layout: no runtime libraries under ${libDirOf(choice)}.`);
        }
        return choice;
      }
    }
    this.host.onStatus({ status: ENGINE_STATUS.preparingEngine });
    await mkdir(paths.engineRoot, { recursive: true });
    const archivePath = join(paths.engineRoot, asset.fileName);
    await (this.host.download ?? downloadFile)({
      url: asset.url,
      destination: archivePath,
      signal: this.activeSignal,
      onProgress: (p) => this.host.onProgress?.('engine', p),
    });
    // Extract into a staging dir (extractArchive wipes destDir on failure and
    // engineRoot holds other engines), then move the archive's top folder up.
    const stagingDir = join(paths.engineRoot, `${topDir}.staging`);
    await (this.host.extract ?? extractArchive)({ archivePath, destDir: stagingDir, signal: this.activeSignal });
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
    if (!existsSync(libDirOf(runtimeRoot))) {
      throw new Error(`OpenVINO runtime libraries not found after unpacking (${libDirOf(runtimeRoot)}).`);
    }
    return runtimeRoot;
  }

  private async ensureIrModel(paths: EnginePaths, model: ReturnType<typeof irModel> | undefined, settings: EngineManagerSettings): Promise<string> {
    if (settings.modelPath.length > 0) {
      if (!existsSync(settings.modelPath)) {
        throw new Error(`Local model file or directory not found: ${settings.modelPath}`);
      }
      return settings.modelPath;
    }
    if (model === undefined) {
      throw new Error(`Unknown local model "${settings.modelId}".`);
    }
    const modelDir = irModelDir(paths, model.id, model.format);
    const missing = model.files.filter((file) => !existsSync(join(modelDir, file)));
    if (missing.length === 0) {
      return modelDir;
    }
    this.host.onStatus({ status: ENGINE_STATUS.preparingModel });
    await mkdir(modelDir, { recursive: true });
    for (const [index, file] of missing.entries()) {
      const url = irModelFileUrl(model, file, settings.huggingfaceUrl);
      await (this.host.download ?? downloadFile)({
        url,
        destination: join(modelDir, file),
        signal: this.activeSignal,
        onProgress: (p) => this.host.onProgress?.('model', { ...p, fileName: file, fileIndex: index + 1, fileCount: missing.length }),
      });
    }
    return modelDir;
  }

  private async ensureLlamaEngine(paths: EnginePaths, settings: EngineManagerSettings): Promise<string> {
    if (settings.distroDir.length > 0) {
      // The setting accepts either a llama-server binary file or a folder
      // containing one (a full distribution layout).
      const isFile = existsSync(settings.distroDir) && statSync(settings.distroDir).isFile();
      const binary = isFile ? settings.distroDir : findBinary(settings.distroDir, this.host.platform, 'llama-server');
      if (binary === undefined) {
        throw new Error(`Local llama.cpp distribution has an unexpected layout: no llama-server binary in ${settings.distroDir}.`);
      }
      return binary;
    }
    const tag = settings.releaseTag;
    const tagDir = join(paths.engineRoot, `${tag}-llama-std`);
    const serverPath = findBinary(tagDir, this.host.platform, 'llama-server');
    if (serverPath !== undefined) {
      return serverPath;
    }
    const asset = resolveEngineAsset(this.host.platform, this.host.arch, tag, settings.githubUrl);
    if (asset === undefined) {
      throw new Error(`No llama.cpp release asset for ${this.host.platform}/${this.host.arch}.`);
    }
    // A status before the question: it blocks the flow, and the progress toast
    // would otherwise keep showing the previous stage.
    const ask = this.host.askDistroOrDownload;
    if (ask !== undefined) {
      this.host.onStatus({ status: ENGINE_STATUS.awaitingInput, prompt: 'choose: download the llama.cpp build or use an existing unpacked folder' });
      const choice = await ask('llama.cpp');
      if (choice === undefined) {
        throw new DOMException('Canceled', 'AbortError');
      }
      if (choice !== DISTRO_CHOICE_DOWNLOAD) {
        const binary = findBinary(choice, this.host.platform, 'llama-server');
        if (binary === undefined) {
          throw new Error(`Local llama.cpp distribution has an unexpected layout: no llama-server binary in ${choice}.`);
        }
        return binary;
      }
    }
    this.host.onStatus({ status: ENGINE_STATUS.preparingEngine });
    await mkdir(paths.engineRoot, { recursive: true });
    const archivePath = join(paths.engineRoot, asset.fileName);
    await (this.host.download ?? downloadFile)({
      url: asset.url,
      destination: archivePath,
      signal: this.activeSignal,
      onProgress: (p) => this.host.onProgress?.('engine', p),
    });
    await (this.host.extract ?? extractArchive)({ archivePath, destDir: tagDir, signal: this.activeSignal });
    await rm(archivePath, { force: true });
    const binary = findBinary(tagDir, this.host.platform, 'llama-server');
    if (binary === undefined) {
      throw new Error(`llama-server not found in the extracted engine (${tagDir}).`);
    }
    return binary;
  }

  private async ensureGgufModel(paths: EnginePaths, model: LocalModelSpec | undefined, settings: EngineManagerSettings): Promise<string> {
    if (settings.modelPath.length > 0) {
      if (!existsSync(settings.modelPath)) {
        throw new Error(`Local model file not found: ${settings.modelPath}`);
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
    this.host.onStatus({ status: ENGINE_STATUS.preparingModel });
    await mkdir(paths.modelDir, { recursive: true });
    await (this.host.download ?? downloadFile)({
      url,
      destination: modelPath,
      signal: this.activeSignal,
      onProgress: (p) => this.host.onProgress?.('model', p),
    });
    return modelPath;
  }
}

function modelFilePath(paths: EnginePaths, modelId: string): string {
  const model = isLocalModelId(modelId) ? localModel(modelId) : undefined;
  return model !== undefined ? join(paths.modelDir, model.fileName) : join(paths.modelDir, modelId);
}

// The model directory mirrors the Hugging Face layout: models/<owner>/<repo>;
// unknown ids keep a flat format-suffixed folder so families never collide.
function irModelDir(paths: EnginePaths, modelId: string, format: IrFormat): string {
  const spec = isLocalModelId(modelId) ? irModel(modelId, format) : undefined;
  return spec !== undefined ? join(paths.modelDir, spec.repo) : join(paths.modelDir, `${modelId}-nf4-ov`);
}

function mlxModelDir(paths: EnginePaths, modelId: string): string {
  const spec = isLocalModelId(modelId) ? mlxModel(modelId) : undefined;
  return spec !== undefined ? join(paths.modelDir, spec.repo) : join(paths.modelDir, `${modelId}-mlx`);
}

function findBinary(dir: string, platform: NodeJS.Platform, kind: 'llama-server'): string | undefined {
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
