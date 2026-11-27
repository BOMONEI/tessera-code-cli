import { copyFile } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { join } from 'node:path';
import { HOME_DIR, saveGlobalSetting, type AccountState, type Config, type McpServerConfig } from './config.js';
import { loginFlow, type OAuthFlow } from './oauth.js';

/** The Google OAuth client of the AI Chat backend — a public identifier; its secret stays on the server. */
export const ACCOUNT_GOOGLE_CLIENT_ID = '367063404195-1hptjtv27p62r39k0pcv9d2i832mlnvi.apps.googleusercontent.com';
/** This sign-in's fixed loopback port: register http://127.0.0.1:38471/callback as a Google redirect URI once. */
export const ACCOUNT_PORT = 38471;

/**
 * The config keys that travel with the account in the clear: preferences and behavior only. The secrets —
 * `providers` (API keys and subscription tokens) and `mcpServers` (headers, env tokens) — travel in the `secrets`
 * field instead, encrypted with a passphrase this machine knows and never sent (packSecrets). `hooks` (machine
 * commands) and `account` (the sync session's own tokens) never leave the machine at all. List, not a denylist:
 * a new config key is local until it is added here.
 */
export const SYNC_KEYS = [
  'model',
  'maxSteps',
  'contextLimit',
  'sessionRetentionDays',
  'allow',
  'thinking',
  'thinkingLevel',
  'thinkingAuto',
  'showThinking',
  'fullscreen',
  'permissionMode',
  'notifyAfterSeconds',
  'updateCheck',
  'subagents',
  'multiAgent',
  'fallback',
] as const;

/** The settings field carrying the encrypted `providers` and `mcpServers` — never the plaintext themselves. */
export const SECRETS = 'secrets';

/** One stored encrypted payload: AES-256-GCM, the key derived from the passphrase with scrypt. */
export interface SecretsBlob {
  v: 1;
  alg: 'aes-256-gcm';
  salt: string;
  iv: string;
  ct: string;
}

/** Whether this config holds secrets worth encrypting into a push. */
export const secretsIn = (config: Config): boolean =>
  Boolean((config.providers && Object.keys(config.providers).length) || (config.mcpServers && Object.keys(config.mcpServers).length));

export const normalizeServer = (server: string) => server.trim().replace(/\/+$/, '');
const serverBase = (a: AccountState) => normalizeServer(a.server);
const ACCESS_TTL_MS = 3_600_000; // the backend issues access tokens for 60 minutes
const REFRESH_MARGIN_MS = 10 * 60_000;

const agoShort = (t: number): string => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
};

/**
 * Signs in with the AI Chat account (Google): the browser lands on this machine's loopback redirect with the
 * code, and the backend — holding the Google client secret — swaps it for JWTs. `onAuthorize` drives the
 * callback in tests instead of opening the browser.
 */
export async function loginAccount(
  server: string,
  opts: { clientId?: string; fetch?: typeof fetch; onAuthorize?: (url: string) => void | Promise<void>; timeoutMs?: number } = {},
): Promise<AccountState> {
  const origin = normalizeServer(server);
  const clientId = opts.clientId ?? ACCOUNT_GOOGLE_CLIENT_ID;
  let user: AccountState['user'];
  const flow: OAuthFlow = {
    id: 'account',
    name: 'AI Chat account',
    port: ACCOUNT_PORT,
    requireState: true,
    authorizeUrl: (redirect, _challenge, state) =>
      `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        response_type: 'code',
        scope: 'openid email profile',
        state,
      })}`,
    exchange: async (code, _verifier, redirect, _state, fetchFn) => {
      const r = await fetchFn(`${origin}/api/auth/google-code`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, redirect_uri: redirect }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) throw new Error(`${origin} refused the sign-in code (HTTP ${r.status}).`);
      const j = (await r.json()) as { access_token?: string; refresh_token?: string; user?: AccountState['user'] };
      if (!j.access_token) throw new Error(`${origin} returned no access token.`);
      user = j.user;
      return { oauth: { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + ACCESS_TTL_MS } };
    },
  };
  const r = await loginFlow(flow, { fetch: opts.fetch, onAuthorize: opts.onAuthorize, timeoutMs: opts.timeoutMs });
  if (!r.oauth?.accessToken) throw new Error('The sign-in returned no access token.');
  return { server: origin, clientId, accessToken: r.oauth.accessToken, refreshToken: r.oauth.refreshToken, expiresAt: r.oauth.expiresAt, user };
}

/** True when the access token is within ten minutes of expiring and can be renewed. */
export const accountRefreshDue = (a: AccountState): boolean =>
  Boolean(a.refreshToken && a.expiresAt && a.expiresAt - REFRESH_MARGIN_MS <= Date.now());

