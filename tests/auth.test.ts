import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// /auth verifies the key against the models endpoint; answer by key instead of calling the network.
const seen: string[] = [];
vi.mock('../src/providers/net.js', async (orig) => ({
  ...(await orig<typeof import('../src/providers/net.js')>()),
  apiFetch: async (_url: string, init?: RequestInit) => {
    const key = String((init?.headers as Record<string, string>).authorization).replace('Bearer ', '');
    seen.push(key);
    if (key === 'sk-offline-key-0000') throw new Error('offline');
    return new Response('{}', { status: key.startsWith('sk-bad') ? 401 : 200 });
  },
  warmUp: () => {},
}));

const { GLOBAL_CONFIG, HOME_DIR, DEFAULT_CONFIG_FILE, DEFAULT_MCP_SERVERS, checkApiKey, ensureGlobalDefaults, loadConfig, maskKey, resolveApiKey, saveApiKey } = await import('../src/config.js');
const { runCommand } = await import('../src/commands.js');
const { hasSecret, maskSecretInput, redactSecret } = await import('../src/ui/format.js');

const config = () => JSON.parse(readFileSync(GLOBAL_CONFIG, 'utf8')) as Record<string, unknown>;

beforeEach(() => {
  rmSync(GLOBAL_CONFIG, { force: true });
  rmSync(join(HOME_DIR, 'auth.json'), { force: true });
  delete process.env.OPENCODE_API_KEY;
  seen.length = 0;
});

describe('API key in config.json', () => {
  it('is created empty on install, and there is no key until one is registered', async () => {
    await ensureGlobalDefaults();
    expect(config()).toMatchObject({ apiKey: '' });
    expect(DEFAULT_CONFIG_FILE.apiKey).toBe('');
    expect(await resolveApiKey()).toBeUndefined();
  });

  it('adds the entry to an existing config without touching other settings', async () => {
    mkdirSync(HOME_DIR, { recursive: true });
    writeFileSync(GLOBAL_CONFIG, JSON.stringify({ model: 'glm-5.3-flash', permissionMode: 'plan' }));
    await ensureGlobalDefaults();
    expect(config()).toEqual({ apiKey: '', model: 'glm-5.3-flash', permissionMode: 'plan', mcpServers: DEFAULT_MCP_SERVERS });
    if (process.platform !== 'win32') expect(statSync(GLOBAL_CONFIG).mode & 0o777).toBe(0o600); // Windows chmod keeps only the read-only bit
    // Present already (even empty): left alone.
    writeFileSync(GLOBAL_CONFIG, JSON.stringify({ apiKey: 'sk-kept', model: 'x', mcpServers: DEFAULT_MCP_SERVERS }));
    await ensureGlobalDefaults();
    expect(config()).toEqual({ apiKey: 'sk-kept', model: 'x', mcpServers: DEFAULT_MCP_SERVERS });
  });

  it('moves a key stored by an earlier `tessera-code auth` into config.json', async () => {
    mkdirSync(HOME_DIR, { recursive: true });
    writeFileSync(join(HOME_DIR, 'auth.json'), JSON.stringify({ key: 'sk-legacy-1234' }));
    writeFileSync(GLOBAL_CONFIG, JSON.stringify({ model: 'x' }));
    await ensureGlobalDefaults();
    expect(config()).toMatchObject({ apiKey: 'sk-legacy-1234', model: 'x' });
  });

  it('saves the key, keeps the other settings, and resolves it from there', async () => {
    await ensureGlobalDefaults();
    await saveApiKey('sk-saved-abcd');
    expect(config()).toMatchObject({ apiKey: 'sk-saved-abcd', model: DEFAULT_CONFIG_FILE.model, permissionMode: 'default' });
    if (process.platform !== 'win32') expect(statSync(GLOBAL_CONFIG).mode & 0o777).toBe(0o600); // Windows chmod keeps only the read-only bit
    expect(await resolveApiKey()).toEqual({ key: 'sk-saved-abcd', source: '~/.tessera-code/config.json' });
    process.env.OPENCODE_API_KEY = 'sk-env';
    expect((await resolveApiKey())?.source).toBe('env OPENCODE_API_KEY');
  });

  it('never takes a key from project settings, and keeps it out of the loaded config', async () => {
    await saveApiKey('sk-global-key1');
    const cwd = mkdtempSync(join(tmpdir(), 'tessera-auth-'));
    mkdirSync(join(cwd, '.tessera'));
    writeFileSync(join(cwd, '.tessera', 'settings.json'), JSON.stringify({ apiKey: 'sk-from-repo' }));
    const cfg = (await loadConfig(cwd, { trusted: true })) as unknown as Record<string, unknown>;
    expect(cfg.apiKey).toBeUndefined();
    expect((await resolveApiKey())?.key).toBe('sk-global-key1');
  });

  it('checks a key: 401 rejected, 200 ok, network failure unknown', async () => {
    const reply = (status: number) => (async () => new Response('', { status })) as unknown as typeof fetch;
    expect(await checkApiKey('k', reply(401))).toBe('rejected');
    expect(await checkApiKey('k', reply(200))).toBe('ok');
    expect(await checkApiKey('k', reply(502))).toBe('unknown');
    expect(await checkApiKey('k', (async () => Promise.reject(new Error('offline'))) as unknown as typeof fetch)).toBe('unknown');
  });
});

