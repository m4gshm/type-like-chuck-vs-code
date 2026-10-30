import { existsSync, readdirSync } from 'fs';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { LocalDevice } from '../config';
import { deviceChain, NPU_CONTEXT_LENGTH } from './device';
import { downloadFile, DownloadProgress } from './downloader';
import { extractArchive } from './extract';
import { llamaArgs, startEngine, RunningEngine, RunnerDeps, withModelPlaceholder } from './engine_runner';
import { irModel, irModelFileUrl } from './ir_model_catalog';
import { isLocalModelId, localModel, localModelUrl } from './model_catalog';
import { mlxModel, mlxModelFileUrl } from './mlx_model_catalog';
import { EnginePaths } from './paths';
import { OV_GENAI_VERSION, ovGenaiLibDir, resolveOvGenaiAsset } from './ov_runtime';
import { resolveEngineAsset, EngineVariant } from './release_assets';
import { RunningStdioRunner, startStdioRunner } from './stdio_runner';

export type EngineStatus =
  | { status: 'not-installed' }
  | { status: 'preparing-engine' }
  | { status: 'preparing-model' }
  | { status: 'starting' }
  | { status: 'ready'; baseUrl: string; apiKey: string | undefined; model: string; modelPath: string; device: LocalDevice }
  | { status: 'error'; message: string };

/** The running ovgenai stdio runner exposed for the completions transport. */
export type RunningLocalEngine = RunningEngine | RunningStdioRunner;

export const isStdioRunner = (engine: RunningLocalEngine): engine is RunningStdioRunner =>
  typeof (engine as RunningStdioRunner).stream === 'function';

export type ResetTarget = 'engine' | 'model' | 'cache';

export interface EngineManagerSettings {
  modelId: string;
  device: LocalDevice;
  engineKind: 'llama.cpp' | 'ovgenai' | 'mlx';
  npuContextLength: number;
  releaseTag: string;
  /** Local engine binary to use instead of downloading (llama-server). */
  engineBinary: string;
  huggingfaceUrl: string;
  githubUrl: string;
  openvinoUrl: string;
  modelPath: string;
  modelUrls: Record<string, string>;
  /** Path of the bundled ovgenai runner binary; undefined when the platform is unsupported. */
  ovgenaiRunnerPath?: string;
  /** Path of the bundled mlx runner binary; undefined outside macOS arm64. */
  mlxRunnerPath?: string;
  /** When false the engine runs without key authentication (engine debugging). */
  apiKeyEnabled: boolean;
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
}

