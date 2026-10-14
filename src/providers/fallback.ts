import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart, LanguageModelV4StreamResult } from '@ai-sdk/provider';
import type { ModelInfo } from './catalog.js';

export interface FallbackEvent {
  from: string;
  to: string;
  reason: string;
}

export interface FallbackOptions {
  /** Optionally abandon a model that produces no output (text, reasoning or tool call) within this time; 0 = never. */
  firstTokenTimeoutMs: number;
  /** After a fallback, keep using the fallback model for this long before trying the primary again. */
  stickyMs: number;
  onFallback?: (e: FallbackEvent) => void;
  /** Called with the model that actually served each call (for cost accounting). */
  onServed?: (info: ModelInfo) => void;
}

/** Shared between calls of one session so a slow primary is skipped for a while. */
export interface FallbackState {
  /** Index into the chain to start from, until `until`. */
  start: number;
  until: number;
}

// Parts that prove the model is actually responding (the stream-start/metadata parts arrive before any thinking).
const CONTENT = new Set(['text-start', 'text-delta', 'reasoning-start', 'reasoning-delta', 'tool-input-start', 'tool-call', 'finish']);

class TimeoutError extends Error {}

/**
 * Whether a failed call should be retried on the next model: any error status (4xx/5xx), network failures and
 * provider errors streamed before the answer started. Not 401/403: every model uses the same API key, so another
 * model would be rejected the same way.
 */
export function shouldFallBack(e: unknown): boolean {
  if (e instanceof TimeoutError) return true;
  const status = (e as { statusCode?: number } | undefined)?.statusCode;
  if (typeof status === 'number') return status >= 400 && status !== 401 && status !== 403;
  // Provider errors streamed as data (not Error instances), e.g. { type: 'overloaded_error', message }.
  if (!(e instanceof Error)) return true;
  return isNetworkError(e); // a bug in our own code must surface, not walk the whole chain
}

const NETWORK_CODES =
  /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_CLOSED)$/;

function isNetworkError(e: Error): boolean {
  for (let cur: unknown = e; cur instanceof Error; cur = (cur as { cause?: unknown }).cause) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && NETWORK_CODES.test(code)) return true;
    if (/fetch failed|socket|network|terminated|other side closed/i.test(cur.message)) return true;
    if ((cur as { isRetryable?: boolean }).isRetryable) return true;
  }
  return false;
}

function describe(e: unknown): string {
  if (e instanceof TimeoutError) return e.message;
  const err = e as { statusCode?: number; message?: string } | undefined;
  const message = err?.message ?? (typeof e === 'object' ? JSON.stringify(e) : String(e));
  return `${typeof err?.statusCode === 'number' ? `HTTP ${err.statusCode}: ` : 'error: '}${message}`.slice(0, 200);
}

/**
 * A LanguageModel that tries `chain` in order: if a model returns an error before producing any content (or,
 * when configured, no content within the timeout), the same call is retried on the next model. Once content has streamed, the call is
 * committed to that model (switching mid-answer would duplicate output).
 */
export function withFallback(
  chain: Array<{ info: ModelInfo; model: LanguageModelV4 }>,
  opts: FallbackOptions,
  state: FallbackState = { start: 0, until: 0 },
): LanguageModelV4 {
  const primary = chain[0]!;

  async function attempt(i: number, options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    const { model, info } = chain[i]!;
    const controller = new AbortController();
    const outer = options.abortSignal;
    const forward = () => controller.abort(outer?.reason);
    if (outer?.aborted) forward();
    else outer?.addEventListener('abort', forward, { once: true });
    let timedOut = false;
    // The last model has nothing to fall back to, so it gets as long as it needs.
    const isLast = i === chain.length - 1;
    const timer =
      isLast || !(opts.firstTokenTimeoutMs > 0 && Number.isFinite(opts.firstTokenTimeoutMs))
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          controller.abort(new TimeoutError(`no response within ${opts.firstTokenTimeoutMs / 1000}s`));
        }, opts.firstTokenTimeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', forward);
    };

    let reader: ReadableStreamDefaultReader<LanguageModelV4StreamPart> | undefined;
    try {
      const maxOutputTokens = options.maxOutputTokens === undefined ? undefined : Math.min(options.maxOutputTokens, info.output);
      const result = await model.doStream({ ...options, maxOutputTokens, abortSignal: controller.signal });
      reader = result.stream.getReader();
      const buffered: LanguageModelV4StreamPart[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === 'error' && !buffered.some((p) => CONTENT.has(p.type))) throw value.error;
        buffered.push(value);
        if (CONTENT.has(value.type)) break;
      }
      clearTimeout(timer); // committed: the model is responding
      const committed = reader;
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(c) {
          for (const p of buffered) c.enqueue(p);
        },
        async pull(c) {
          try {
            const { done, value } = await committed.read();
            if (done) {
              cleanup();
              c.close();
            } else c.enqueue(value);
          } catch (e) {
            cleanup();
            c.error(e);
          }
        },
        cancel(reason) {
          cleanup();
          return committed.cancel(reason);
        },
      });
      return { ...result, stream };
    } catch (e) {
      cleanup();
      // Release the abandoned attempt's connection before the next model starts.
      if (!controller.signal.aborted) controller.abort();
      reader?.cancel().catch(() => {});
      if (outer?.aborted) throw e; // user interrupt: never fall back
      throw timedOut ? new TimeoutError(`no response within ${opts.firstTokenTimeoutMs / 1000}s`) : e;
    }
  }

  return {
    specificationVersion: 'v4',
    provider: 'tessera-fallback',
    modelId: primary.model.modelId,
    supportedUrls: primary.model.supportedUrls,
    async doGenerate(options) {
      opts.onServed?.(primary.info);
      return primary.model.doGenerate(options);
    },
    async doStream(options) {
      const first = Date.now() < state.until ? state.start : 0;
      let lastError: unknown;
      for (let i = first; i < chain.length; i++) {
        try {
          const result = await attempt(i, options);
          opts.onServed?.(chain[i]!.info);
          return result;
        } catch (e) {
          if (options.abortSignal?.aborted || !shouldFallBack(e)) throw e;
          lastError = e;
          const next = chain[i + 1];
          if (!next) break;
          opts.onFallback?.({ from: chain[i]!.info.id, to: next.info.id, reason: describe(e) });
          state.start = i + 1;
          state.until = Date.now() + opts.stickyMs;
        }
      }
      throw lastError;
    },
  };
}
