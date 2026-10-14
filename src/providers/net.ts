import { BASE_URL } from '../config.js';

type Undici = typeof import('undici');
let pool: Promise<{ agent: InstanceType<Undici['Agent']>; fetch: Undici['fetch'] }> | undefined;

/**
 * One connection pool for every API call. Node's fetch drops idle connections after 4s, so a turn that starts
 * after the user typed for a while paid a new TLS handshake (~300-400ms) each time; OpenCode Go (Cloudflare) keeps
 * idle connections well over a minute, so they are kept for 60s. undici loads on first use (it costs ~90ms).
 */
function connections() {
  pool ??= import('undici').then((mod) => {
    const u = (mod as unknown as { default?: Undici }).default ?? mod; // CommonJS: bundled under `default`
    // headersTimeout: a connection that silently died (Wi-Fi/VPN switch) fails in 2 minutes, not undici's 5.
    return { agent: new u.Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, headersTimeout: 120_000 }), fetch: u.fetch };
  });
  return pool;
}

/** A kept-alive socket the network dropped meanwhile (laptop sleep, Wi-Fi/VPN switch) fails before any response. */
function staleSocket(e: unknown): boolean {
  const cause = (e as { cause?: { code?: string } })?.cause;
  return ['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE', 'UND_ERR_CLOSED'].includes(cause?.code ?? '');
}

export const apiFetch: typeof fetch = async (input, init) => {
  const { agent, fetch } = await connections();
  const send = () => fetch(input as Parameters<Undici['fetch']>[0], { ...(init as Parameters<Undici['fetch']>[1]), dispatcher: agent }) as unknown as Promise<Response>;
  try {
    return await send();
  } catch (e) {
    // No response arrived, so the request never ran: retry once on a fresh connection before the caller treats
    // it as an outage (and falls back to another model).
    if (staleSocket(e) && !init?.signal?.aborted && typeof init?.body !== 'object') return send();
    throw e;
  }
};

/** Opens the connection in the background (DNS + TLS) so the first request does not pay for it. */
export function warmUp(apiKey: string): void {
  apiFetch(`${BASE_URL}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) })
    .then((r) => r.arrayBuffer())
    .catch(() => {}); // only an optimization
}
