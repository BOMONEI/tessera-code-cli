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
  packSecrets,
  pickSyncable,
  pushSettings,
  pullSettings,
  refreshAccount,
  secretsIn,
  unpackSecrets,
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
  it('sends only the listed keys — the secrets travel encrypted, never in the clear', () => {
    expect(pickSyncable(cfg())).toEqual({ model: 'm', thinking: true });
    for (const forbidden of ['providers', 'mcpServers', 'secrets', 'hooks', 'account'] as const) expect(SYNC_KEYS).not.toContain(forbidden);
    expect(secretsIn(cfg())).toBe(true);
    expect(secretsIn(cfg({ providers: {}, mcpServers: {} }))).toBe(false);
  });

  it('applies only the listed keys — plaintext providers, hooks and the account session stay refused', () => {
    const config = cfg();
    const changed = applySyncable(config, {
      model: 'm2',
      providers: { evil: { apiKey: 'x' } },
      mcpServers: { evil: { url: 'https://evil.example' } },
      hooks: { pre: [] },
      account: { accessToken: 'stolen' },
      unknownKey: 1,
    });
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

describe('the encrypted secrets channel', () => {
  const expected = { providers: { x: { apiKey: 'k' } }, mcpServers: { a: { url: 'http://m' } } };

  it('round-trips providers and mcp through a passphrase, with a fresh salt each push', () => {
    const config = cfg();
    const blob = packSecrets(config, 'correct horse battery');
    expect(blob.v).toBe(1);
    expect(blob.alg).toBe('aes-256-gcm');
    // The stored blob is ciphertext: neither the secrets, nor the passphrase, nor any key material sits in it.
    const stored = JSON.stringify(blob);
    expect(stored).not.toContain('"apiKey"');
    expect(stored).not.toContain('http://m');
    expect(stored).not.toContain('correct horse battery');
    expect(unpackSecrets(blob, 'correct horse battery')).toEqual(expected);
    expect(JSON.stringify(packSecrets(config, 'correct horse battery'))).not.toBe(stored); // fresh salt/iv
    // The whitelist that travels in the clear never grows a secret.
    expect(pickSyncable(config)).toEqual({ model: 'm', thinking: true });
  });

  it('refuses a wrong passphrase and a tampered blob alike', () => {
    const blob = packSecrets(cfg(), 'right passphrase');
    expect(() => unpackSecrets(blob, 'wrong passphrase')).toThrow(/passphrase is wrong or the encrypted data was damaged/);
    const data = Buffer.from(blob.ct, 'base64');
    const last = data.length - 1;
    data[last] = (data[last] ?? 0) ^ 0xff; // flip a tag byte
    expect(() => unpackSecrets({ ...blob, ct: data.toString('base64') }, 'right passphrase')).toThrow(/passphrase is wrong or the encrypted data was damaged/);
    expect(() => unpackSecrets({ v: 2, alg: 'aes-256-gcm', salt: 'a', iv: 'b', ct: 'c' }, 'p')).toThrow(/form this version/);
    expect(() => unpackSecrets(null, 'p')).toThrow(/form this version/);
  });

  it('attaches the blob to a push only when given one, and never the plaintext', async () => {
    const bodies: string[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const acc = { server: 'http://s', accessToken: 'tok' };
    await pushSettings(acc, cfg(), {}, fetchFn);
    expect(JSON.parse(bodies[0]!)).toEqual({ settings: { model: 'm', thinking: true } });
    await pushSettings(acc, cfg(), { secrets: packSecrets(cfg(), 'pw-123456') }, fetchFn);
    const settings = JSON.parse(bodies[1]!).settings as Record<string, unknown>;
    expect(settings.secrets).toMatchObject({ v: 1, alg: 'aes-256-gcm' });
    expect(settings.providers).toBeUndefined();
    expect(settings.mcpServers).toBeUndefined();
    expect(bodies[1]).not.toContain('"apiKey"');
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
    await pushSettings(acc, cfg(), {}, fetchFn);
    expect(calls[0]!.url).toBe('http://s/api/settings');
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.auth).toBe('Bearer tok');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ settings: { model: 'm', thinking: true } });
    expect(await pullSettings(acc, fetchFn)).toEqual({ model: 'm3' });
  });

  it('says to sign in again when the session was rejected', async () => {
    const fetchFn = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    await expect(pushSettings({ server: 'http://s', accessToken: 'x' }, cfg(), {}, fetchFn)).rejects.toThrow(/login again/);
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
