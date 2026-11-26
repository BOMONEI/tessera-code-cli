import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { saveGlobalSetting } from './config.js';
import { providerSettings, setProviderSettings, type ProviderSettings } from './providers/registry.js';
import type { Config } from './config.js';

/** Tokens of a subscription login (OAuth). Stored under providers.<id>.oauth in config.json. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; the token is refreshed a few minutes before this. */
  expiresAt: number;
  scope?: string;
  /** ChatGPT account id, sent as chatgpt-account-id on API calls when the token carries one. */
  accountId?: string;
}

export interface OAuthFlow {
  id: string;
  name: string;
  /** Fixed loopback port the provider has registered (0 = any free port). */
  port?: number;
  /** Callback path on that port (default /callback). */
  callbackPath?: string;
  /** The URL the browser opens for this sign-in. */
  authorizeUrl: (redirect: string, challenge: string, state: string) => string;
  /** Swaps the code for tokens (or, for OpenRouter, for a permanent personal key). */
  exchange: (code: string, verifier: string, redirect: string, state: string, fetchFn: typeof fetch) => Promise<{ key?: string; oauth?: OAuthTokens }>;
  /** Renews tokens; a rotated refresh_token in the response replaces the stored one. */
  refresh?: (refreshToken: string, fetchFn: typeof fetch) => Promise<OAuthTokens | undefined>;
}

const base64url = (b: Buffer) => b.toString('base64url');
export const pkceVerifier = () => base64url(randomBytes(32));
export const pkceChallenge = (verifier: string) => base64url(createHash('sha256').update(verifier).digest());

/** Opens a URL in the browser (best effort; the caller shows the URL on failure). */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const c = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    c.on('error', () => {});
    c.unref();
  } catch {
    // the terminal still gets the URL from the caller
  }
}

/** Serves one loopback callback, waits for `?code=`, and resolves with it. */
function loopbackWait(timeoutMs: number, port = 0, pathname = '/callback'): { redirect: Promise<string>; result: Promise<{ code: string; state: string }>; close: () => void } {
  let settle: (v: { code: string; state: string }) => void = () => {};
  let fail: (e: Error) => void = () => {};
  const result = new Promise<{ code: string; state: string }>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname !== pathname) {
      res.writeHead(404).end();
      return;
    }
    const code = u.searchParams.get('code');
    const state = u.searchParams.get('state') ?? '';
    res
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end('<html><body style="font-family:sans-serif"><h2>Signed in</h2><p>You can close this tab and return to the terminal.</p></body></html>');
    clearTimeout(timer);
    server.close();
    if (!code) fail(new Error('The sign-in page returned no code.'));
    else settle({ code, state });
  });
  const timer = setTimeout(() => {
    server.close();
    fail(new Error('Sign-in timed out after 5 minutes.'));
  }, timeoutMs);
  const redirect = new Promise<string>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use — close whatever holds it and run /login again.` : `Could not start the sign-in callback: ${e.message}`));
    });
    server.listen(port, '127.0.0.1', () => {
      const bound = (server.address() as AddressInfo).port;
      resolve(`http://127.0.0.1:${bound}${pathname}`);
    });
  });
  return { redirect, result, close: () => clearTimeout(timer) };
}

/**
 * Runs one sign-in end to end: loopback server → browser → code → exchange. `onAuthorize` receives the URL
 * (tests drive the callback themselves); by default it opens the browser.
 */
export async function loginFlow(
  flow: OAuthFlow,
  opts: { fetch?: typeof fetch; onAuthorize?: (url: string) => void | Promise<void>; timeoutMs?: number } = {},
): Promise<{ key?: string; oauth?: OAuthTokens }> {
  const verifier = pkceVerifier();
  const challenge = pkceChallenge(verifier);
  const state = verifier; // Anthropic's observed convention: state carries the verifier
  const loop = loopbackWait(opts.timeoutMs ?? 300_000, flow.port ?? 0, flow.callbackPath ?? '/callback');
  try {
    const redirect = await loop.redirect;
    const url = flow.authorizeUrl(redirect, challenge, state);
    await (opts.onAuthorize ?? ((u: string) => openBrowser(u)))(url);
    const { code } = await loop.result;
    return await flow.exchange(code, verifier, redirect, state, opts.fetch ?? fetch);
  } finally {
    loop.close();
  }
}

const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const ANTHROPIC_SCOPE = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

