import { describe, expect, it } from 'vitest';
import { LocalModeStatusUi } from '../../local_mode_status';

const makeHost = () => {
  let runner: { stream(): AsyncIterable<string> } | undefined;
  const recorded = {
    engine: [] as Array<string | undefined>,
    details: [] as Array<string | undefined>,
    reasons: [] as Array<string | undefined>,
    blocked: [] as boolean[],
    endpoint: [] as Array<string | undefined>,
    stages: [] as string[],
    stdioSet: [] as Array<unknown>,
    apiKeys: [] as Array<string | undefined>,
    logs: [] as string[],
    successes: 0,
  };
  const host = {
    statusBar: {
      setEngine: (t: string | undefined) => recorded.engine.push(t),
      setEngineDetail: (d: string | undefined) => recorded.details.push(d),
      setConnectionReason: (r: string | undefined) => recorded.reasons.push(r),
      setBusy: () => undefined,
      refresh: () => undefined,
    },
    state: { setConnectionBlocked: (v: boolean) => recorded.blocked.push(v) },
    client: {
      setStdioSource: (s: unknown) => recorded.stdioSet.push(s),
      setModelLabel: () => undefined,
      refresh: () => undefined,
      setApiKey: async (k: string | undefined) => recorded.apiKeys.push(k),
    },
    watchdog: { reportSuccess: () => { recorded.successes += 1; } },
    stdioRunner: () => runner,
    engineKind: (): 'llama.cpp' => 'llama.cpp',
    modelLabel: () => 'Qwen2.5-Coder 1.5B',
    setEndpoint: (url: string | undefined) => recorded.endpoint.push(url),
    stage: (label: string) => recorded.stages.push(label),
    log: { info: (m: string) => recorded.logs.push(m), warn: () => undefined },
  };
  const ui = new LocalModeStatusUi(host as never);
  return { ui, recorded, setRunner: (r: typeof runner) => { runner = r; } };
};

describe('LocalModeStatusUi', () => {
  it('wires the stdio pipe and unblocks completions when a runner-based engine is ready', () => {
    const { ui, recorded, setRunner } = makeHost();
    setRunner({ stream: async function* () { yield 'x'; } });
    ui.handle({ status: 'ready', model: 'm', modelPath: '/p', device: 'gpu', baseUrl: '', apiKey: undefined });
    expect(recorded.stdioSet).toHaveLength(1);
    expect(recorded.blocked).toEqual([false]);
    expect(recorded.endpoint).toEqual([]);
    expect(recorded.successes).toBe(1);
    expect(recorded.details.at(-1)).toBe('m (gpu)');
  });

  it('switches the endpoint when a server-based engine is ready', () => {
    const { ui, recorded } = makeHost();
    ui.handle({ status: 'ready', model: 'm', modelPath: '/p', device: 'cpu', baseUrl: 'http://127.0.0.1:9/v1', apiKey: undefined });
    expect(recorded.endpoint).toEqual(['http://127.0.0.1:9/v1']);
    expect(recorded.stdioSet).toEqual([]);
    expect(recorded.apiKeys).toEqual([undefined]);
  });

  it('omits the device from the detail and ready log when the engine reports none (mlx)', () => {
    const { ui, recorded, setRunner } = makeHost();
    setRunner({ stream: async function* () { yield 'x'; } });
    ui.handle({ status: 'ready', model: 'm', modelPath: '/p', baseUrl: '', apiKey: undefined });
    expect(recorded.details.at(-1)).toBe('m');
    expect(recorded.logs.at(-1)).toBe('Type like Chuck local engine ready: llama.cpp runner model=/p');
  });

  it('blocks completions and points at a dead endpoint on error', () => {
    const { ui, recorded } = makeHost();
    ui.handle({ status: 'error', message: 'boom' });
    expect(recorded.blocked).toEqual([true]);
    expect(recorded.endpoint).toEqual(['']);
    expect(recorded.engine.at(-1)).toBe('$(error) engine: boom');
    expect(recorded.reasons.at(-1)).toBe('boom');
  });

  it('publishes the download stage and blocks completions while starting', () => {
    const { ui, recorded } = makeHost();
    ui.handle({ status: 'preparing-model' });
    expect(recorded.stages).toEqual(['downloading Qwen2.5-Coder 1.5B…']);
    expect(recorded.blocked).toEqual([true]);
    expect(recorded.engine.at(-1)?.startsWith('$(loading~spin)')).toBe(true);
  });
});

