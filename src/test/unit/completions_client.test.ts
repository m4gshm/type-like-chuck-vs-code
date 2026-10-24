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
    expect((err as CompletionError).message).toContain('TLC: Set API Key');
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
