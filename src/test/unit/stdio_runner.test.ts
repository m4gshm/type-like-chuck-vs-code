import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeRunnerVersion, startStdioRunner, StdioRunnerStartOptions } from '../../local_engine/stdio_runner';
import { OV_GENAI_VERSION, ovGenaiLibDir, ovGenaiTbbDir, ovPackageVersion, resolveOvGenaiAsset, runnerOvGenaiVersion } from '../../local_engine/ov_runtime';
import { irModel, irModelFileUrl } from '../../local_engine/ir_model_catalog';
import { localModelSpec } from '../../local_engine/model_picker';

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
  modelPath: '/models/1.5b-nf4-ov',
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
    expect(children[0].args).toEqual(['--model', '/models/1.5b-nf4-ov', '--device', 'NPU']);
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

  it('skips non-JSON stdout noise before the ready event', async () => {    const children: FakeChild[] = [];
    const logs: string[] = [];
    const spawn = (_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      const child = new FakeChild(args, opts.env);
      children.push(child);
      setTimeout(() => {
        child.stdout.write('\x1b[36m[INFO] compilation finished\n');
        child.emitLine({ type: 'ready', model: args[2] ?? '', device: 'NPU', ctx: 0 });
      }, 0);
      return child;
    };
    const runner = await startStdioRunner(baseOptions(), { spawnImpl: spawn as never, log: (m) => logs.push(m) });
    expect(runner.device).toBe('NPU');
    await runner.stop();
  });

  it('waits indefinitely for ready with an infinite timeout', async () => {
    const spawn = (_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      const child = new FakeChild(args, opts.env);
      setTimeout(() => child.emitLine({ type: 'ready', model: args[2] ?? '', device: 'NPU', ctx: 0 }), 200);
      return child;
    };
    const runner = await startStdioRunner(baseOptions({ readyTimeoutMs: Number.POSITIVE_INFINITY }), { spawnImpl: spawn as never });
    expect(runner.device).toBe('NPU');
    await runner.stop();
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
    child.emitLine({ type: 'token', text: 'if' });
    child.emitLine({ type: 'token', text: ' x' });
    child.emitLine({ type: 'done', id: 1, finishReason: 'stop' });
    await expect(generation).resolves.toEqual(['if', ' x']);
    await runner.stop();
  });

  it('queues a second generate while one is running (no busy rejection)', async () => {
    const children: FakeChild[] = [];
    const runner = await startStdioRunner(baseOptions(), { spawnImpl: spawnFake(children) });
    const child = children[0];
    const first = (async () => {
      const tokens: string[] = [];
      for await (const token of runner.stream('a', 32, [])) {
        tokens.push(token);
      }
      return tokens;
    })();
    await vi.waitFor(() => {
      expect(child.written.filter((w) => w.includes('"type":"generate"')).length).toBe(1);
    });
    const second = (async () => {
      const tokens: string[] = [];
      for await (const token of runner.stream('b', 32, [])) {
        tokens.push(token);
      }
      return tokens;
    })();
    await vi.waitFor(() => {
      expect(child.written.filter((w) => w.includes('"type":"generate"')).length).toBe(2);
    });
    // Tokens carry no id: they stream to the oldest pending request.
    child.emitLine({ type: 'token', text: 'a1' });
    child.emitLine({ type: 'done', id: 1, finishReason: 'stop' });
    // After done id=1 the queued request becomes the oldest and receives tokens.
    child.emitLine({ type: 'token', text: 'b1' });
    child.emitLine({ type: 'done', id: 2, finishReason: 'stop' });
    await expect(first).resolves.toEqual(['a1']);
    await expect(second).resolves.toEqual(['b1']);
    await runner.stop();
  });

  it('rejects all pending requests when the runner closes', async () => {
    const children: FakeChild[] = [];
    const runner = await startStdioRunner(baseOptions(), { spawnImpl: spawnFake(children) });
    const child = children[0];
    const first = (async () => {
      for await (const _token of runner.stream('a', 32, [])) {
        // never reached
      }
    })();
    const second = (async () => {
      for await (const _token of runner.stream('b', 32, [])) {
        // never reached
      }
    })();
    await vi.waitFor(() => {
      expect(child.written.filter((w) => w.includes('"type":"generate"')).length).toBe(2);
    });
    child.emit('close', 1);
    await expect(first).rejects.toThrow('runner exited');
    await expect(second).rejects.toThrow('runner exited');
    await runner.stop();
  });

  it('resolves a queued request cancelled before it starts with finishReason=cancel', async () => {
    const children: FakeChild[] = [];
    const runner = await startStdioRunner(baseOptions(), { spawnImpl: spawnFake(children) });
    const child = children[0];
    void (async () => {
      for await (const _token of runner.stream('a', 500, [])) {
        // consume until done
      }
    })().catch(() => undefined);
    await vi.waitFor(() => {
      expect(child.written.some((w) => w.includes('"type":"generate"'))).toBe(true);
    });
    const controller = new AbortController();
    const second = (async () => {
      for await (const _token of runner.stream('b', 32, [], controller.signal)) {
        // never reached: aborted while still queued
      }
    })();
    await vi.waitFor(() => {
      expect(child.written.filter((w) => w.includes('"type":"generate"')).length).toBe(2);
    });
    controller.abort();
    child.emitLine({ type: 'done', id: 2, finishReason: 'cancel' });
    await expect(second).resolves.toBeUndefined();
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
    child.emitLine({ type: 'token', text: 'x' });
    await vi.waitFor(() => {
      expect(child.written.some((w) => w.includes('"type":"cancel"'))).toBe(true);
    });
    child.emitLine({ type: 'done', id: 1, finishReason: 'cancel' });
    await expect(generation).resolves.toBeUndefined();
    await runner.stop();
  });

  it('prepends the library dir to LD_LIBRARY_PATH on linux', async () => {
    const children: FakeChild[] = [];
    const runner = await startStdioRunner(baseOptions({ libraryDirs: ['/engine/ov-genai/runtime/lib/intel64'] }), {
      spawnImpl: spawnFake(children),
      platform: 'linux',
    });
    expect(children[0].env.LD_LIBRARY_PATH).toContain('/engine/ov-genai/runtime/lib/intel64');
    await runner.stop();
  });

  it('prepends the library dirs to PATH on windows', async () => {
    const children: FakeChild[] = [];
    const runner = await startStdioRunner(baseOptions({
      libraryDirs: ['C:\\engine\\ov\\runtime\\bin\\intel64\\Release', 'C:\\engine\\ov\\runtime\\3rdparty\\tbb\\bin'],
    }), {
      spawnImpl: spawnFake(children),
      platform: 'win32',
    });
    expect(children[0].env.PATH).toContain('C:\\engine\\ov\\runtime\\bin\\intel64\\Release;C:\\engine\\ov\\runtime\\3rdparty\\tbb\\bin');
    await runner.stop();
  });
});

