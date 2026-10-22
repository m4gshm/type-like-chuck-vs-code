import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionProvider, ProviderDeps } from '../../completion_provider';
import { CompletionError } from '../../completions_client';
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
    pendingGraceMs: 150,
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

    // After an edit (new version → cache miss) resetting the throttle lets the
    // manual invocation fire immediately, without the debounce pause.
    provider.cancelActiveRequests();
    provider.resetThrottle();
    const edited = fakeDocument(['a = b'], 'main.ts', 2);
    const second = await provider.provideInlineCompletionItems(edited as never, new Position(0, 5) as never, {} as never, token as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toHaveLength(1);
    expect(calls()).toBe(2);
  });

  it('keeps the cache across cancelActiveRequests (a click must not invalidate it)', async () => {
    const { deps, calls } = makeDeps(async () => ({ text: 'cached' }));
    const provider = new CompletionProvider(deps);
    const doc = fakeDocument(['']);
    const token = new FakeToken();

    const first = provider.provideInlineCompletionItems(doc as never, new Position(0, 0) as never, {} as never, token as never);
    await vi.advanceTimersByTimeAsync(250);
    expect(await first).toHaveLength(1);
    expect(calls()).toBe(1);

    provider.cancelActiveRequests();
    const second = await provider.provideInlineCompletionItems(doc as never, new Position(0, 0) as never, {} as never, token as never);
    expect(second[0].insertText).toBe('cached');
    expect(calls()).toBe(1);
  });

  it('surfaces request errors via status/log and returns nothing', async () => {
    const errors: string[] = [];
    const busyLog: boolean[] = [];
    const { deps } = makeDeps(async () => {
      throw new CompletionError('other', 'server exploded');
    });
    deps.status = {
      setBusy: (b: boolean) => busyLog.push(b),
      setError: () => errors.push('error'),
      clearError: () => undefined,
    } as unknown as StatusBar;
    const provider = new CompletionProvider(deps);
    const doc = fakeDocument(['']);
    const token = new FakeToken();

    const result = provider.provideInlineCompletionItems(doc as never, new Position(0, 0) as never, {} as never, token as never);
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toHaveLength(0);
    expect(errors).toContain('error');
    // Busy was switched on for the request and off again afterwards.
    expect(busyLog).toEqual([true, false]);
  });
});