describe('/auth', () => {
  function fakeApp(key = '') {
    const state = { key, source: key ? 'somewhere' : '' };
    const app = {
      ctx: { cwd: mkdtempSync(join(tmpdir(), 'tessera-auth-cwd-')) }, // runCommand looks for custom commands here
      listSkills: async () => [],
      agent: {
        get apiKey() {
          return state.key;
        },
      },
      get apiKeySource() {
        return state.source;
      },
      setApiKey(k: string, source: string) {
        Object.assign(state, { key: k, source });
      },
    };
    return { app: app as never, state };
  }

  it('verifies, saves and switches to the key', async () => {
    const { app, state } = fakeApp();
    const r = await runCommand(app, '/auth sk-good-key-9876');
    expect(r.output).toMatch(/verified and saved/);
    expect(r.output).not.toContain('sk-good-key-9876');
    expect(config().apiKey).toBe('sk-good-key-9876');
    expect(state).toEqual({ key: 'sk-good-key-9876', source: '~/.tessera-code/config.json' });
  });

  it('does not save a rejected key', async () => {
    const { app, state } = fakeApp('sk-old-key-1111');
    await saveApiKey('sk-old-key-1111');
    const r = await runCommand(app, '/auth sk-bad-key-2222');
    expect(r.output).toMatch(/rejected/);
    expect(config().apiKey).toBe('sk-old-key-1111');
    expect(state.key).toBe('sk-old-key-1111');
  });

  it('saves a key it cannot verify, and says so', async () => {
    const { app } = fakeApp();
    expect((await runCommand(app, '/auth sk-offline-key-0000')).output).toMatch(/could not be verified/);
    expect(config().apiKey).toBe('sk-offline-key-0000');
  });

  it('a provider key leads straight into that provider’s own model picker', async () => {
    const picked: string[] = [];
    const base = fakeApp().app as unknown as Record<string, unknown>;
    const app2 = {
      ...base,
      config: { providers: {} as Record<string, { apiKey?: string }> },
      catalog: [
        { id: 'openai/gpt-test', name: 'gpt-test', format: 'chat', context: 100_000, output: 4_096, reasoning: false, images: false, provider: 'openai', cost: { input: 1, output: 2, cacheRead: 0.1 } },
        { id: 'anthropic/claude-test', name: 'claude-test', format: 'messages', context: 200_000, output: 8_192, reasoning: true, images: true, provider: 'anthropic', cost: { input: 3, output: 15, cacheRead: 0.3 } },
      ],
      agent: { ...(base.agent as Record<string, unknown>), model: { id: 'mimo-v2.6-flash' } },
      setModel: async (id: string) => void picked.push(id),
    };
    const r = await runCommand(app2 as never, '/auth openai sk-test-openai-123');
    expect(r.output).toContain('Saved the OpenAI key');
    expect((config().providers as Record<string, { apiKey?: string }> | undefined)?.openai?.apiKey).toBe('sk-test-openai-123');
    expect(r.choose?.title).toContain('OpenAI');
    expect(r.choose?.options.map((o) => o.label)).toEqual(['openai/gpt-test']); // only this provider's models
    const applied = await r.choose!.select(0);
    expect(picked).toEqual(['openai/gpt-test']);
    expect(applied.output).toContain('Model set to openai/gpt-test');
    expect(applied.output).not.toContain('sk-test-openai-123');
  });

  it('opens the provider list bare; picking OpenCode Go shows its masked status and the key line', async () => {
    const noKey = await runCommand(fakeApp().app, '/auth');
    expect(noKey.choose?.options[0]?.label).toBe('opencode-go'); // the default first, then the providers
    expect(noKey.choose?.options.some((o) => o.label === 'openai')).toBe(true);
    const status = await noKey.choose!.select(0);
    expect(status.output).toMatch(/No API key registered/);
    expect(status.input).toBe('/auth '); // the line comes back for the key (masked while typing)

    const withKey = await runCommand(fakeApp('sk-shown-key-5678').app, '/auth');
    const out = (await withKey.choose!.select(0)).output!;
    expect(out).toContain(maskKey('sk-shown-key-5678'));
    expect(out).not.toContain('sk-shown-key-5678');
    expect(seen).toEqual([]); // no network for a status query
  });
});

describe('typed keys on screen', () => {
  it('masks the key while typing, keeping the length, and redacts it in the transcript', () => {
    expect(maskSecretInput('/auth sk-abcdef123456')).toBe('/auth ' + '•'.repeat(15));
    expect(maskSecretInput('/auth sk-abcdef123456').length).toBe('/auth sk-abcdef123456'.length);
    expect(maskSecretInput('/model x')).toBe('/model x');
    expect(redactSecret('/auth sk-abcdef123456')).toBe('/auth sk-…3456');
    expect(hasSecret('/auth sk-x')).toBe(true);
    expect(hasSecret('/auth')).toBe(false);
    expect(hasSecret('tell me about /auth sk-x')).toBe(false);
  });
});
