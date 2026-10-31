import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startStdioRunner, StdioRunnerStartOptions } from '../../local_engine/stdio_runner';
import { OV_GENAI_VERSION, ovGenaiLibDir, ovPackageVersion, resolveOvGenaiAsset } from '../../local_engine/ov_runtime';
import { irModel, irModelFileUrl } from '../../local_engine/ir_model_catalog';

class FakeChild extends EventEmitter {
  stdin = {
    write: vi.fn((chunk: string) => {
      this.written.push(chunk);
      return true;
    }),
    end: vi.fn(),
  };
  stdout = new PassThrough();
  stderr = new PassThrough();
  written: string[] = [];
  killed = false;

  constructor(public args: string[], public env: NodeJS.ProcessEnv) {
    super();
  }

  kill(): void {
    this.killed = true;
    this.emit('close', 0);
  }

  emitLine(event: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }
}

const baseOptions = (overrides: Partial<StdioRunnerStartOptions> = {}): StdioRunnerStartOptions => ({
  runnerPath: '/ext/binaries/ovgenai/linux-x64/tlc-ovgenai-runner',
  modelPath: '/models/1.5b-int8-ov',
  device: 'NPU',
  ...overrides,
});

const spawnFake = (children: FakeChild[]) => ((_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
  const child = new FakeChild(args, opts.env);
  children.push(child);
  setTimeout(() => child.emitLine({ type: 'ready', model: args[2] ?? '', device: 'NPU', ctx: 0 }), 0);
  return child;
}) as never;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startStdioRunner', () => {
  it('resolves on the ready event and exposes the reported device', async () => {
    const children: FakeChild[] = [];
    const runner = await startStdioRunner(baseOptions(), { spawnImpl: spawnFake(children) });
    expect(children[0].args).toEqual(['--model', '/models/1.5b-int8-ov', '--device', 'NPU']);
    expect(runner.device).toBe('NPU');
    await runner.stop();
  });

  it('rejects when the runner reports a startup error', async () => {
    const children: FakeChild[] = [];
    const spawn = (_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      const child = new FakeChild(args, opts.env);
      children.push(child);
      setTimeout(() => child.emitLine({ type: 'error', id: null, message: 'load failed: bad model' }), 0);
      return child;
    };
    await expect(startStdioRunner(baseOptions(), { spawnImpl: spawn as never })).rejects.toThrow('load failed: bad model');
  });

  it('rejects when the process dies before becoming ready', async () => {
    const children: FakeChild[] = [];
    const spawn = (_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      const child = new FakeChild(args, opts.env);
      children.push(child);
      setTimeout(() => child.emit('close', 1), 0);
      return child;
    };
    await expect(startStdioRunner(baseOptions(), { spawnImpl: spawn as never })).rejects.toThrow('exited');
  });

  it('streams tokens until done', async () => {
    const children: FakeChild[] = [];
    const runner = await startStdioRunner(baseOptions(), { spawnImpl: spawnFake(children) });
    const child = children[0];
    const generation = (async () => {
      const tokens: string[] = [];
      for await (const token of runner.stream('prompt', 32, ['\n'])) {
        tokens.push(token);
      }
      return tokens;
    })();
    await vi.waitFor(() => {
      expect(child.written.some((w) => w.includes('"type":"generate"'))).toBe(true);
    });
    child.emitLine({ type: 'token', id: 1, text: 'if' });
    child.emitLine({ type: 'token', id: 1, text: ' x' });
    child.emitLine({ type: 'done', id: 1, finishReason: 'stop' });
    await expect(generation).resolves.toEqual(['if', ' x']);
    await runner.stop();
  });

  it('rejects a second generate while one is running', async () => {
    const children: FakeChild[] = [];
    const runner = await startStdioRunner(baseOptions(), { spawnImpl: spawnFake(children) });
    const child = children[0];
    void (async () => {
      for await (const _token of runner.stream('a', 32, [])) {
        // consume until done
      }
    })().catch(() => undefined);
    await vi.waitFor(() => {
      expect(child.written.some((w) => w.includes('"type":"generate"'))).toBe(true);
    });
    await expect(async () => {
      for await (const _token of runner.stream('b', 32, [])) {
        // never reached
      }
    }).rejects.toThrow('busy');
    child.emitLine({ type: 'done', id: 1, finishReason: 'stop' });
    await runner.stop();
  });

  it('sends cancel on abort and waits for the done event', async () => {
    const children: FakeChild[] = [];
    const runner = await startStdioRunner(baseOptions(), { spawnImpl: spawnFake(children) });
    const child = children[0];
    const controller = new AbortController();
    const generation = (async () => {
      for await (const _token of runner.stream('a', 500, [], controller.signal)) {
        controller.abort();
      }
    })();
    await vi.waitFor(() => {
      expect(child.written.some((w) => w.includes('"type":"generate"'))).toBe(true);
    });
    child.emitLine({ type: 'token', id: 1, text: 'x' });
    await vi.waitFor(() => {
      expect(child.written.some((w) => w.includes('"type":"cancel"'))).toBe(true);
    });
    child.emitLine({ type: 'done', id: 1, finishReason: 'cancel' });
    await expect(generation).resolves.toBeUndefined();
    await runner.stop();
  });

  it('prepends the library dir to LD_LIBRARY_PATH on linux', async () => {
    const children: FakeChild[] = [];
    const runner = await startStdioRunner(baseOptions({ libraryDir: '/engine/ov-genai/runtime/lib/intel64' }), {
      spawnImpl: spawnFake(children),
      platform: 'linux',
    });
    expect(children[0].env.LD_LIBRARY_PATH).toContain('/engine/ov-genai/runtime/lib/intel64');
    await runner.stop();
  });

  it('prepends the library dir to PATH on windows', async () => {
    const children: FakeChild[] = [];
    const runner = await startStdioRunner(baseOptions({ libraryDir: 'C:\\engine\\ov-genai\\runtime\\bin\\intel64' }), {
      spawnImpl: spawnFake(children),
      platform: 'win32',
    });
    expect(children[0].env.PATH).toContain('C:\\engine\\ov-genai\\runtime\\bin\\intel64');
    await runner.stop();
  });
});