describe('CompletionProvider pending reuse', () => {
  function deferred() {
    let resolve!: (value: { text: string }) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<{ text: string }>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it('reuses a cancelled in-flight request once, then re-requests on continued typing', async () => {
    const first = deferred();
    let impl = first;
    const harness = makeDeps(async () => impl.promise);
    const provider = new CompletionProvider(harness.deps);
    const token = new FakeToken();

    // Request #1 is sent after the debounce pause…
    const invocation1 = provider.provideInlineCompletionItems(
      fakeDocument(['abc']) as never,
      new Position(0, 3) as never,
      {} as never,
      token as never,
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(harness.calls()).toBe(1);

    // …then cancelled by typing: the request goes pending.
    token.cancel();
    const token2 = new FakeToken();
    const invocation2 = provider.provideInlineCompletionItems(
      fakeDocument(['abcd'], 'main.ts', 2) as never,
      new Position(0, 4) as never,
      {} as never,
      token2 as never,
    );
    // The pending result arrives within the grace window → served, no new call.
    first.resolve({ text: 'stale but fresh enough' });
    await vi.advanceTimersByTimeAsync(0);
    expect((await invocation2)[0].insertText).toBe('stale but fresh enough');
    expect(harness.calls()).toBe(1);

    // One more keystroke: the pending request is consumed, the cache misses
    // (different position/version) → after the debounce a fresh request fires.
    const second = deferred();
    impl = second;
    const token3 = new FakeToken();
    const invocation3 = provider.provideInlineCompletionItems(
      fakeDocument(['abcde'], 'main.ts', 3) as never,
      new Position(0, 5) as never,
      {} as never,
      token3 as never,
    );
    await vi.advanceTimersByTimeAsync(249);
    expect(harness.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    second.resolve({ text: 'fresh' });
    expect((await invocation3)[0].insertText).toBe('fresh');
    expect(harness.calls()).toBe(2);
    void invocation1;
  });

  it('waits the full pending result when the cursor did not move past it', async () => {
    const first = deferred();
    const harness = makeDeps(async () => first.promise);
    const provider = new CompletionProvider(harness.deps);
    const token = new FakeToken();

    const invocation1 = provider.provideInlineCompletionItems(
      fakeDocument(['abc']) as never,
      new Position(0, 3) as never,
      {} as never,
      token as never,
    );
    await vi.advanceTimersByTimeAsync(250);
    token.cancel();

    // Same position (edit happened elsewhere → cache miss), no typing past the
    // request start: no grace limit, the result is awaited however long it takes.
    const token2 = new FakeToken();
    const invocation2 = provider.provideInlineCompletionItems(
      fakeDocument(['abc'], 'main.ts', 2) as never,
      new Position(0, 3) as never,
      {} as never,
      token2 as never,
    );
    await vi.advanceTimersByTimeAsync(5000); // way past the 150 ms grace and the 1 s TTL
    expect(harness.calls()).toBe(1);
    first.resolve({ text: 'patient result' });
    expect((await invocation2)[0].insertText).toBe('patient result');
    expect(harness.calls()).toBe(1);
    void invocation1;
  });

  it('discards a typed-past pending request after the grace period and re-requests', async () => {
    const first = deferred();
    let impl = first;
    const harness = makeDeps(async () => impl.promise);
    const provider = new CompletionProvider(harness.deps);
    const token = new FakeToken();

    const invocation1 = provider.provideInlineCompletionItems(
      fakeDocument(['abc']) as never,
      new Position(0, 3) as never,
      {} as never,
      token as never,
    );
    await vi.advanceTimersByTimeAsync(250);
    token.cancel();

    // Typed past the start position: the stale request gets pendingGraceMs…
    const token2 = new FakeToken();
    const invocation2 = provider.provideInlineCompletionItems(
      fakeDocument(['abcd'], 'main.ts', 2) as never,
      new Position(0, 4) as never,
      {} as never,
      token2 as never,
    );
    await vi.advanceTimersByTimeAsync(149);
    expect(harness.calls()).toBe(1);

    // …then drops it (abort) and fires a fresh request after the debounce.
    await vi.advanceTimersByTimeAsync(1);
    const second = deferred();
    impl = second;
    await vi.advanceTimersByTimeAsync(249);
    expect(harness.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    second.resolve({ text: 'fresh' });
    expect((await invocation2)[0].insertText).toBe('fresh');
    expect(harness.calls()).toBe(2);
    void invocation1;
  });

  it('pendingGraceMs = 0 never waits for a typed-past request', async () => {
    const first = deferred();
    let impl = first;
    const harness = makeDeps(async () => impl.promise, { pendingGraceMs: 0 });
    const provider = new CompletionProvider(harness.deps);
    const token = new FakeToken();

    const invocation1 = provider.provideInlineCompletionItems(
      fakeDocument(['abc']) as never,
      new Position(0, 3) as never,
      {} as never,
      token as never,
    );
    await vi.advanceTimersByTimeAsync(250);
    token.cancel();

    const token2 = new FakeToken();
    const invocation2 = provider.provideInlineCompletionItems(
      fakeDocument(['abcd'], 'main.ts', 2) as never,
      new Position(0, 4) as never,
      {} as never,
      token2 as never,
    );
    await vi.advanceTimersByTimeAsync(0);
    // The stale request was dropped immediately; after the debounce a fresh one fires.
    const second = deferred();
    impl = second;
    await vi.advanceTimersByTimeAsync(250);
    second.resolve({ text: 'fresh' });
    expect((await invocation2)[0].insertText).toBe('fresh');
    expect(harness.calls()).toBe(2);
    void invocation1;
  });

  it('an unconsumed pending request is aborted after its TTL', async () => {
    const first = deferred();
    let aborted = false;
    const { deps } = makeDeps(((p: { signal: AbortSignal }) => {
      p.signal.addEventListener('abort', () => {
        aborted = true;
        first.reject(new Error('aborted'));
      });
      return first.promise;
    }) as never);
    const provider = new CompletionProvider(deps);
    const token = new FakeToken();

    const invocation1 = provider.provideInlineCompletionItems(
      fakeDocument(['abc']) as never,
      new Position(0, 3) as never,
      {} as never,
      token as never,
    );
    await vi.advanceTimersByTimeAsync(250);
    token.cancel();
    // Nobody re-invokes the provider: after the 1 s TTL the request must be aborted
    // instead of generating into the void.
    await vi.advanceTimersByTimeAsync(1000);
    expect(aborted).toBe(true);
    void invocation1;
  });
});