export class EngineManager {
  private engine: RunningLocalEngine | undefined;
  private runningModel: string | undefined;
  private runningDevice: LocalDevice | undefined;
  private startPromise: Promise<EngineStatus> | undefined;
  private crashTimes: number[] = [];

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
    this.host.warn(`TLC local engine: ${message}; restarting.`);
    if (this.crashTimes.length > 3) {
      this.host.onStatus({ status: 'error', message: `the local engine keeps exiting (${message}); restart manually via TLC: Reset Local Engine` });
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
    return { status: 'not-installed' };
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
      if (this.host.settings().engineKind === 'ovgenai') {
        await rm(irModelDir(paths, this.host.settings().modelId), { recursive: true, force: true });
      } else if (this.host.settings().engineKind === 'mlx') {
        await rm(mlxModelDir(paths, this.host.settings().modelId), { recursive: true, force: true });
      } else {
        await rm(modelFilePath(paths, this.host.settings().modelId), { force: true });
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
      const paths = this.host.paths();
      const settings = this.host.settings();
      if (settings.engineKind === 'ovgenai') {
        return await this.startOvgenai(paths, settings);
      }
      if (settings.engineKind === 'mlx') {
        return await this.startMlx(paths, settings);
      }
      if (!isLocalModelId(settings.modelId)) {
        throw new Error(`Unknown local model "${settings.modelId}".`);
      }
      const model = localModel(settings.modelId);
      const devices = deviceChain(settings.device);
      // NPU only exists on the openvino engine build; when the chain starts
      // with NPU the whole chain runs on it (it serves GPU and CPU too).
      const variant: EngineVariant = devices[0] === 'npu' ? 'llama-openvino' : 'llama-std';

      const serverPath = await this.ensureLlamaEngine(paths, settings, variant);
      const modelPath = await this.ensureGgufModel(paths, model, settings);
      this.host.onStatus({ status: 'starting' });

      const startOne = (active: (typeof devices)[number]): Promise<RunningEngine> => {
        const env: Record<string, string> = variant === 'llama-openvino'
          ? {
              GGML_OPENVINO_DEVICE: active.toUpperCase(),
              GGML_OPENVINO_COMPILED_MODEL_CACHE_DIR: paths.modelCacheDir,
              GGML_OPENVINO_PREFILL_CHUNK_SIZE: '256',
              GGML_OPENVINO_NPU_COMPILE_CONFIG: 'optimization-level=3',
              GGML_OPENVINO_MANUAL_GQA_ATTN: '1',
              // No GGML_OPENVINO_CACHE_DIR here: it enables the NPUW
              // weights-separation flow, which fails on ggml graphs with
              // "No WeightlessCacheAttribute" at inference.
            }
          : {};
        const contextLength = variant === 'llama-openvino'
          ? Math.min(model.contextLength, settings.npuContextLength > 0 ? settings.npuContextLength : NPU_CONTEXT_LENGTH)
          : model.contextLength;
        const args = withModelPlaceholder(llamaArgs(contextLength, active), modelPath);
        if (variant === 'llama-openvino') {
          args.push('-b', '256', '-ub', '256');
        }
        return startEngine(
          {
            serverPath,
            modelPath,
            args,
            env,
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
          const next = devices[devices.indexOf(activeDevice) + 1];
          if (next === undefined) {
            throw err;
          }
          const message = err instanceof Error ? err.message : String(err);
          this.host.warn(`TLC local engine: start on ${activeDevice} failed (${message}); retrying on ${next}.`);
          fallbacks.push(`${activeDevice.toUpperCase()}: ${message}`);
          activeDevice = next;
        }
      }
      if (fallbacks.length > 0) {
        const failed = fallbacks.map((f) => f.split(':')[0]).join(', ');
        const reasons = fallbacks.map((f) => f.replace(': ', ' — ')).join('; ');
        this.host.notify(`TLC: started on ${activeDevice.toUpperCase()} — ${failed} unavailable (${reasons})`);
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
      const message = err instanceof Error ? err.message : String(err);
      this.host.onStatus({ status: 'error', message });
      await this.stop();
      throw err;
    }
  }

  private async startOvgenai(paths: EnginePaths, settings: EngineManagerSettings): Promise<EngineStatus> {
    const runnerPath = settings.ovgenaiRunnerPath;
    if (runnerPath === undefined || runnerPath.length === 0) {
      throw new Error(`The OpenVINO GenAI runner is not bundled for ${this.host.platform}/${this.host.arch}.`);
    }
    if (!isLocalModelId(settings.modelId)) {
      throw new Error(`Unknown local model "${settings.modelId}".`);
    }
    const model = irModel(settings.modelId);
    const devices = deviceChain(settings.device);
    const libraryDir = await this.ensureOvGenaiRuntime(paths, settings);
    const modelPath = await this.ensureIrModel(paths, model, settings);
    this.host.onStatus({ status: 'starting' });

    const contextLength = devices[0] === 'npu' || settings.device === 'npu'
      ? Math.min(model.contextLength, settings.npuContextLength > 0 ? settings.npuContextLength : NPU_CONTEXT_LENGTH)
      : model.contextLength;

    let runner: RunningStdioRunner | undefined;
    let activeDevice = devices[0];
    const fallbacks: string[] = [];
    for (;;) {
      try {
        runner = await startStdioRunner(
          {
            runnerPath,
            modelPath,
            device: activeDevice.toUpperCase(),
            contextLength,
            libraryDir,
            onUnexpectedExit: (message) => this.handleUnexpectedExit(`ovgenai ${message}`),
            onStderr: (line) => this.host.log(`ovgenai: ${line}`),
          },
          this.host,
        );
        break;
      } catch (err) {
        const next = devices[devices.indexOf(activeDevice) + 1];
        if (next === undefined) {
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        this.host.warn(`TLC local engine: start on ${activeDevice} failed (${message}); retrying on ${next}.`);
        fallbacks.push(`${activeDevice.toUpperCase()}: ${message}`);
        activeDevice = next;
      }
    }
    if (fallbacks.length > 0) {
      const failed = fallbacks.map((f) => f.split(':')[0]).join(', ');
      const reasons = fallbacks.map((f) => f.replace(': ', ' — ')).join('; ');
      this.host.notify(`TLC: started on ${activeDevice.toUpperCase()} — ${failed} unavailable (${reasons})`);
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
      modelPath,
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
    if (!isLocalModelId(settings.modelId)) {
      throw new Error(`Unknown local model "${settings.modelId}".`);
    }
    const model = mlxModel(settings.modelId);
    const modelPath = await this.ensureMlxModel(paths, model, settings);
    this.host.onStatus({ status: 'starting' });
    // Metal is the only MLX backend; no device fallback chain.
    const runner = await startStdioRunner(
      {
        runnerPath,
        modelPath,
        contextLength: model.contextLength,
        label: 'mlx',
        onUnexpectedExit: (message) => this.handleUnexpectedExit(`mlx ${message}`),
        onStderr: (line) => this.host.log(`mlx: ${line}`),
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

  private async ensureMlxModel(paths: EnginePaths, model: ReturnType<typeof mlxModel>, settings: EngineManagerSettings): Promise<string> {
    if (settings.modelPath.length > 0) {
      if (!existsSync(settings.modelPath)) {
        throw new Error(`Local model file or directory not found: ${settings.modelPath}`);
      }
      return settings.modelPath;
    }
    const modelDir = mlxModelDir(paths, model.id);
    const missing = model.files.filter((file) => !existsSync(join(modelDir, file)));
    if (missing.length === 0) {
      return modelDir;
    }
    this.host.onStatus({ status: 'preparing-model' });
    await mkdir(modelDir, { recursive: true });
    for (const file of missing) {
      const overrideKey = `${model.id}/${file}`;
      const override = settings.modelUrls[overrideKey];
      const url = override !== undefined && override.length > 0
        ? override
        : mlxModelFileUrl(model, file, settings.huggingfaceUrl);
      await (this.host.download ?? downloadFile)({
        url,
        destination: join(modelDir, file),
        signal: this.activeSignal,
        onProgress: (p) => this.host.onProgress?.('model', p),
      });
    }
    return modelDir;
  }

  private async ensureOvGenaiRuntime(paths: EnginePaths, settings: EngineManagerSettings): Promise<string> {
    const asset = resolveOvGenaiAsset(this.host.platform, this.host.arch, OV_GENAI_VERSION, settings.openvinoUrl);
    if (asset === undefined) {
      throw new Error(`No OpenVINO GenAI runtime archive for ${this.host.platform}/${this.host.arch}.`);
    }
    const topDir = asset.fileName.replace(/\.(zip|tar\.gz)$/, '');
    const unpackedRoot = join(paths.engineRoot, `ov-genai-${OV_GENAI_VERSION}`, topDir);
    const libDir = ovGenaiLibDir(this.host.platform, unpackedRoot);
    if (existsSync(libDir)) {
      return libDir;
    }
    this.host.onStatus({ status: 'preparing-engine' });
    await mkdir(paths.engineRoot, { recursive: true });
    const archivePath = join(paths.engineRoot, asset.fileName);
    await (this.host.download ?? downloadFile)({
      url: asset.url,
      destination: archivePath,
      signal: this.activeSignal,
      onProgress: (p) => this.host.onProgress?.('engine', p),
    });
    await (this.host.extract ?? extractArchive)({ archivePath, destDir: join(paths.engineRoot, `ov-genai-${OV_GENAI_VERSION}`), signal: this.activeSignal });
    await rm(archivePath, { force: true });
    if (!existsSync(libDir)) {
      throw new Error(`OpenVINO runtime libraries not found after unpacking (${libDir}).`);
    }
    return libDir;
  }

  private async ensureIrModel(paths: EnginePaths, model: ReturnType<typeof irModel>, settings: EngineManagerSettings): Promise<string> {
    if (settings.modelPath.length > 0) {
      if (!existsSync(settings.modelPath)) {
        throw new Error(`Local model file or directory not found: ${settings.modelPath}`);
      }
      return settings.modelPath;
    }
    const modelDir = irModelDir(paths, model.id);
    const missing = model.files.filter((file) => !existsSync(join(modelDir, file)));
    if (missing.length === 0) {
      return modelDir;
    }
    this.host.onStatus({ status: 'preparing-model' });
    await mkdir(modelDir, { recursive: true });
    for (const file of missing) {
      const overrideKey = `${model.id}/${file}`;
      const override = settings.modelUrls[overrideKey];
      const url = override !== undefined && override.length > 0
        ? override
        : irModelFileUrl(model, file, settings.huggingfaceUrl);
      await (this.host.download ?? downloadFile)({
        url,
        destination: join(modelDir, file),
        signal: this.activeSignal,
        onProgress: (p) => this.host.onProgress?.('model', p),
      });
    }
    return modelDir;
  }

  private async ensureLlamaEngine(paths: EnginePaths, settings: EngineManagerSettings, variant: EngineVariant): Promise<string> {
    if (settings.engineBinary.length > 0) {
      return localEngineBinary(settings.engineBinary);
    }
    const tag = settings.releaseTag;
    const tagDir = join(paths.engineRoot, `${tag}-${variant}`);
    const serverPath = findBinary(tagDir, this.host.platform, 'llama-server');
    if (serverPath !== undefined) {
      return serverPath;
    }
    const asset = resolveEngineAsset(this.host.platform, this.host.arch, tag, settings.githubUrl, variant);
    if (asset === undefined) {
      throw new Error(`No llama.cpp release asset for ${this.host.platform}/${this.host.arch}.`);
    }
    this.host.onStatus({ status: 'preparing-engine' });
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

  private async ensureGgufModel(paths: EnginePaths, model: ReturnType<typeof localModel>, settings: EngineManagerSettings): Promise<string> {
    if (settings.modelPath.length > 0) {
      if (!existsSync(settings.modelPath)) {
        throw new Error(`Local model file not found: ${settings.modelPath}`);
      }
      return settings.modelPath;
    }
    const override = settings.modelUrls[model.id];
    const url = override !== undefined && override.length > 0
      ? override
      : localModelUrl(model.id, settings.huggingfaceUrl);
    const modelPath = join(paths.modelDir, model.fileName);
    if (existsSync(modelPath)) {
      return modelPath;
    }
    this.host.onStatus({ status: 'preparing-model' });
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

function irModelDir(paths: EnginePaths, modelId: string): string {
  return join(paths.modelDir, `${modelId}-int4-ov`);
}

function mlxModelDir(paths: EnginePaths, modelId: string): string {
  return join(paths.modelDir, `${modelId}-mlx`);
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

/** Validates a locally provided engine binary already unpacked by the user. */
function localEngineBinary(engineBinaryFile: string): string {
  if (!existsSync(engineBinaryFile)) {
    throw new Error(`Local engine binary not found: ${engineBinaryFile}`);
  }
  return engineBinaryFile;
}