/** Renews both tokens (the backend reissues them); undefined when it fails — the caller keeps the old one. */
export async function refreshAccount(account: AccountState, fetchFn: typeof fetch = fetch): Promise<AccountState | undefined> {
  if (!account.refreshToken) return undefined;
  try {
    const r = await fetchFn(`${serverBase(account)}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: account.refreshToken }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return undefined;
    const j = (await r.json()) as { access_token?: string; refresh_token?: string; user?: AccountState['user'] };
    if (!j.access_token) return undefined;
    return {
      ...account,
      accessToken: j.access_token,
      refreshToken: j.refresh_token ?? account.refreshToken,
      expiresAt: Date.now() + ACCESS_TTL_MS,
      user: j.user ?? account.user,
    };
  } catch {
    return undefined;
  }
}

/** This machine's whitelisted settings, ready to send. */
export function pickSyncable(config: Config): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const src = config as unknown as Record<string, unknown>;
  for (const k of SYNC_KEYS) if (k in src) out[k] = src[k];
  return out;
}

/**
 * Applies the server's settings over this config — whitelist only, so a hostile or stale payload can never
 * touch providers, mcp, hooks or anything else — and returns the keys that actually changed.
 */
export function applySyncable(config: Config, incoming: Record<string, unknown> | undefined): string[] {
  const changed: string[] = [];
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return changed;
  const target = config as unknown as Record<string, unknown>;
  for (const k of SYNC_KEYS) {
    if (!(k in incoming)) continue;
    const value = incoming[k];
    if (JSON.stringify(target[k] ?? null) === JSON.stringify(value ?? null)) continue;
    target[k] = value;
    changed.push(k);
  }
  return changed;
}

/** Copies config.json aside before a pull overwrites keys; the path is shown to the user (best effort). */
export async function backupConfig(): Promise<string | undefined> {
  const file = join(HOME_DIR, 'config.json');
  const bak = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    await copyFile(file, bak);
    return bak;
  } catch {
    return undefined; // no config yet — nothing to lose
  }
}

const SECRET_SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

/**
 * Encrypts the secret part of the config — providers with their keys and subscription tokens, mcpServers with
 * their headers and env — into a blob for the server. The passphrase never leaves this machine: only its scrypt
 * output (a fresh random salt per push) becomes the AES-256-GCM key, so what the server stores is ciphertext it
 * cannot read.
 */
export function packSecrets(config: Config, passphrase: string): SecretsBlob {
  const plaintext = JSON.stringify({ providers: config.providers ?? {}, mcpServers: config.mcpServers ?? {} });
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32, SECRET_SCRYPT);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, alg: 'aes-256-gcm', salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') };
}

/** The inverse; a wrong passphrase or a damaged blob fails the GCM tag check and throws — nothing half-applied. */
export function unpackSecrets(blob: unknown, passphrase: string): { providers?: Config['providers']; mcpServers?: Config['mcpServers'] } {
  const b = blob as Partial<SecretsBlob> | null;
  if (!b || typeof b !== 'object' || b.v !== 1 || b.alg !== 'aes-256-gcm' || typeof b.salt !== 'string' || typeof b.iv !== 'string' || typeof b.ct !== 'string') {
    throw new Error('The encrypted payload is not in a form this version understands.');
  }
  try {
    const key = scryptSync(passphrase, Buffer.from(b.salt, 'base64'), 32, SECRET_SCRYPT);
    const data = Buffer.from(b.ct, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(b.iv, 'base64'));
    decipher.setAuthTag(data.subarray(data.length - 16));
    const pt = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(pt) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('bad payload');
    return parsed as { providers?: Config['providers']; mcpServers?: Config['mcpServers'] };
  } catch {
    throw new Error('The passphrase is wrong or the encrypted data was damaged.');
  }
}

const unauthorized = (r: Response, what: string): never => {
  if (r.status === 401) throw new Error(`${what} failed: signed out — run /account login again.`);
  throw new Error(`${what} failed (HTTP ${r.status}).`);
};

/** Sends the settings to the server (replaces its stored settings). `secrets` is the encrypted providers/mcp blob. */
export async function pushSettings(account: AccountState, config: Config, opts: { secrets?: unknown } = {}, fetchFn: typeof fetch = fetch): Promise<void> {
  const r = await fetchFn(`${serverBase(account)}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${account.accessToken}` },
    body: JSON.stringify({ settings: { ...pickSyncable(config), ...(opts.secrets ? { secrets: opts.secrets } : {}) } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) unauthorized(r, 'Push');
}

/** Reads the server's settings (empty object when none were ever pushed). */
export async function pullSettings(account: AccountState, fetchFn: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const r = await fetchFn(`${serverBase(account)}/api/settings`, {
    headers: { authorization: `Bearer ${account.accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) unauthorized(r, 'Pull');
  const j = (await r.json()) as { settings?: Record<string, unknown> };
  return j.settings ?? {};
}

/** Writes the account into config.json (the file is owner-only) and keeps the in-memory copy in step. */
export async function saveAccount(config: Config, account: AccountState): Promise<void> {
  await saveGlobalSetting('account', account);
  config.account = account;
}

/** Forgets the tokens on this machine; the server-side settings stay. Returns whether there was anything. */
export async function forgetAccount(config: Config): Promise<boolean> {
  if (!config.account?.accessToken && !config.account?.refreshToken) return false;
  await saveGlobalSetting('account', undefined);
  delete config.account;
  return true;
}

/** The status line for /account, or undefined when nobody is signed in. */
export function accountStatus(a?: AccountState): string | undefined {
  if (!a?.accessToken) return undefined;
  const left = a.expiresAt ? Math.max(0, a.expiresAt - Date.now()) : 0;
  const h = Math.floor(left / 3_600_000);
  const synced = a.syncedAt ? ` · settings pushed/pulled ${agoShort(a.syncedAt)}` : '';
  return `${a.user?.email ?? a.user?.name ?? 'signed in'} · ${a.server} · session renews in ${h}h${synced}`;
}
