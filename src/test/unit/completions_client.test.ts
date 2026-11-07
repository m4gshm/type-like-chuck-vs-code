import { describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { CompletionError, CompletionsClient } from '../../completions_client';
import { buildTemplateRegistry } from '../../templates';
import { FimTemplate } from '../../templates/types';

// ---- fakes ------------------------------------------------------------------

function fakeSdk(createImpl: (params: unknown, options: { signal: AbortSignal }) => Promise<AsyncIterable<{ choices: Array<{ text?: string }> }>>) {
  return {
    completions: { create: vi.fn(createImpl) },
    models: { list: vi.fn() },
  };
}

function clientWith(sdk: ReturnType<typeof fakeSdk>): CompletionsClient {
  return new CompletionsClient(
    () => 'http://stub/v1',
    () => 'stub-model',
    () => 256,
    undefined,
    undefined,
    () => sdk as unknown as Pick<OpenAI, 'completions' | 'models'>,
  );
}

function clientWithoutEndpoint(sdk: ReturnType<typeof fakeSdk>): CompletionsClient {
  return new CompletionsClient(
    () => '',
    () => 'stub-model',
    () => 256,
    undefined,
    undefined,
    () => sdk as unknown as Pick<OpenAI, 'completions' | 'models'>,
  );
}

async function* stream(parts: string[]) {
  for (const text of parts) {
    yield { choices: [{ text }] };
  }
}

const qwen2: FimTemplate = buildTemplateRegistry('qwen2', undefined).registry.resolve('qwen2').template as FimTemplate;

function complete(client: CompletionsClient, prefix = '', suffix = '', signal = new AbortController().signal) {
  return client.complete({ prefix, suffix, template: qwen2, signal });
}

// ---------------------------------------------------------------------------

describe('CompletionsClient.complete', () => {
  it('fails fast on an empty endpoint instead of leaking to the SDK default host', async () => {
    const sdk = fakeSdk(async () => stream(['should not be reached']));
    await expect(complete(clientWithoutEndpoint(sdk))).rejects.toThrow('No completions endpoint');
    expect(sdk.completions.create).not.toHaveBeenCalled();
  });

  it('accumulates streamed chunks into the completion text', async () => {
    const sdk = fakeSdk(async () => stream(['Hello', ', ', 'world']));
    const result = await complete(clientWith(sdk), 'const x = ', '\n');
    expect(result.text).toBe('Hello, world');
    expect(sdk.completions.create).toHaveBeenCalledTimes(1);
  });

  it('cuts the text at a reserved token appearing in the stream and stops consuming', async () => {
    const sdk = fakeSdk(async () => stream(['foo<|fim_pad|>', 'GARBAGE', 'MORE']));
    const result = await complete(clientWith(sdk));
    expect(result.text).toBe('foo');
  });

  it('skips a leading markdown fence line from instruct models', async () => {
    const sdk = fakeSdk(async () => stream(['```go\n', 'if x > 0 {']));
    expect(await complete(clientWith(sdk))).toMatchObject({ text: 'if x > 0 {' });
  });

  it('skips the fence even when it arrives without a trailing newline in one chunk', async () => {
    const sdk = fakeSdk(async () => stream(['```go', '\n', 'return a + b']));
    expect(await complete(clientWith(sdk))).toMatchObject({ text: 'return a + b' });
  });

  it('returns empty when the completion is only a fence opener', async () => {
    const sdk = fakeSdk(async () => stream([' ```go']));
    expect(await complete(clientWith(sdk))).toMatchObject({ text: '' });
  });

  it('keeps a fence in the middle of the generated text', async () => {
    const sdk = fakeSdk(async () => stream(['code ```go\n more']));
    expect(await complete(clientWith(sdk))).toMatchObject({ text: 'code ```go' });
  });
  it('cuts the text at the first newline', async () => {
    const sdk = fakeSdk(async () => stream(['foo', 'bar\nbaz()', 'more']));
    const result = await complete(clientWith(sdk));
    expect(result.text).toBe('foobar');
  });

  it('cuts degenerate repetition via loop detection', async () => {
    const loop = 'xyz'.repeat(12); // way above the multi-block repetition threshold
    const sdk = fakeSdk(async () => stream([loop, 'tail never reached']));
    const result = await complete(clientWith(sdk));
    expect(result.text.length).toBeLessThan(loop.length);
    expect(result.text).not.toContain('tail');
  });

  it('masks reserved tokens in the user code sent as prompt', async () => {
    const sdk = fakeSdk(async () => stream(['ok']));
    await complete(clientWith(sdk), 'x = <%= "<|fim_pad|>" %> y', '');
    const params = sdk.completions.create.mock.calls[0][0] as { prompt: string };
    // The masked prefix contains the token with a space inserted after the first char…
    expect(params.prompt).toContain('< |fim_pad|>');
    // …but the raw token must not appear in the prefix part (it only occurs as the structural marker).
    expect(params.prompt.split('<|fim_pad|>').length - 1).toBe(0);
  });

  it('masks reserved tokens in the suffix too', async () => {
    const sdk = fakeSdk(async () => stream(['ok']));
    await complete(clientWith(sdk), '', '\nconst s = "<|endoftext|>";');
    const params = sdk.completions.create.mock.calls[0][0] as { prompt: string };
    expect(params.prompt).toContain('< |endoftext|>');
  });

  it('returns empty text when only whitespace was generated', async () => {
    const sdk = fakeSdk(async () => stream(['   ', '\n']));
    const result = await complete(clientWith(sdk));
    expect(result.text).toBe('');
  });

  it('rethrows aborts as-is (cancellation is handled by the provider)', async () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    const sdk = fakeSdk(async () => {
      throw abort;
    });
    await expect(complete(clientWith(sdk))).rejects.toBe(abort);
  });

  it('maps generic failures to a connection CompletionError', async () => {
    const sdk = fakeSdk(async () => {
      throw new Error('socket hang up');
    });
    const err = await complete(clientWith(sdk)).catch((e) => e);
    expect(err).toBeInstanceOf(CompletionError);
    expect((err as CompletionError).kind).toBe('connection');
  });

  it('maps 401/403 API errors to the auth CompletionError', async () => {
    const sdk = fakeSdk(async () => {
      throw new OpenAI.APIError(401, { message: 'denied' }, 'denied', undefined);
    });
    const err = await complete(clientWith(sdk)).catch((e) => e);
    expect((err as CompletionError).kind).toBe('auth');
    expect((err as CompletionError).message).toContain('Set the API key');
  });

  it('maps other API errors to the "other" kind keeping the status', async () => {
    const sdk = fakeSdk(async () => {
      throw new OpenAI.APIError(500, {}, 'boom', undefined);
    });
    const err = await complete(clientWith(sdk)).catch((e) => e);
    expect((err as CompletionError).kind).toBe('other');
    expect((err as CompletionError).message).toContain('500');
  });
});

