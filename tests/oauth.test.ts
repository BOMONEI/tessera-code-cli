import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { anthropicFlow, fetchCodexModels, forgetProvider, loginFlow, openaiFlow, pkceChallenge, pkceVerifier, refreshDueProviders, xaiFlow } from '../src/oauth.js';

describe('pkce', () => {
  it('produces a url-safe verifier and its S256 challenge', () => {
    const v = pkceVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    const c = pkceChallenge(v);
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(c).toHaveLength(43); // sha256 → 32 bytes → base64url without padding
    expect(pkceChallenge(v)).toBe(c);
  });
});

describe('loginFlow', () => {
  it('serves the loopback callback and hands the code to the exchange', async () => {
    const seen: Array<{ code: string; verifier: string; redirect: string }> = [];
    const flow = {
      id: 'fake',
      name: 'Fake',
      authorizeUrl: (redirect: string) => `https://example.test/authorize?redirect_uri=${encodeURIComponent(redirect)}`,
      exchange: async (code: string, verifier: string, redirect: string) => {
        seen.push({ code, verifier, redirect });
        return { oauth: { accessToken: 'tok', expiresAt: Date.now() + 1000 } };
      },
    };
    const result = await loginFlow(flow as never, {
      onAuthorize: async (url) => {
        const redirect = new URL(url).searchParams.get('redirect_uri')!;
        await fetch(`${redirect}?code=THE-CODE&state=x`);
      },
      timeoutMs: 5_000,
    });
    expect(result.oauth?.accessToken).toBe('tok');
    expect(seen[0]!.code).toBe('THE-CODE');
    expect(seen[0]!.redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(seen[0]!.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('fails cleanly when the callback never arrives', async () => {
    const flow = { id: 'fake', name: 'Fake', authorizeUrl: () => 'https://example.test/a', exchange: async () => ({}) };
    await expect(
      loginFlow(flow as never, {
        onAuthorize: () => {}, // nobody completes the sign-in
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/timed out/);
  });
});

describe('anthropic tokens', () => {
  it('exchanges over JSON and stores the rotated refresh token', async () => {
    const ctypes: string[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      ctypes.push(String((init?.headers as Record<string, string>)['content-type']));
      return new Response(JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-NEW', expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await anthropicFlow.exchange('c', 'v', 'http://127.0.0.1:1/callback', 's', fetchFn);
    expect(r.oauth?.accessToken).toBe('at-1');
    expect(r.oauth?.refreshToken).toBe('rt-NEW'); // rotation is persisted
    expect(ctypes[0]).toContain('application/json');
  });

  it('falls back to a form body when JSON is rejected', async () => {
    let n = 0;
    const fetchFn = (async () => {
      n++;
      return n === 1 ? new Response('unsupported media type', { status: 415 }) : new Response(JSON.stringify({ access_token: 'at-2', expires_in: 60 }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await anthropicFlow.exchange('c', 'v', 'r', 's', fetchFn);
    expect(r.oauth?.accessToken).toBe('at-2');
    expect(n).toBe(2);
  });

  it('keeps the old refresh token when a refresh does not rotate it', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ access_token: 'at-3', expires_in: 60 }), { status: 200 })) as unknown as typeof fetch;
    const r = await anthropicFlow.refresh!('rt-OLD', fetchFn);
    expect(r?.accessToken).toBe('at-3');
    expect(r?.refreshToken).toBe('rt-OLD');
  });
});

describe('refreshDueProviders', () => {
  it('renews an expiring token, persists it, and leaves a fresh one alone', async () => {
    const config = { providers: { anthropic: { oauth: { accessToken: 'old', refreshToken: 'rt', expiresAt: Date.now() + 60_000 } } } } as unknown as Config;
    const fetchFn = (async () => new Response(JSON.stringify({ access_token: 'new', refresh_token: 'rt2', expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;
    expect(await refreshDueProviders(config, fetchFn)).toBe(true);
    expect(config.providers.anthropic!.oauth!.accessToken).toBe('new');
    expect(config.providers.anthropic!.oauth!.refreshToken).toBe('rt2');

    const fresh = { providers: { anthropic: { oauth: { accessToken: 'x', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000 } } } } as unknown as Config;
    expect(await refreshDueProviders(fresh, fetchFn)).toBe(false);
    expect(fresh.providers.anthropic!.oauth!.accessToken).toBe('x');
  });

  it('keeps fields a refresh response omits (OpenAI returns no account id)', async () => {
    const config = {
      providers: { openai: { oauth: { accessToken: 'old', refreshToken: 'rt', expiresAt: Date.now() + 60_000, accountId: 'acc-1', scope: 'openid' } } },
    } as unknown as Config;
    const fetchFn = (async () => new Response(JSON.stringify({ access_token: 'new', refresh_token: 'rt2', expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;
    expect(await refreshDueProviders(config, fetchFn)).toBe(true);
    const t = config.providers.openai!.oauth!;
    expect(t.accessToken).toBe('new');
    expect(t.refreshToken).toBe('rt2');
    expect(t.accountId).toBe('acc-1'); // carried over, not wiped
    expect(t.scope).toBe('openid');
  });
});

describe('forgetProvider', () => {
  it('removes the saved credentials and reports whether there were any', async () => {
    const config = { providers: { openai: { apiKey: 'k' } } } as unknown as Config;
    expect(await forgetProvider(config, 'openai')).toBe(true);
    expect(config.providers.openai).toBeUndefined();
    expect(await forgetProvider(config, 'openai')).toBe(false);
  });
});

describe('xAI tokens', () => {
  it('exchanges over a form body and stores the tokens', async () => {
    const ctypes: string[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      ctypes.push(String((init?.headers as Record<string, string>)['content-type']));
      expect(String(init?.body)).toContain('grant_type=authorization_code'); // form, not JSON
      return new Response(JSON.stringify({ access_token: 'xat', refresh_token: 'xrt', expires_in: 7200 }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await xaiFlow.exchange('c', 'v', 'http://127.0.0.1:56121/callback', 's', fetchFn);
    expect(r.oauth?.accessToken).toBe('xat');
    expect(r.oauth?.refreshToken).toBe('xrt');
    expect(ctypes[0]).toContain('application/x-www-form-urlencoded');
    expect(xaiFlow.port).toBe(56121); // the only port xAI has registered
  });

  it('refreshes with a form body and keeps a non-rotated refresh token', async () => {
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      expect(String(init?.body)).toContain('grant_type=refresh_token');
      return new Response(JSON.stringify({ access_token: 'xat2', expires_in: 7200 }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await xaiFlow.refresh!('xrt-OLD', fetchFn);
    expect(r?.accessToken).toBe('xat2');
    expect(r?.refreshToken).toBe('xrt-OLD');
  });
});

describe('OpenAI ChatGPT tokens', () => {
  it('uses the registered port and path, exchanges over JSON, and keeps the account id', async () => {
    expect(openaiFlow.port).toBe(1455);
    expect(openaiFlow.callbackPath).toBe('/auth/callback');
    const ctypes: string[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      ctypes.push(String((init?.headers as Record<string, string>)['content-type']));
      return new Response(JSON.stringify({ access_token: 'oat', refresh_token: 'ort', expires_in: 3600, account_id: 'acc-1' }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await openaiFlow.exchange('c', 'v', 'http://127.0.0.1:1455/auth/callback', 's', fetchFn);
    expect(r.oauth?.accessToken).toBe('oat');
    expect(r.oauth?.refreshToken).toBe('ort');
    expect(r.oauth?.accountId).toBe('acc-1');
    expect(ctypes[0]).toContain('application/json');
  });

  it('refreshes over JSON with single-use rotation', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ access_token: 'oat2', refresh_token: 'ort-NEW' }), { status: 200 })) as unknown as typeof fetch;
    const r = await openaiFlow.refresh!('ort-OLD', fetchFn);
    expect(r?.accessToken).toBe('oat2');
    expect(r?.refreshToken).toBe('ort-NEW');
  });
});

describe('OpenAI ChatGPT account id and models', () => {
  it('reads chatgpt-account-id from the id_token when the body does not carry it', async () => {
    const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth.chatgpt_account_id': 'acc-jwt' })).toString('base64url');
    const fetchFn = (async () =>
      new Response(JSON.stringify({ access_token: 'oat', refresh_token: 'ort', id_token: `h.${payload}.s` }), { status: 200 })) as unknown as typeof fetch;
    const r = await openaiFlow.exchange('c', 'v', 'http://127.0.0.1:1455/auth/callback', 's', fetchFn);
    expect(r.oauth?.accountId).toBe('acc-jwt');
  });

  it('falls back to a claim inside the access token when neither body nor id_token carries one', async () => {
    const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth.chatgpt_account_id': 'acc-at' })).toString('base64url');
    const fetchFn = (async () => new Response(JSON.stringify({ access_token: `h.${payload}.s`, refresh_token: 'ort' }), { status: 200 })) as unknown as typeof fetch;
    const r = await openaiFlow.exchange('c', 'v', 'http://127.0.0.1:1455/auth/callback', 's', fetchFn);
    expect(r.oauth?.accountId).toBe('acc-at');
  });

  it('lists the plan\'s model slugs, skipping hidden ones and duplicates', async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          models: [
            { slug: 'gpt-5.4', visibility: 'visible' },
            { slug: 'gpt-5.4-mini', visibility: 'visible' },
            { slug: 'codex-auto-review', visibility: 'hidden' },
            { slug: 'codex-something', visibility: 'visible' },
            { slug: 'gpt-internal', visibility: 'hide' },
            { slug: 'gpt-5.4', visibility: 'visible' },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const slugs = await fetchCodexModels({ accessToken: 't', expiresAt: 0 }, fetchFn);
    expect(slugs).toEqual(['gpt-5.4', 'gpt-5.4-mini']); // hidden/hide and internal codex-* are left out
  });

  it('returns undefined when the models endpoint fails', async () => {
    const fetchFn = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
    expect(await fetchCodexModels({ accessToken: 't', expiresAt: 0 }, fetchFn)).toBeUndefined();
  });
});
