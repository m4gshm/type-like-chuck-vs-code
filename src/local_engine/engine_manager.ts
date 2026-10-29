import { existsSync, readdirSync } from 'fs';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { LocalDevice } from '../config';
import { deviceChain, NPU_CONTEXT_LENGTH } from './device';
import { downloadFile, DownloadProgress } from './downloader';
import { extractArchive } from './extract';
import { llamaArgs, startEngine, RunningEngine, RunnerDeps, withModelPlaceholder } from './engine_runner';
import { isLocalModelId, localModel, localModelUrl } from './model_catalog';
import { EnginePaths } from './paths';
import { resolveEngineAsset, EngineVariant } from './release_assets';

export type EngineStatus =
  | { status: 'not-installed' }
  | { status: 'preparing-engine' }
  | { status: 'preparing-model' }
  | { status: 'starting' }
  | { status: 'ready'; baseUrl: string; apiKey: string | undefined; model: string; modelPath: string; device: LocalDevice }
  | { status: 'error'; message: string };

export type ResetTarget = 'engine' | 'model' | 'cache';

export interface EngineManagerSettings {
  modelId: string;
  device: LocalDevice;
  /** Context used on the NPU (0 = the built-in NPU_CONTEXT_LENGTH). */
  npuContextLength: number;
  releaseTag: string;
  /** Local engine binary to use instead of downloading (llama-server). */
  engineBinary: string;
  huggingfaceUrl: string;
  githubUrl: string;
  modelPath: string;
  modelUrls: Record<string, string>;
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
  private engine: RunningEngine | undefined;
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
      await rm(modelFilePath(paths, this.host.settings().modelId), { force: true });
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
