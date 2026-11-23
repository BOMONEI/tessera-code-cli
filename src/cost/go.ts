import { BASE_URL } from '../config.js';

/**
 * Real usage from OpenCode Go: `GET {BASE_URL}/usage` reports each allowance window's percent (0-100) and reset time.
 * It is a plain account read (no model request, no allowance spent) and undocumented, so a failed call or a reply
 * without usable windows means "no data" and the local estimate shows instead.
 */

export interface GoUsage {
  /** Percent of each allowance window the server reports; absent when it does not report that window. */
  fiveHour?: number;
  week?: number;
  month?: number;
  /** When each window resets (epoch ms), from the server's `resetsAt`. */
  fiveHourReset?: number;
  weekReset?: number;
  monthReset?: number;
}

interface GoWindow {
  status?: unknown;
  percent?: unknown;
  resetsAt?: unknown;
}

interface GoReply {
  usage?: { rolling?: GoWindow; weekly?: GoWindow; monthly?: GoWindow };
}

const TTL = 30_000;
let cache: { key: string; at: number; usage?: GoUsage } = { key: '', at: 0, usage: undefined };
let inflight: Promise<GoUsage | undefined> | undefined;

const percent = (w: GoWindow | undefined): number | undefined =>
  typeof w?.percent === 'number' && w.percent >= 0 && w.percent <= 100 ? w.percent : undefined;

const resetOf = (w: GoWindow | undefined): number | undefined => {
  const r = typeof w?.resetsAt === 'string' ? Date.parse(w.resetsAt) : NaN;
  return Number.isFinite(r) ? r : undefined;
};

/**
 * The Go server's own usage for `apiKey`, in percent per window; undefined when the endpoint fails or the reply has
 * no usable windows. One fetch is shared per key for TTL ms (a turn start, its end and the idle timer can overlap).
 */
export async function fetchGoUsage(apiKey: string, fetchFn: typeof fetch = fetch): Promise<GoUsage | undefined> {
  if (Date.now() - cache.at < TTL && cache.key === apiKey) return cache.usage;
  inflight ??= (async () => {
    let usage: GoUsage | undefined;
    try {
      const r = await fetchFn(`${BASE_URL}/usage`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
      if (r.ok) {
        const j = (await r.json()) as GoReply;
        const u: GoUsage = {
          fiveHour: percent(j.usage?.rolling),
          week: percent(j.usage?.weekly),
          month: percent(j.usage?.monthly),
          fiveHourReset: resetOf(j.usage?.rolling),
          weekReset: resetOf(j.usage?.weekly),
          monthReset: resetOf(j.usage?.monthly),
        };
        if (u.fiveHour !== undefined || u.week !== undefined || u.month !== undefined) usage = u;
      }
    } catch {
      // offline, slow, or a shape we do not know: no real numbers, the local estimate shows instead
    }
    cache = { key: apiKey, at: Date.now(), usage };
    return usage;
  })().finally(() => (inflight = undefined));
  return inflight;
}
