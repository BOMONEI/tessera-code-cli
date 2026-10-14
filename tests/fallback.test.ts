import { describe, expect, it } from 'vitest';
import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { shouldFallBack, withFallback, type FallbackEvent } from '../src/providers/fallback.js';
import { createModel, NonZdrModelError } from '../src/providers/index.js';
import type { ModelInfo } from '../src/providers/catalog.js';

const info = (id: string): ModelInfo => ({ id, name: id, format: 'chat', context: 1000, output: 100, reasoning: false, cost: { input: 0, output: 0, cacheRead: 0 } });

/** Mock model: waits `delayMs` before its first content part (respecting abort), or fails. */
function mock(id: string, behavior: { delayMs?: number; fail?: string; status?: number; calls?: string[] }): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: id,
    supportedUrls: {},
    doGenerate: async () => { throw new Error('unused'); },
    async doStream({ abortSignal }) {
      behavior.calls?.push(id);
      if (behavior.fail) throw Object.assign(new Error(behavior.fail), behavior.status ? { statusCode: behavior.status } : {});
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        async start(c) {
          c.enqueue({ type: 'stream-start', warnings: [] });
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, behavior.delayMs ?? 0);
            abortSignal?.addEventListener('abort', () => (clearTimeout(t), reject(new DOMException('aborted', 'AbortError'))));
          }).catch((e) => c.error(e));
          try {
            c.enqueue({ type: 'text-start', id: '1' });
            c.enqueue({ type: 'text-delta', id: '1', delta: `from ${id}` });
            c.enqueue({ type: 'text-end', id: '1' });
            c.close();
          } catch {
            // stream already errored by abort
          }
        },
      });
      return { stream };
    },
  } as LanguageModelV4;
}

async function text(model: LanguageModelV4, signal?: AbortSignal): Promise<string> {
  const { stream } = await model.doStream({ prompt: [], abortSignal: signal } as never);
  let out = '';
  for await (const p of stream as unknown as AsyncIterable<LanguageModelV4StreamPart>) if (p.type === 'text-delta') out += p.delta;
  return out;
}