describe('resolveOvGenaiAsset', () => {
  it('resolves the windows x64 archive', () => {
    const asset = resolveOvGenaiAsset('win32', 'x64');
    expect(asset?.fileName).toBe(`openvino_genai_windows_${OV_GENAI_VERSION}_x86_64.zip`);
    expect(asset?.url).toBe(`https://storage.openvinotoolkit.org/repositories/openvino_genai/packages/2026.4/windows/${asset?.fileName}`);
  });

  it('resolves the ubuntu22 archive for linux x64', () => {
    const asset = resolveOvGenaiAsset('linux', 'x64');
    expect(asset?.fileName).toBe(`openvino_genai_ubuntu22_${OV_GENAI_VERSION}_x86_64.tar.gz`);
  });

  it('returns undefined for unsupported platforms', () => {
    expect(resolveOvGenaiAsset('darwin', 'arm64')).toBeUndefined();
    expect(resolveOvGenaiAsset('win32', 'arm64')).toBeUndefined();
  });

  it('honors a custom base url and rc package dirs', () => {
    const asset = resolveOvGenaiAsset('linux', 'x64', '2026.4.1.0rc2', 'https://mirror.example.org/');
    expect(asset?.url).toBe('https://mirror.example.org/repositories/openvino_genai/packages/pre-release/2026.4.1.0rc2/linux/openvino_genai_ubuntu22_2026.4.1.0rc2_x86_64.tar.gz');
    expect(ovPackageVersion('2026.4.0.0')).toBe('2026.4');
  });

  it('points at the bundled lib dir inside the unpacked archive', () => {
    expect(ovGenaiLibDir('linux', '/engine/ov')).toBe('/engine/ov/runtime/lib/intel64');
    expect(ovGenaiLibDir('win32', '/engine/ov')).toBe('/engine/ov/runtime/bin/intel64/Release');
  });
});

describe('ir model catalog', () => {
  it('exposes the OpenVINO int8-ov repos with the full file set', () => {
    const spec = irModel('1.5b');
    expect(spec.repo).toBe('OpenVINO/Qwen2.5-Coder-1.5B-Instruct-int8-ov');
    expect(spec.files).toContain('openvino_model.xml');
    expect(spec.files).toContain('openvino_model.bin');
    expect(spec.files).toContain('openvino_tokenizer.xml');
    expect(spec.files).toContain('openvino_detokenizer.bin');
  });

  it('builds resolve urls from the hf base', () => {
    expect(irModelFileUrl(irModel('0.5b'), 'openvino_model.bin')).toBe('https://huggingface.co/OpenVINO/Qwen2.5-Coder-0.5B-Instruct-int8-ov/resolve/main/openvino_model.bin');
  });
});