async function anthropicTokenRequest(body: Record<string, string>, fetchFn: typeof fetch): Promise<Response> {
  // Implementations disagree on the body type: JSON first (what Claude Code sends), form as the fallback.
  let r = await fetchFn(ANTHROPIC_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) {
    r = await fetchFn(ANTHROPIC_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  }
  return r;
}

async function anthropicTokens(r: Response, previous?: OAuthTokens): Promise<OAuthTokens> {
  if (!r.ok) throw new Error(`Anthropic token exchange failed (HTTP ${r.status}).`);
  const j = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!j.access_token) throw new Error('Anthropic token exchange returned no access token.');
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? previous?.refreshToken, // refresh tokens rotate: keep the new one
    expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000,
    scope: j.scope ?? previous?.scope,
  };
}

export const anthropicFlow: OAuthFlow = {
  id: 'anthropic',
  name: 'Anthropic (Claude Pro/Max)',
  authorizeUrl: (redirect, challenge, state) =>
    `https://console.anthropic.com/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: ANTHROPIC_CLIENT_ID,
      redirect_uri: redirect,
      scope: ANTHROPIC_SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    })}`,
  exchange: async (code, verifier, redirect, state, fetchFn) => {
    const r = await anthropicTokenRequest(
      { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: ANTHROPIC_CLIENT_ID, code_verifier: verifier, state },
      fetchFn,
    );
    return { oauth: await anthropicTokens(r) };
  },
  refresh: async (refreshToken, fetchFn) => {
    const r = await anthropicTokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: ANTHROPIC_CLIENT_ID }, fetchFn);
    return r.ok ? anthropicTokens(r, { accessToken: '', refreshToken, expiresAt: 0 }) : undefined;
  },
};

export const openrouterFlow: OAuthFlow = {
  id: 'openrouter',
  name: 'OpenRouter',
  authorizeUrl: (redirect, challenge) => `https://openrouter.ai/auth?${new URLSearchParams({ callback_url: redirect, code_challenge: challenge, code_challenge_method: 'S256' })}`,
  exchange: async (code, verifier, _redirect, _state, fetchFn) => {
    const r = await fetchFn('https://openrouter.ai/api/v1/auth/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`OpenRouter key exchange failed (HTTP ${r.status}).`);
    const j = (await r.json()) as { key?: string };
    if (!j.key) throw new Error('OpenRouter returned no key.');
    return { key: j.key }; // a permanent personal key: no refresh, no expiry
  },
};

const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'; // Grok CLI's public client
const XAI_SCOPE = 'openid profile email offline_access grok-cli:access api:access conversations:read conversations:write';

/** Grok CLI subscription. The token only works on the CLI proxy (a different host, Responses shape) — the client
 *  for that lives in providers/index.ts, keyed on `settings.oauth`. */
export const xaiFlow: OAuthFlow = {
  id: 'xai',
  name: 'xAI (Grok)',
  port: 56121, // the only port xAI has registered
  authorizeUrl: (redirect, challenge, state) =>
    `https://auth.x.ai/oauth2/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: XAI_CLIENT_ID,
      redirect_uri: redirect,
      scope: XAI_SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      nonce: randomBytes(16).toString('hex'),
      plan: 'generic', // without it the loopback redirect is refused
      referrer: 'tessera-code',
    })}`,
  exchange: async (code, verifier, redirect, _state, fetchFn) => {
    // xAI's token endpoint takes a form body (the opposite of Anthropic's JSON).
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: XAI_CLIENT_ID, code, redirect_uri: redirect, code_verifier: verifier });
    const r = await fetchFn('https://auth.x.ai/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`xAI token exchange failed (HTTP ${r.status}).`);
    const j = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
    if (!j.access_token) throw new Error('xAI token exchange returned no access token.');
    return {
      oauth: {
        accessToken: j.access_token,
        refreshToken: j.refresh_token,
        expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000,
        scope: j.scope,
      },
    };
  },
  refresh: async (refreshToken, fetchFn) => {
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: XAI_CLIENT_ID, refresh_token: refreshToken });
    const r = await fetchFn('https://auth.x.ai/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return undefined;
    const j = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
    if (!j.access_token) return undefined;
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token ?? refreshToken,
      expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000,
      scope: j.scope,
    };
  },
};