describe('resolveOvGenaiAsset', () => {
  it('resolves the windows x64 archive', () => {
    const asset = resolveOvGenaiAsset('win32', 'x64');
    expect(asset?.fileName).toBe(`openvino_genai_windows_${OV_GENAI_VERSION}_x86_64.zip`);
    expect(asset?.url).toBe(`https://storage.openvinotoolkit.org/repositories/openvino_genai/packages/2026.4.1/windows/${asset?.fileName}`);
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
    // Patch-level 0 releases live under X.Y, patched ones under X.Y.Z.
    expect(ovPackageVersion('2026.4.0.0')).toBe('2026.4');
    expect(ovPackageVersion('2026.4.1.0')).toBe('2026.4.1');
  });

  it('points at the bundled lib dir inside the unpacked archive', () => {
    expect(ovGenaiLibDir('linux', '/engine/ov')).toBe('/engine/ov/runtime/lib/intel64');
    expect(ovGenaiLibDir('win32', '/engine/ov')).toBe('/engine/ov/runtime/bin/intel64/Release');
  });

  it('derives the windows TBB dll dir from the runtime root', () => {
    expect(ovGenaiTbbDir('win32', 'C:\\ov')).toContain('runtime/3rdparty/tbb/bin');
    expect(ovGenaiTbbDir('linux', '/ov')).toBeUndefined();
  });
});

