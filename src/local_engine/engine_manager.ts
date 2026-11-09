import { BRAND } from '../brand';
import { existsSync } from 'fs';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { LocalDevice } from '../config';
import { messageOf } from '../errors';
import { SupportedDevice, deviceChain, NPU_CONTEXT_LENGTH } from './device';
import { npuGeneration } from './capability';
import { pickTemplateForModel } from '../model_selection';
import { llamaArgs, startEngine, RunningEngine, RunnerDeps, withModelPlaceholder } from './engine_runner';
import { ENGINE_STATUS, EngineStatus } from './engine_status';
import { IrFormat, irModel } from './ir_model_catalog';
import { isLocalModelId, LOCAL_MODEL_IDS, LocalModelId, localModel } from './model_catalog';
import { catalogModelDir, catalogModelFiles, catalogSpec, EngineKind, removeCatalogModel } from './kind_catalog';
import { mlxModel } from './mlx_model_catalog';
import { EnginePaths } from './paths';
import { ovGenaiLibDir, ovGenaiTbbDir } from './ov_runtime';
import { probeRunnerVersion, RunningStdioRunner, startStdioRunner } from './stdio_runner';
import { ProvisioningHost, ensureDirModel, ensureGgufModel, ensureLlamaEngine, ensureOvGenaiRuntime } from './provisioning';

export type ResetTarget = 'engine' | 'model' | 'cache';

