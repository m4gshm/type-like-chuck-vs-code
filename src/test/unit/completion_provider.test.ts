import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionProvider, ProviderDeps } from '../../completion_provider';
import { buildTemplateRegistry } from '../../templates';
import { ForbiddenFiles } from '../../forbidden_files';
import { CompletionState } from '../../completion_state';
import { StatusBar } from '../../status_bar';
import { ExtensionConfig } from '../../config';

// ---- vscode-stub doubles ----------------------------------------------------

class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

class FakeToken {
  isCancellationRequested = false;
  private listeners: Array<() => void> = [];
  onCancellationRequested(cb: () => void) {
    this.listeners.push(cb);
    return { dispose: () => undefined };
  }
  cancel() {
    this.isCancellationRequested = true;
    this.listeners.forEach((l) => l());
  }
}

function fakeDocument(lines: string[], fileName = 'main.ts', version = 1) {
  const text = lines.join('\n');
  return {
    fileName,
    version,
    getText: () => text,
    lineAt: (line: number) => ({ text: lines[line] }),
    offsetAt: (p: { line: number; character: number }) =>
      lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character,
  };
}

// ---- harness ----------------------------------------------------------------

function makeDeps(completeImpl: (p: { prefix: string }) => Promise<{ text: string }>, overrides: Partial<ExtensionConfig> = {}): { deps: ProviderDeps; calls: () => number } {
  let callCount = 0;
  const defaults = {
    baseUrl: 'http://stub/v1',
    model: 'stub-model',
    promptTemplate: 'qwen2.5',
    customTemplate: undefined,
    prefixMaxLength: 8000,
    suffixMaxLength: 2000,
    maxTokens: 256,
    debounceMs: 250,
    autoTrigger: true,
    cacheEnabled: true,
    cacheTtlMs: 10_000,
    forbiddenFileNames: ['.env'],
  };
  const config: ExtensionConfig = { ...defaults, ...overrides } as ExtensionConfig;
  let enabled = true;
  const deps: ProviderDeps = {
    client: {
      complete: (p: { prefix: string }) => {
        callCount += 1;
        return completeImpl(p);
      },
    } as never,
    getConfig: () => config,
    resolveTemplates: () => buildTemplateRegistry('qwen2.5', undefined),
    forbidden: () => new ForbiddenFiles(config.forbiddenFileNames),
    state: {
      isEnabled: () => enabled,
      setEnabled: async (v: boolean) => {
        enabled = v;
      },
    } as unknown as CompletionState,
    status: { setBusy: () => undefined, setError: () => undefined, clearError: () => undefined } as unknown as StatusBar,
    log: () => undefined,
    trace: () => undefined,
  };
  return { deps, calls: () => callCount };
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CompletionProvider', () => {
  it('debounces automatic requests until typing pauses for debounceMs', async () => {
    const { deps, calls } = makeDeps(async () => ({ text: 'suggestion' }));
    const provider = new CompletionProvider(deps);
    const doc = fakeDocument(['const x = ']);
    const pos = new Position(0, 9);
    const token = new FakeToken();

    const first = provider.provideInlineCompletionItems(doc as never, pos as never, {} as never, token as never);
    await vi.advanceTimersByTimeAsync(249);
    expect(calls()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toHaveLength(1);
    expect(calls()).toBe(1);

    // A second invocation restarts the debounce window: nothing is sent until
    // debounceMs passes again (different text so the cache does not apply).
    const doc2 = fakeDocument(['let y = ']);
    const second = provider.provideInlineCompletionItems(doc2 as never, new Position(0, 8) as never, {} as never, token as never);
    await vi.advanceTimersByTimeAsync(249);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toHaveLength(1);
    expect(calls()).toBe(2);
  });

  it('re-serves the cached completion at the exact cursor position without new API calls', async () => {
    const { deps, calls } = makeDeps(async () => ({ text: 'function foo' }));
    const provider = new CompletionProvider(deps);
    const token = new FakeToken();
    const doc = fakeDocument(['']);
    const first = provider.provideInlineCompletionItems(doc as never, new Position(0, 0) as never, {} as never, token as never);
    await vi.advanceTimersByTimeAsync(250);
    expect((await first)[0].insertText).toBe('function foo');
    expect(calls()).toBe(1);

    // Same document state and same cursor position → served from the cache.
    const second = await provider.provideInlineCompletionItems(doc as never, new Position(0, 0) as never, {} as never, token as never);
    expect(second[0].insertText).toBe('function foo');
    expect(calls()).toBe(1);

    // A document edit (deleted char / deleted line → new version) invalidates.
    const edited = fakeDocument(['function foo'], 'main.ts', 2);
    const third = provider.provideInlineCompletionItems(edited as never, new Position(0, 12) as never, {} as never, token as never);
    await vi.advanceTimersByTimeAsync(250);
    expect((await third)[0].insertText).toBe('function foo');
    expect(calls()).toBe(2);
  });

  it('drops the cached completion after the TTL expires', async () => {
    const { deps, calls } = makeDeps(async () => ({ text: 'cached' }));
    const provider = new CompletionProvider(deps);
    const doc = fakeDocument(['']);
    const token = new FakeToken();

    const first = provider.provideInlineCompletionItems(doc as never, new Position(0, 0) as never, {} as never, token as never);
    await vi.advanceTimersByTimeAsync(250);
    expect(await first).toHaveLength(1);
    expect(calls()).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    const second = provider.provideInlineCompletionItems(doc as never, new Position(0, 0) as never, {} as never, token as never);
    await vi.advanceTimersByTimeAsync(250);
    expect(await second).toHaveLength(1);
    expect(calls()).toBe(2);
  });

  it('returns nothing in a forbidden file (.env)', async () => {
    const { deps, calls } = makeDeps(async () => ({ text: 'text' }));
    const provider = new CompletionProvider(deps);
    const token = new FakeToken();

    const forbiddenDoc = fakeDocument(['hi'], '.env');
    const forbiddenResult = await provider.provideInlineCompletionItems(forbiddenDoc as never, new Position(0, 2) as never, {} as never, token as never);
    expect(forbiddenResult).toHaveLength(0);
    expect(calls()).toBe(0);
  });

  it('auto-trigger can be disabled: completions only on manual trigger', async () => {
    const { deps, calls } = makeDeps(async () => ({ text: 'manual only' }), { autoTrigger: false });
    const provider = new CompletionProvider(deps);
    const doc = fakeDocument(['x = ']);
    const token = new FakeToken();

    // Automatic invocation (typing) does not request anything.
    const auto = await provider.provideInlineCompletionItems(doc as never, new Position(0, 4) as never, {} as never, token as never);
    expect(auto).toHaveLength(0);
    expect(calls()).toBe(0);

    // Manual trigger still works (and skips the debounce window).
    provider.resetThrottle();
    const manual = provider.provideInlineCompletionItems(doc as never, new Position(0, 4) as never, {} as never, token as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(await manual).toHaveLength(1);
    expect(calls()).toBe(1);
  });

  it('manual trigger bypasses the throttle (resetThrottle)', async () => {
    const { deps, calls } = makeDeps(async () => ({ text: 'after reset' }));
    const provider = new CompletionProvider(deps);
    const doc = fakeDocument(['a = ']);
    const token = new FakeToken();

    const first = provider.provideInlineCompletionItems(doc as never, new Position(0, 4) as never, {} as never, token as never);
    await vi.advanceTimersByTimeAsync(250);
    expect(await first).toHaveLength(1);
    expect(calls()).toBe(1);

    // Dropping the cache (as a cursor move would) and resetting the throttle
    // lets the next invocation fire immediately.
    provider.cancelActiveRequests();
    provider.resetThrottle();
    const second = await provider.provideInlineCompletionItems(doc as never, new Position(0, 4) as never, {} as never, token as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toHaveLength(1);
    expect(calls()).toBe(2);
  });
});