describe('runnerOvGenaiVersion', () => {
  const writeRunner = async (content: Buffer | string): Promise<string> => {
    const file = join(await mkdtemp(join(tmpdir(), 'tlc-ovver-')), 'tlc-ovgenai-runner');
    await writeFile(file, content);
    return file;
  };

  it('reads the embedded runtime version marker from the binary', async () => {
    const file = await writeRunner(Buffer.concat([Buffer.alloc(100, 0x42), Buffer.from('ovgenai-runtime-version: 2026.4.1.0\0more-bytes')]));
    expect(runnerOvGenaiVersion(file)).toBe('2026.4.1.0');
  });

  it('returns undefined for a runner without a marker', async () => {
    expect(runnerOvGenaiVersion(await writeRunner('no marker here'))).toBeUndefined();
    expect(runnerOvGenaiVersion(await writeRunner('ovgenai-runtime-version: unknown\0'))).toBeUndefined();
    expect(runnerOvGenaiVersion(join('nowhere', 'runner'))).toBeUndefined();
  });
});

describe('probeRunnerVersion', () => {
  const probeFake = (emit: (child: FakeChild) => void) => ((_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    const child = new FakeChild(args, opts.env);
    setTimeout(() => emit(child), 0);
    return child;
  }) as never;

  it('parses the version event and puts the library dirs on PATH', async () => {
    const children: FakeChild[] = [];
    const versions = await probeRunnerVersion('/ext/runner', ['/libs', '/tbb'], {
      spawnImpl: probeFake((child) => {
        children.push(child);
        child.stdout.write(`${JSON.stringify({ type: 'version', app: 'v1.2.3-dirty', ovGenai: '2026.4.1.0' })}\n`);
        child.emit('close', 0);
      }),
      platform: 'win32',
    });
    expect(versions).toEqual({ app: 'v1.2.3-dirty', ovGenai: '2026.4.1.0' });
    expect(children[0].args).toEqual(['--version']);
    expect(children[0].env.PATH).toContain('/libs;/tbb');
  });

  it('returns undefined when the runner predates --version', async () => {
    const versions = await probeRunnerVersion('/ext/runner', [], {
      spawnImpl: probeFake((child) => {
        child.stdout.write(`${JSON.stringify({ type: 'error', id: null, message: 'no --model given' })}\n`);
        child.emit('close', 2);
      }),
      platform: 'linux',
    });
    expect(versions).toBeUndefined();
  });

  it('returns undefined when the runner cannot start', async () => {
    const spawnErr = ((_cmd: string, _args: string[], _opts: unknown) => {
      const child = new FakeChild([], {});
      setTimeout(() => child.emit('error', new Error('spawn ENOENT')), 0);
      return child;
    }) as never;
    await expect(probeRunnerVersion('/ext/runner', [], { spawnImpl: spawnErr })).resolves.toBeUndefined();
  });
});

describe('ir model catalog', () => {
  it('exposes the OpenVINO nf4 repos with the full file set', () => {
    const spec = irModel('1.5b');
    expect(spec.repo).toBe('m4gshm/Qwen2.5-Coder-1.5B-nf4-sym-g-1-se-awq');
    expect(spec.files).toContain('openvino_model.xml');
    expect(spec.files).toContain('openvino_model.bin');
    expect(spec.files).toContain('openvino_tokenizer.xml');
    expect(spec.files).toContain('openvino_detokenizer.bin');
    // dirName is unique per model+format so families never collide; template
    // drives the FIM template suggestion.
    expect(spec.dirName).toBe('1.5b-nf4-ov');
    expect(spec.template).toBe('qwen2');
  });

  it('builds resolve urls from the hf base', () => {
    expect(irModelFileUrl(irModel('0.5b'), 'openvino_model.bin')).toBe('https://huggingface.co/m4gshm/Qwen2.5-Coder-0.5B-nf4-sym-g-1-se-awq/resolve/main/openvino_model.bin');
  });
});

describe('localModelSpec', () => {
  it('returns the catalog spec per engine kind', () => {
    expect(localModelSpec('ovgenai', '1.5b')?.label).toContain('1.5B');
    expect(localModelSpec('ovgenai', '1.5b')?.template).toBe('qwen2');
    expect(localModelSpec('llama.cpp', '1.5b')?.label).toContain('1.5B');
    expect(localModelSpec('mlx', '1.5b')?.template).toBe('qwen2');
    expect(localModelSpec('ovgenai', 'made-up')).toBeUndefined();
  });
});
