import OpenAI from 'openai';
import { maskReservedTokens } from './prompt';
import { truncateToLine } from './line_truncation';
import { detectLoop } from './loop_detection';
import { FimTemplate } from './templates/types';

export interface CompletionRequestParams {
  prefix: string;
  suffix: string;
  template: FimTemplate;
  signal: AbortSignal;
}

export interface CompletionResult {
  text: string;
}

export interface ModelInfo {
  id: string;
  /** Maximum context length (tokens) reported by the server, if known. */
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

export class CompletionsClient {
  private client: Pick<OpenAI, 'completions' | 'models'>;
  private apiKey: string | undefined;

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

  /** Lists models available on the server via GET /v1/models. */
  async listModels(): Promise<ModelInfo[]> {
    const page = await this.client.models.list();
    const models: ModelInfo[] = [];
    for await (const model of page) {
      const raw = model as unknown as Record<string, unknown>;
      models.push({ id: String(model.id), contextLength: extractModelContextLength(raw) });
    }
    return models;
  }

  /**
   * Requests a single-line completion: streams chunks (abort-aware),
   * accumulates them and truncates at the first newline.
   */
  async complete({ prefix, suffix, template, signal }: CompletionRequestParams): Promise<CompletionResult> {
    const prompt = template.render(
      maskReservedTokens(prefix, template.reservedTokens),
      maskReservedTokens(suffix, template.reservedTokens),
    );
    try {
      const stream = await this.client.completions.create(
        {
          model: this.getModel(),
          prompt,
          max_tokens: this.getMaxTokens(),
          stop: [...template.reservedTokens],
          stream: true,
        },
        { signal },
      );
      let text = '';
      let done = false;
      let loopDetected = false;
      for await (const chunk of stream) {
        const chunkText = chunk.choices[0]?.text ?? '';
        if (chunkText.length > 0) {
          text += chunkText;
          // Servers may ignore the `stop` parameter: any reserved token that
          // shows up in the stream acts as an implicit stop, cut there.
          let cutAt = -1;
          for (const token of template.reservedTokens) {
            if (token.length > 0) {
              const at = text.indexOf(token);
              if (at !== -1 && (cutAt === -1 || at < cutAt)) {
                cutAt = at;
              }
            }
          }
          if (cutAt !== -1) {
            text = text.slice(0, cutAt);
            done = true;
            break;
          }
          // Degenerate repetition (e.g. <|fim_pad|> repeated): stop early.
          const loop = detectLoop(text);
          if (loop.looped) {
            loopDetected = true;
            text = text.slice(0, loop.cutIndex);
            break;
          }
          const newlineAt = text.match(/[\r\n]/);
          if (newlineAt && newlineAt.index !== undefined) {
            text = text.slice(0, newlineAt.index);
            done = true;
            break;
          }
        }
      }
      if (!done && !loopDetected && !signal.aborted) {
        text = truncateToLine(text).text;
      }
      // Template tags must never leak into the insertion.
      for (const token of template.reservedTokens) {
        if (token) {
          text = text.split(token).join('');
        }
      }
      this.logResponse?.(`api response (${text.length} chars): ${text}`);
      return { text: text.trim().length === 0 ? '' : text };
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
          throw new CompletionError('auth', 'Authentication failed. Set the API key with the "TLC: Set API Key" command.', err);
        }
        throw new CompletionError('other', `API error ${err.status ?? ''}: ${err.message}`, err);
      }
      throw new CompletionError('connection', `Cannot reach the completions API (${this.getBaseUrl()}): ${messageOf(err)}`, err);
    }
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