export interface EngineManagerSettings {
  modelId: string;
  /** True when tlc.local.model holds an explicit value; while unset the catalog picker decides what to download. */
  modelIdExplicit: boolean;
  device: LocalDevice;
  engineKind: EngineKind;
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

/** One entry of the "which model to download" picker. */
export interface ModelDownloadChoice {
  id: LocalModelId;
  label: string;
  detail: string;
  downloaded: boolean;
}

export interface EngineManagerHost extends RunnerDeps, ProvisioningHost {
  paths: () => EnginePaths;
  settings: () => EngineManagerSettings;
  notify: (message: string) => void;
  warn: (message: string) => void;
  /** Injectable runner `--version` probe (defaults to the real spawn). */
  probeRunnerVersion?: typeof probeRunnerVersion;
  /** Injectable NPU generation probe (defaults to cached platform WMI/PCI probing). */
  npuGeneration?: typeof npuGeneration;
  /** Offered while no catalog model is selected yet (tlc.local.model unset); returns the picked id, or undefined when dismissed. */
  askModelDownload?: (currentId: string, choices: ModelDownloadChoice[]) => Promise<string | undefined>;
  /** Persists a model picked for download (tlc.local.model). */
  setLocalModel?: (id: string) => Promise<void>;
}

/** The running ovgenai stdio runner exposed for the completions transport. */
export type RunningLocalEngine = RunningEngine | RunningStdioRunner;

const isStdioRunner = (engine: RunningLocalEngine): engine is RunningStdioRunner =>
  typeof (engine as RunningStdioRunner).stream === 'function';

// Context length for a custom (From-disk) model: the file's real context is
// unknown; this matches the catalog models' window.
const CUSTOM_MODEL_CONTEXT_LENGTH = 32_768;

/** Restarts a hung NPU compile: 30 min without any stderr output. */
const NPU_READY_IDLE_TIMEOUT_MS = 30 * 60_000;

export class EngineManager {
  private engine: RunningLocalEngine | undefined;
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
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < 60_000);
    this.crashTimes.push(now);
    this.host.warn(`${BRAND} local engine: ${message}; restarting.`);
    if (this.crashTimes.length > 3) {
      this.host.onStatus({ status: ENGINE_STATUS.error, message: `the local engine keeps exiting (${message}); restart manually via ${BRAND}: Reset Local Engine` });
      return;
    }
    void this.ensureReady().catch(() => undefined);
  };


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

  /** Runs `attempt` down the device chain until one start succeeds; each failure is remembered for the summary notice. */
  private async startWithDeviceFallback<T extends RunningLocalEngine>(
    devices: SupportedDevice[],
    attempt: (device: SupportedDevice) => Promise<T>,
  ): Promise<{ engine: T; device: SupportedDevice; fallbacks: string[] }> {
    let activeDevice = devices[0];
    const fallbacks: string[] = [];
    for (;;) {
      try {
        const engine = await attempt(activeDevice);
        return { engine, device: activeDevice, fallbacks };
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw err;
        }
        const next = devices[devices.indexOf(activeDevice) + 1];
        if (next === undefined) {
          throw err;
        }
        const message = messageOf(err);
        this.host.warn(`${BRAND} local engine: start on ${activeDevice} failed (${message}); retrying on ${next}.`);
        fallbacks.push(`${activeDevice.toUpperCase()}: ${message}`);
        activeDevice = next;
      }
    }
  }

  private notifyFallbacks(device: SupportedDevice, fallbacks: string[]): void {
    if (fallbacks.length === 0) {
      return;
    }
    const failed = fallbacks.map((f) => f.split(':')[0]).join(', ');
    const reasons = fallbacks.map((f) => f.replace(': ', ' — ')).join('; ');
    this.host.notify(`${BRAND}: started on ${device.toUpperCase()} — ${failed} unavailable (${reasons})`);
  }

  async stop(): Promise<void> {
    const engine = this.engine;
    this.engine = undefined;
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
        await removeCatalogModel(paths, this.host.settings().engineKind, this.host.settings().modelId);
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
        throw new Error(`tlc.local.model is "custom" — set tlc.local.customModelPath to a model file (${BRAND}: Select Local Model → From disk…).`);
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

      const serverPath = await ensureLlamaEngine(this.host, paths, settings, this.activeSignal);
      const modelPath = await ensureGgufModel(this.host, paths, model, settings, this.activeSignal);
      this.host.onStatus({ status: ENGINE_STATUS.starting, npuCompile: false });

      const { engine, device: activeDevice, fallbacks } = await this.startWithDeviceFallback(devices, (device) => {
        const args = withModelPlaceholder(llamaArgs(contextLength, device), modelPath);
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
      });
      this.notifyFallbacks(activeDevice, fallbacks);
      this.engine = engine;
      const status: EngineStatus = {
        status: ENGINE_STATUS.ready,
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
        const message = messageOf(err);
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
    const runtimeRoot = await ensureOvGenaiRuntime(this.host, paths, settings, this.activeSignal);
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
    let activeDevice: SupportedDevice;
    let lastModelPath = '';
    const started = await this.startWithDeviceFallback(devices, async (device) => {
      const modelPath = model !== undefined ? await ensureDirModel(this.host, paths, irModel(model.id, formatFor(device)), settings, this.activeSignal) : settings.modelPath;
      lastModelPath = modelPath;
      this.host.log(`ovgenai: loading ${model?.label ?? settings.modelPath} on ${device.toUpperCase()} (${modelPath})`);
      this.host.onStatus({ status: ENGINE_STATUS.starting, npuCompile: device === 'npu' });
      return startStdioRunner(
        {
          runnerPath,
          modelPath,
          device: device.toUpperCase(),
          contextLength,
          // The runner's own CACHE_DIR default is relative to its cwd (the
          // extension host's, unpredictable); pin it to the model cache so
          // compiled blobs persist across starts. Blob caches are
          // device-specific (incompatible blobs) — one folder per device.
          props: device === 'npu' || device === 'gpu' ? { CACHE_DIR: join(paths.modelCacheDir, `${device}-blobs`) } : undefined,
          signal: this.activeSignal,
          // NPU watcher: a graph compile can take unbounded wall time, so
          // re-arm on each stderr line instead; 30 min of silence means a
          // hung compiler pass. A dead runner is still detected via the
          // exit check.
          readyIdleTimeoutMs: device === 'npu' ? NPU_READY_IDLE_TIMEOUT_MS : undefined,
          libraryDirs,
          onUnexpectedExit: (message) => this.handleUnexpectedExit(`ovgenai ${message}`),
          onStderr: (line) => this.host.log(`ovgenai: ${line}`),
        },
        this.host,
      );
    });
    runner = started.engine;
    activeDevice = started.device;
    this.notifyFallbacks(activeDevice, started.fallbacks);
    this.engine = runner;
    const status: EngineStatus = {
      status: ENGINE_STATUS.ready,
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
    const modelPath = await ensureDirModel(this.host, paths, model, settings, this.activeSignal);
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
    const status: EngineStatus = {
      status: ENGINE_STATUS.ready,
      baseUrl: '',
      apiKey: undefined,
      model: settings.modelId,
      modelPath,
    };
    this.host.onStatus(status);
    return status;
  }

  /**
   * The catalog picker runs only while no model is selected yet (tlc.local.model
   * unset); an explicit choice downloads without asking. The pick is persisted
   * via `setLocalModel` and reflected into `settings.modelId` so the running
   * start uses it. Dismissing cancels the start.
   */
  private async chooseModelToDownload(
    paths: EnginePaths,
    settings: EngineManagerSettings,
    format: IrFormat = 'int8',
  ): Promise<void> {
    const ask = this.host.askModelDownload;
    if (ask === undefined || this.modelDownloadAsked || settings.modelIdExplicit || !isLocalModelId(settings.modelId)) {
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

  private modelDownloadChoices(paths: EnginePaths, kind: EngineKind, format: IrFormat): ModelDownloadChoice[] {
    const sizeLabel = (bytes: number): string => `${(bytes / 1_000_000_000).toFixed(1)} GB`;
    return LOCAL_MODEL_IDS.map((id) => {
      const spec = catalogSpec(kind, id, format);
      const modelDir = catalogModelDir(paths, kind, id, format);
      const downloaded = catalogModelFiles(kind, id, format).every((file) => existsSync(join(modelDir, file)));
      return {
        id,
        label: spec.label,
        detail: downloaded ? 'already downloaded' : `${sizeLabel(spec.approximateBytes)} download · id: ${id}`,
        downloaded,
      };
    });
  }
}