describe('withFallback', () => {
  const opts = (events: FallbackEvent[], served: string[]) => ({
    firstTokenTimeoutMs: 50,
    stickyMs: 10_000,
    onFallback: (e: FallbackEvent) => events.push(e),
    onServed: (m: ModelInfo) => served.push(m.id),
  });

  it('switches to the next model when the primary is silent past the timeout', async () => {
    const events: FallbackEvent[] = [];
    const served: string[] = [];
    const m = withFallback([{ info: info('a'), model: mock('a', { delayMs: 500 }) }, { info: info('b'), model: mock('b', {}) }], opts(events, served));
    expect(await text(m)).toBe('from b');
    expect(events).toEqual([{ from: 'a', to: 'b', reason: 'no response within 0.05s' }]);
    expect(served).toEqual(['b']);
  });

  it('uses the primary when it answers in time', async () => {
    const m = withFallback([{ info: info('a'), model: mock('a', { delayMs: 5 }) }, { info: info('b'), model: mock('b', {}) }], opts([], []));
    expect(await text(m)).toBe('from a');
  });

  it('falls back on an error before any content', async () => {
    const events: FallbackEvent[] = [];
    const m = withFallback([{ info: info('a'), model: mock('a', { fail: 'overloaded', status: 503 }) }, { info: info('b'), model: mock('b', {}) }], opts(events, []));
    expect(await text(m)).toBe('from b');
    expect(events[0]!.reason).toBe('HTTP 503: overloaded');
  });

  it('stays on the fallback model while sticky, then retries the primary', async () => {
    const calls: string[] = [];
    const state = { start: 0, until: 0 };
    const m = withFallback(
      [{ info: info('a'), model: mock('a', { delayMs: 500, calls }) }, { info: info('b'), model: mock('b', { calls }) }],
      opts([], []),
      state,
    );
    await text(m);
    await text(m);
    expect(calls).toEqual(['a', 'b', 'b']);
    state.until = 0; // sticky window over
    await text(m);
    expect(calls.at(-2)).toBe('a');
  });

  it('never falls back on a user interrupt', async () => {
    const events: FallbackEvent[] = [];
    const calls: string[] = [];
    const m = withFallback([{ info: info('a'), model: mock('a', { delayMs: 500, calls }) }, { info: info('b'), model: mock('b', { calls }) }], { ...opts(events, []), firstTokenTimeoutMs: 5000 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    await expect(text(m, ac.signal)).rejects.toBeDefined();
    expect(events).toEqual([]);
    expect(calls).toEqual(['a']);
  });

  it('waits for the last model instead of timing it out', async () => {
    const events: FallbackEvent[] = [];
    const m = withFallback([{ info: info('a'), model: mock('a', { delayMs: 500 }) }, { info: info('b'), model: mock('b', { delayMs: 150 }) }], opts(events, []));
    expect(await text(m)).toBe('from b');
    expect(events).toHaveLength(1);
  });

  it('throws the last error when every model fails', async () => {
    const m = withFallback([{ info: info('a'), model: mock('a', { fail: 'x', status: 502 }) }, { info: info('b'), model: mock('b', { fail: 'y', status: 503 }) }], opts([], []));
    await expect(text(m)).rejects.toThrow('y');
  });

  it('falls back on any error status, including request errors (400)', async () => {
    const events: FallbackEvent[] = [];
    const m = withFallback([{ info: info('a'), model: mock('a', { fail: 'bad request', status: 400 }) }, { info: info('b'), model: mock('b', {}) }], opts(events, []));
    expect(await text(m)).toBe('from b');
    expect(events).toEqual([{ from: 'a', to: 'b', reason: 'HTTP 400: bad request' }]);
  });

  it('does not fall back on auth errors: every model shares the key', async () => {
    const events: FallbackEvent[] = [];
    const m = withFallback([{ info: info('a'), model: mock('a', { fail: 'invalid key', status: 401 }) }, { info: info('b'), model: mock('b', {}) }], opts(events, []));
    await expect(text(m)).rejects.toThrow('invalid key');
    expect(events).toEqual([]);
  });

  it('never times out by default: a slow model is waited for', async () => {
    const events: FallbackEvent[] = [];
    const m = withFallback([{ info: info('a'), model: mock('a', { delayMs: 200 }) }, { info: info('b'), model: mock('b', {}) }], { ...opts(events, []), firstTokenTimeoutMs: 0 });
    expect(await text(m)).toBe('from a');
    expect(events).toEqual([]);
  });
});

describe('shouldFallBack', () => {
  it.each([
    [{ statusCode: 429 }, true],
    [{ statusCode: 503 }, true],
    [{ statusCode: 400 }, true],
    [{ statusCode: 404 }, true],
    [{ statusCode: 401 }, false],
    [{ statusCode: 403 }, false],
    [new Error('fetch failed'), true],
    [Object.assign(new Error('request failed'), { cause: Object.assign(new Error('read'), { code: 'ECONNRESET' }) }), true],
    [{ type: 'overloaded_error', message: 'Overloaded' }, true],
    [new TypeError('u.Agent is not a constructor'), false],
    [Object.assign(new Error('invalid header'), { code: 'UND_ERR_INVALID_ARG' }), false],
    [Object.assign(new Error('request failed'), { cause: Object.assign(new Error('closed'), { code: 'UND_ERR_SOCKET' }) }), true],
  ])('%j -> %s', (e, expected) => expect(shouldFallBack(e)).toBe(expected));
});

describe('ZDR enforcement', () => {
  it('refuses to build a model that is not zero-data-retention', () => {
    expect(() => createModel(info('gpt-6-luna'), { apiKey: 'k', sessionId: 's' })).toThrow(NonZdrModelError);
    expect(() => createModel(info('deepseek-v4-flash'), { apiKey: 'k', sessionId: 's' })).toThrow(NonZdrModelError);
    expect(() => createModel(info('mimo-v2.6-flash'), { apiKey: 'k', sessionId: 's' })).not.toThrow();
  });
});
