import { BRAND } from './brand';
import OpenAI from 'openai';
import { messageOf } from './errors';
import { maskReservedTokens } from './prompt';
import { consumeChunks } from './response_filter';
import { FimTemplate } from './templates/types';

export interface CompletionRequestParams {
  prefix: string;
  suffix: string;
  template: FimTemplate;
  signal: AbortSignal;
}

export interface CompletionResult {
  text: string;
  /** Server-reported phases, e.g. "prompt 1554 tok in 655 ms, gen 24 tok in 1172 ms (20.5 t/s)". */
  timings?: string;
}

export interface ModelInfo {
  id: string;
  contextLength?: number;
}

/** Picks the context length out of the raw /v1/models entry (server-specific field names). */
export function extractModelContextLength(raw: Record<string, unknown>): number | undefined {
  const meta = (raw.meta ?? {}) as Record<string, unknown>;
  const candidates = [
    raw.max_context,
    raw.context_length,
    raw.max_model_len,
    raw.context_window,
    raw.n_ctx,
    meta.n_ctx,
    meta.n_ctx_train,
    meta.max_context,
  ];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  }
  return undefined;
}

export type CompletionErrorKind = 'auth' | 'connection' | 'other';

export class CompletionError extends Error {
  constructor(readonly kind: CompletionErrorKind, message: string, readonly cause?: unknown) {
    super(message);
  }
}

export type StdioCompletionSource = (
  prompt: string,
  maxTokens: number,
  stop: string[],
  signal: AbortSignal,
) => AsyncIterable<string>;

export class CompletionsClient {
  private client: Pick<OpenAI, 'completions' | 'models'>;
  private apiKey: string | undefined;
  private stdioSource: StdioCompletionSource | undefined;
  private modelLabel: string | undefined;

  constructor(
    private readonly getBaseUrl: () => string,
    private readonly getModel: () => string,
    private readonly getMaxTokens: () => number,
    private readonly logCause?: (message: string) => void,
    private readonly logResponse?: (message: string) => void,
    private readonly createSdk: (options: {
      baseURL: string;
      apiKey: string;
      defaultHeaders: Record<string, string>;
      maxRetries: number;
    }) => Pick<OpenAI, 'completions' | 'models'> = (options) => new OpenAI(options),
  ) {
    this.client = this.createClient();
  }

  /** Transport label for traces: the stdio runner has no HTTP endpoint, so
   * reporting the (placeholder) base URL there would mislead diagnostics. */
  get endpoint(): string {
    return this.stdioSource !== undefined ? 'stdio' : this.getBaseUrl();
  }

  get model(): string {
    return this.modelLabel ?? this.getModel();
  }

  private createClient(): Pick<OpenAI, 'completions' | 'models'> {
    return this.createSdk({
      baseURL: this.getBaseUrl(),
      apiKey: this.apiKey || 'TLC',
      defaultHeaders: { 'User-Agent': 'TLC' },
      maxRetries: 0,
    });
  }

  async setApiKey(key: string | undefined): Promise<void> {
    this.apiKey = key;
    this.client = this.createClient();
  }

  /**
   * Recreates the underlying SDK client. Must be called when the base URL
   * changes: the SDK captures baseURL at client construction, so a changed
   * setting would otherwise never take effect.
   */
  refresh(): void {
    this.client = this.createClient();
  }

  /**
   * Routes completions through the local stdio runner instead of HTTP (ovgenai
   * engine kind). Passing undefined returns to the HTTP transport.
   */
  setStdioSource(source: StdioCompletionSource | undefined): void {
    this.stdioSource = source;
  }

  /** Model shown in traces while the stdio transport is active: the local
   * engine serves tlc.local.model, unrelated to the remote tlc.model setting. */
  setModelLabel(label: string | undefined): void {
    this.modelLabel = label;
  }

  /** The OpenAI SDK silently defaults an empty baseURL to api.openai.com; an
   * empty endpoint in local mode means the engine is not ready yet — fail fast
   * instead of leaking a 401 from the wrong host. */
  private requireEndpoint(): void {
    if (this.getBaseUrl() === '') {
      throw new CompletionError('connection', 'No completions endpoint configured (local engine is not ready).');
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    this.requireEndpoint();
    const page = await this.client.models.list();
    const models: ModelInfo[] = [];
    for await (const model of page) {
      const raw = model as unknown as Record<string, unknown>;
      models.push({ id: String(model.id), contextLength: extractModelContextLength(raw) });
    }
    return models;
  }

  async complete({ prefix, suffix, template, signal }: CompletionRequestParams): Promise<CompletionResult> {
    const prompt = template.render(
      maskReservedTokens(prefix, template.reservedTokens),
      maskReservedTokens(suffix, template.reservedTokens),
    );
    const startedAt = Date.now();
    if (this.stdioSource !== undefined) {
      const source = this.stdioSource;
      const chunks = source(prompt, this.getMaxTokens(), [...template.reservedTokens, '\n'], signal);
      return consumeChunks(
        (async function* (): AsyncIterable<{ choices: Array<{ text?: string }> }> {
          for await (const token of chunks) {
            yield { choices: [{ text: token }] };
          }
        })(),
        template,
        startedAt,
        signal,
        this.logResponse,
      );
    }
    this.requireEndpoint();
    try {
      // `timings_per_token` is a llama.cpp extension; other servers ignore the
      // unknown field. Raw param types: the SDK's would reject the extra key.
      const create = this.client.completions.create.bind(this.client.completions) as unknown as (
        params: Record<string, unknown>,
        options: { signal: AbortSignal },
      ) => Promise<AsyncIterable<{ choices: Array<{ text?: string }>; timings?: Record<string, unknown> }>>;
      const stream = await create(
        {
          model: this.getModel(),
          prompt,
          max_tokens: this.getMaxTokens(),
          stop: [...template.reservedTokens],
          stream: true,
          // llama.cpp: emit timings in every stream chunk, so the phases are
          // known even when the consumer stops at the first newline.
          timings_per_token: true,
        },
        { signal },
      );
      return await consumeChunks(
        (async function* (): AsyncIterable<{ choices: Array<{ text?: string }> }> {
          for await (const chunk of stream) {
            yield chunk;
          }
        })(),
        template,
        startedAt,
        signal,
        this.logResponse,
      );
    } catch (err) {
      if (signal.aborted || isAbortError(err)) {
        // Cancellation, handled silently by the provider. Normalize the error
        // name: e.g. the OpenAI SDK throws APIUserAbortError on abort.
        throw isAbortError(err) ? err : new DOMException(messageOf(err), 'AbortError');
      }
      if (err instanceof OpenAI.APIConnectionError) {
        const cause = (err as unknown as { cause?: unknown }).cause;
        this.logCause?.(`connection failure detail: ${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}`);
        throw new CompletionError('connection', `Cannot reach the completions API (${this.getBaseUrl()}): ${err.message}`, err);
      }
      if (err instanceof OpenAI.APIError) {
        if (err.status === 401 || err.status === 403) {
          throw new CompletionError('auth', `Authentication failed. Set the API key with the "${BRAND}: Set API Key" command.`, err);
        }
        throw new CompletionError('other', `API error ${err.status ?? ''}: ${err.message}`, err);
      }
      throw new CompletionError('connection', `Cannot reach the completions API (${this.getBaseUrl()}): ${messageOf(err)}`, err);
    }
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error ? err.name === 'AbortError' : false;
}


