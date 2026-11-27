import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import {
  ACCOUNT_GOOGLE_CLIENT_ID,
  ACCOUNT_PORT,
  SYNC_KEYS,
  accountRefreshDue,
  accountStatus,
  applySyncable,
  loginAccount,
  normalizeServer,
  pickSyncable,
  pushSettings,
  pullSettings,
  refreshAccount,
} from '../src/account.js';

const cfg = (over: Record<string, unknown> = {}) =>
  ({
    model: 'm',
    thinking: true,
    providers: { x: { apiKey: 'k' } },
    mcpServers: { a: { url: 'http://m' } },
    hooks: { pre: [] },
    account: { server: 's', accessToken: 't' },
    ...over,
  }) as unknown as Config;

describe('loginAccount', () => {
  it('opens Google with the loopback redirect and swaps the code at the backend', async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), body: String(init?.body) });
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', user: { id: 'u1', email: 'me@example.com' } }), { status: 200 });
    }) as unknown as typeof fetch;
    const account = await loginAccount('http://127.0.0.1:9999/', {
      fetch: fetchFn,
      onAuthorize: async (url) => {
        const u = new URL(url);
        expect(u.hostname).toBe('accounts.google.com');
        expect(u.searchParams.get('client_id')).toBe(ACCOUNT_GOOGLE_CLIENT_ID);
        const redirect = u.searchParams.get('redirect_uri')!;
        expect(redirect).toBe(`http://127.0.0.1:${ACCOUNT_PORT}/callback`); // the registered URI
        await fetch(`${redirect}?code=THE-CODE&state=${u.searchParams.get('state')!}`);
      },
      timeoutMs: 5_000,
    });
    expect(account.server).toBe('http://127.0.0.1:9999'); // trailing slash stripped
    expect(account.accessToken).toBe('at');
    expect(account.refreshToken).toBe('rt');
    expect(account.user?.email).toBe('me@example.com');
    expect(seen[0]?.url).toBe('http://127.0.0.1:9999/api/auth/google-code');
    expect(JSON.parse(seen[0]!.body)).toEqual({ code: 'THE-CODE', redirect_uri: `http://127.0.0.1:${ACCOUNT_PORT}/callback` });
  });

  it('refuses a loopback hit that does not echo this session\u2019s state', async () => {
    const fetchFn = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    await expect(
      loginAccount('http://127.0.0.1:9999', {
        fetch: fetchFn,
        onAuthorize: async (url) => {
          const redirect = new URL(url).searchParams.get('redirect_uri')!;
          await fetch(`${redirect}?code=X`); // no state at all
        },
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/state/);
  });
});

describe('session renewal', () => {
  it('renews both tokens and keeps the server and user', async () => {
    const fetchFn = (async (url: string) => {
      expect(String(url)).toBe('http://s/api/auth/refresh');
      return new Response(JSON.stringify({ access_token: 'at2', refresh_token: 'rt2' }), { status: 200 });
    }) as unknown as typeof fetch;
    const next = await refreshAccount({ server: 'http://s/', accessToken: 'at', refreshToken: 'rt', expiresAt: 0, user: { email: 'e' } }, fetchFn);
    expect(next?.accessToken).toBe('at2');
    expect(next?.refreshToken).toBe('rt2');
    expect(next?.server).toBe('http://s/');
    expect(next?.user?.email).toBe('e');
  });

  it('gives up quietly when the renewal fails', async () => {
    const fetchFn = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    expect(await refreshAccount({ server: 'http://s', refreshToken: 'rt' }, fetchFn)).toBeUndefined();
  });

  it('is due ten minutes before expiry, and never without a refresh token', () => {
    expect(accountRefreshDue({ server: 's', refreshToken: 'r', expiresAt: Date.now() + 5 * 60_000 })).toBe(true);
    expect(accountRefreshDue({ server: 's', refreshToken: 'r', expiresAt: Date.now() + 60 * 60_000 })).toBe(false);
    expect(accountRefreshDue({ server: 's', expiresAt: Date.now() })).toBe(false);
  });
});

describe('the settings whitelist', () => {
  it('sends only the listed keys', () => {
    expect(pickSyncable(cfg())).toEqual({ model: 'm', thinking: true });
    for (const forbidden of ['providers', 'mcpServers', 'hooks', 'account'] as const) expect(SYNC_KEYS).not.toContain(forbidden);
  });

  it('applies only the listed keys, even when the payload carries more', () => {
    const config = cfg();
    const changed = applySyncable(config, { model: 'm2', providers: { evil: { apiKey: 'x' } }, account: { accessToken: 'stolen' }, unknownKey: 1 });
    expect(changed).toEqual(['model']);
    expect(config.model).toBe('m2');
    expect((config as unknown as { providers: Record<string, { apiKey: string }> }).providers.x!.apiKey).toBe('k'); // untouched
    expect((config as unknown as { account: { accessToken: string } }).account.accessToken).toBe('t'); // untouched
  });

  it('leaves equal values alone and ignores non-objects', () => {
    const config = cfg();
    expect(applySyncable(config, { model: 'm' })).toEqual([]);
    expect(applySyncable(config, undefined)).toEqual([]);
    expect(applySyncable(config, [] as never)).toEqual([]);
    expect(config.model).toBe('m');
  });
});

describe('push and pull', () => {
  const acc = { server: 'http://s/', accessToken: 'tok' };

  it('PUTs the whitelist with the session and reads settings back', async () => {
    const calls: Array<{ url: string; method?: string; auth?: string; body?: string }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, auth: (init?.headers as Record<string, string>).authorization, body: String(init?.body) });
      return new Response(JSON.stringify({ settings: { model: 'm3' } }), { status: 200 });
    }) as unknown as typeof fetch;
    await pushSettings(acc, cfg(), fetchFn);
    expect(calls[0]!.url).toBe('http://s/api/settings');
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.auth).toBe('Bearer tok');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ settings: { model: 'm', thinking: true } });
    expect(await pullSettings(acc, fetchFn)).toEqual({ model: 'm3' });
  });

  it('says to sign in again when the session was rejected', async () => {
    const fetchFn = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    await expect(pushSettings({ server: 'http://s', accessToken: 'x' }, cfg(), fetchFn)).rejects.toThrow(/login again/);
    await expect(pullSettings({ server: 'http://s', accessToken: 'x' }, fetchFn)).rejects.toThrow(/login again/);
  });
});

describe('status', () => {
  it('is undefined without a session and names the account with one', () => {
    expect(accountStatus(undefined)).toBeUndefined();
    expect(accountStatus({ server: 'http://s' })).toBeUndefined();
    const line = accountStatus({ server: 'http://s', accessToken: 'at', user: { email: 'me@x.y' } });
    expect(line).toContain('me@x.y');
    expect(line).toContain('http://s');
  });

  it('normalizes the server URL', () => {
    expect(normalizeServer('  http://x///  ')).toBe('http://x');
  });
});