describe('CompletionsClient.listModels', () => {
  it('extracts ids and context lengths from the raw model entries', async () => {
    const sdk = fakeSdk(async () => stream([]));
    (sdk.models.list as ReturnType<typeof vi.fn>).mockReturnValue(
      (async function* () {
        yield { id: 'm1', n_ctx: 4096 };
        yield { id: 'm2', meta: { n_ctx_train: 32768 } };
        yield { id: 'm3' };
      })(),
    );
    const models = await clientWith(sdk).listModels();
    expect(models).toEqual([
      { id: 'm1', contextLength: 4096 },
      { id: 'm2', contextLength: 32768 },
      { id: 'm3', contextLength: undefined },
    ]);
  });
});

describe('CompletionsClient stdio transport', () => {
  it('routes completions through the stdio source and keeps single-line truncation', async () => {
    const client = clientWith(fakeSdk(async () => {
      throw new Error('HTTP must not be used when a stdio source is set');
    }));
    client.setStdioSource(async function* (prompt, maxTokens, stop) {
      expect(prompt).toContain('<|fim_prefix|>');
      expect(maxTokens).toBe(256);
      expect(stop).toContain('\n');
      yield 'const x = 1';
      yield '\nlet y';
    });
    const result = await complete(client, 'const x = ', '');
    expect(result.text).toBe('const x = 1');
  });

  it('cuts at reserved tokens produced by the runner', async () => {
    const client = clientWith(fakeSdk(async () => stream([])));
    client.setStdioSource(async function* () {
      yield 'good';
      yield '<|fim_pad|>leak';
    });
    const result = await complete(client);
    expect(result.text).toBe('good');
  });

  it('returns to the HTTP transport when the source is cleared', async () => {
    let httpUsed = false;
    const sdk = fakeSdk(async () => {
      httpUsed = true;
      return stream(['from http']);
    });
    const client = clientWith(sdk);
    client.setStdioSource(async function* () {
      yield 'from stdio';
    });
    client.setStdioSource(undefined);
    const result = await complete(client);
    expect(httpUsed).toBe(true);
    expect(result.text).toBe('from http');
  });

  it('reports the local model label for traces and falls back when cleared', () => {
    const client = clientWith(fakeSdk(async () => stream([])));
    client.setModelLabel('3b');
    expect(client.model).toBe('3b');
    client.setModelLabel(undefined);
    expect(client.model).toBe('stub-model');
  });

  it('labels the endpoint as stdio only while a source is set', () => {
    const client = clientWith(fakeSdk(async () => stream([])));
    expect(client.endpoint).toBe('http://stub/v1');
    client.setStdioSource(async function* () {
      yield 'x';
    });
    expect(client.endpoint).toBe('stdio');
    client.setStdioSource(undefined);
    expect(client.endpoint).toBe('http://stub/v1');
  });
});