/** Reads a claim from a JWT payload without verifying it (the token came straight from the issuer over TLS). */
function jwtClaim(token: string | undefined, claim: string): string | undefined {
  if (!token) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    const v = payload[claim];
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'; // Codex CLI's public client (openai/codex)
const OPENAI_REDIRECT = 'http://127.0.0.1:1455/auth/callback'; // the only registered loopback port+path

/** ChatGPT subscription (Codex). The token drives chatgpt.com/backend-api/codex — a Responses endpoint with its
 *  own headers; the client for it lives in providers/index.ts, keyed on `settings.oauth`. */
export const openaiFlow: OAuthFlow = {
  id: 'openai',
  name: 'OpenAI (ChatGPT / Codex)',
  port: 1455,
  callbackPath: '/auth/callback',
  authorizeUrl: (redirect, challenge, state) =>
    `https://auth.openai.com/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: OPENAI_CLIENT_ID,
      redirect_uri: redirect,
      scope: 'openid profile email offline_access',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    })}`,
  exchange: async (code, verifier, redirect, _state, fetchFn) => {
    const r = await fetchFn('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: OPENAI_CLIENT_ID, code_verifier: verifier }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`OpenAI token exchange failed (HTTP ${r.status}).`);
    const j = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; account_id?: string; id_token?: string };
    if (!j.access_token) throw new Error('OpenAI token exchange returned no access token.');
    return {
      oauth: {
        accessToken: j.access_token,
        refreshToken: j.refresh_token, // single-use rotation: always take the new one
        expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000,
        // The API needs chatgpt-account-id (403 without it); it lives in the id_token when not in the body.
        accountId: j.account_id ?? jwtClaim(j.id_token, 'https://api.openai.com/auth.chatgpt_account_id'),
      },
    };
  },
  refresh: async (refreshToken, fetchFn) => {
    const r = await fetchFn('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: OPENAI_CLIENT_ID }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return undefined;
    const j = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; account_id?: string };
    if (!j.access_token) return undefined;
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token ?? refreshToken,
      expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000,
      accountId: j.account_id,
    };
  },
};

/** Providers with a subscription sign-in (the /login picker). */
export const OAUTH_FLOWS: OAuthFlow[] = [anthropicFlow, openrouterFlow, xaiFlow, openaiFlow];
export const oauthFlow = (id: string): OAuthFlow | undefined => OAUTH_FLOWS.find((f) => f.id === id);

/** The model slugs this ChatGPT plan actually allows (the catalog's ids can be rejected by the Codex backend). */
export async function fetchCodexModels(tokens: OAuthTokens, fetchFn: typeof fetch = fetch): Promise<string[] | undefined> {
  try {
    const r = await fetchFn('https://chatgpt.com/backend-api/codex/models?client_version=0.0.0', {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        ...(tokens.accountId ? { 'chatgpt-account-id': tokens.accountId } : {}),
        originator: 'tessera-code',
        'openai-beta': 'responses=experimental',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return undefined;
    const j = (await r.json()) as { models?: Array<{ slug?: string; visibility?: string }> };
    const slugs = [...new Set((j.models ?? []).filter((m) => m.slug && m.visibility !== 'hidden').map((m) => m.slug!))];
    return slugs.length ? slugs : undefined;
  } catch {
    return undefined;
  }
}

const REFRESH_MARGIN_MS = 10 * 60_000;

/**
 * Renews every stored token that is within 10 minutes of expiring; returns true when anything changed (the
 * model clients cache their key, so the caller must drop them). Best effort: a failed refresh is left for the
 * next attempt, never fails the turn.
 */
export async function refreshDueProviders(config: Config, fetchFn: typeof fetch = fetch): Promise<boolean> {
  let changed = false;
  for (const [id, settings] of Object.entries(config.providers)) {
    const tokens = settings.oauth;
    if (!tokens?.refreshToken || tokens.expiresAt - REFRESH_MARGIN_MS > Date.now()) continue;
    const flow = oauthFlow(id);
    if (!flow?.refresh) continue;
    try {
      const next = await flow.refresh(tokens.refreshToken, fetchFn);
      if (!next) continue;
      settings.oauth = next;
      changed = true;
    } catch {
      // network or a rejected refresh: try again on the next turn
    }
  }
  if (changed) {
    await saveGlobalSetting('providers', config.providers).catch(() => {});
    setProviderSettings(config.providers);
  }
  return changed;
}

/** Removes a provider's saved key and subscription from the config (used by /logout). */
export async function forgetProvider(config: Config, id: string): Promise<boolean> {
  const settings = config.providers[id];
  if (!settings?.apiKey && !settings?.oauth) return false;
  const providers: Record<string, ProviderSettings> = { ...config.providers };
  delete providers[id];
  await saveGlobalSetting('providers', providers);
  config.providers = providers;
  setProviderSettings(providers);
  return true;
}

/** The subscription status line for /auth and /providers: "subscription until …" or nothing. */
export function oauthStatus(id: string): string | undefined {
  const t = providerSettings(id).oauth;
  if (!t) return undefined;
  const left = Math.max(0, t.expiresAt - Date.now());
  const h = Math.floor(left / 3_600_000);
  return `subscription${t.refreshToken ? '' : ' (no refresh token)'} · renews in ${h}h`;
}
