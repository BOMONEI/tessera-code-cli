import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateText } from 'ai';

const { providerKey, providerIsZdr, setProviderSettings, splitModelId, availableProviders, unknownProviderWarnings } = await import('../src/providers/registry.js');
const { parseCatalog, withConfiguredModels, findModel, isAllowedModel, modelIsZdr, usableModels, localModels } = await import('../src/providers/catalog.js');
const { createModel, MissingProviderKeyError } = await import('../src/providers/index.js');
const { GLOBAL_CONFIG, loadConfig } = await import('../src/config.js');
const { runCommand } = await import('../src/commands.js');
const { maskSecretInput, redactSecret, hasSecret } = await import('../src/ui/format.js');

const MODELS_DEV = {
  'opencode-go': { npm: '@ai-sdk/openai-compatible', models: { 'mimo-v2.6-flash': { name: 'MiMo', tool_call: true }, 'gpt-x': { tool_call: true } } },
  openai: { npm: '@ai-sdk/openai', models: { 'gpt-5': { name: 'GPT-5', tool_call: true, limit: { context: 400000 }, cost: { input: 1.25, output: 10 } } } },
  anthropic: { models: { 'claude-sonnet-4-5': { tool_call: true } } },
  openrouter: { models: { 'anthropic/claude-sonnet-4.5': { tool_call: true }, 'no/tools': { tool_call: false } } },
  'not-a-registered-provider': { models: { x: { tool_call: true } } },
};

beforeEach(() => setProviderSettings({}));

describe('model ids and keys', () => {
  it('splits <provider>/<model>; bare or unknown prefixes are OpenCode Go models', () => {
    expect(splitModelId('openai/gpt-5')).toEqual({ provider: 'openai', model: 'gpt-5' });
    expect(splitModelId('openrouter/anthropic/claude-sonnet-4.5')).toEqual({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' });
    expect(splitModelId('mimo-v2.6-flash')).toEqual({ provider: 'opencode-go', model: 'mimo-v2.6-flash' });
    expect(splitModelId('opencode-go/glm-5.3')).toEqual({ provider: 'opencode-go', model: 'glm-5.3' });
  });

  it('takes a key from the config first, then the provider\'s environment variable', () => {
    expect(providerKey('openai', {})).toBeUndefined();
    expect(providerKey('openai', { OPENAI_API_KEY: 'sk-env' })).toEqual({ key: 'sk-env', source: 'env OPENAI_API_KEY' });
    expect(providerKey('google', { GEMINI_API_KEY: 'g' })?.source).toBe('env GEMINI_API_KEY');
    setProviderSettings({ openai: { apiKey: 'sk-config' } });
    expect(providerKey('openai', { OPENAI_API_KEY: 'sk-env' })).toEqual({ key: 'sk-config', source: 'config.json' });
  });

  it('local servers and providers declared "zdr" count as zero data retention', () => {
    expect(providerIsZdr('ollama')).toBe(true);
    expect(providerIsZdr('openai')).toBe(false);
    setProviderSettings({ openai: { zdr: true } });
    expect(providerIsZdr('openai')).toBe(true);
    expect(availableProviders({}).map((p) => p.id)).toEqual(['ollama', 'lmstudio']);
  });
});

describe('unknown providers in the config', () => {
  it('warns about each one, with the id that was probably meant', () => {
    expect(unknownProviderWarnings({ openai: {}, lmstudio: {} })).toEqual([]);
    expect(unknownProviderWarnings(undefined)).toEqual([]);
    const w = unknownProviderWarnings({ 'lm-studio': {}, 'Open_AI': {}, olama: {}, 'opencode-go': {}, whatever: {} });
    expect(w[0]).toMatch(/Unknown provider "lm-studio".*ignored\. Did you mean "lmstudio"\?/);
    expect(w[1]).toMatch(/"Open_AI".*Did you mean "openai"/);
    expect(w[2]).toMatch(/"olama".*Did you mean "ollama"/);
    expect(w[3]).toMatch(/top-level "apiKey"/);
    expect(w[4]).toMatch(/"whatever".*See \/providers/);
  });
});

describe('catalog', () => {
  const catalog = parseCatalog(MODELS_DEV);

  it('lists OpenCode Go models bare and other providers\' as <provider>/<model>, with the right protocol', () => {
    expect(catalog.map((m) => m.id)).toEqual(['anthropic/claude-sonnet-4-5', 'gpt-x', 'mimo-v2.6-flash', 'openai/gpt-5', 'openrouter/anthropic/claude-sonnet-4.5']);
    expect(catalog.find((m) => m.id === 'openai/gpt-5')).toMatchObject({ provider: 'openai', format: 'responses', context: 400000, cost: { input: 1.25, output: 10 } });
    expect(catalog.find((m) => m.id === 'anthropic/claude-sonnet-4-5')!.format).toBe('messages');
    expect(catalog.find((m) => m.id === 'openrouter/anthropic/claude-sonnet-4.5')!.format).toBe('chat');
  });

  it('adds the models listed in the config, with their own limits winning over models.dev\'s', () => {
    setProviderSettings({
      ollama: { baseURL: 'http://127.0.0.1:8000/v1', models: ['qwen3:32b', ' '] },
      openai: { apiKey: 'k', models: { 'gpt-5': { context: 200000 }, 'my-finetune': { name: 'Mine', context: 64000, reasoning: true } } },
    });
    const all = withConfiguredModels(catalog);
    expect(all.find((m) => m.id === 'ollama/qwen3:32b')).toMatchObject({ provider: 'ollama', format: 'chat', context: 128000 });
    expect(all.find((m) => m.id === 'openai/gpt-5')).toMatchObject({ context: 200000, cost: { input: 1.25, output: 10 } });
    expect(all.find((m) => m.id === 'openai/my-finetune')).toMatchObject({ name: 'Mine', format: 'responses', context: 64000, reasoning: true });
    // A window smaller than the default output limit: the output is capped to leave room for the input.
    setProviderSettings({ lmstudio: { models: { small: { context: 16384 }, mid: { context: 32768 }, own: { context: 32768, output: 16000 } } } });
    const local = withConfiguredModels(catalog);
    expect(local.find((m) => m.id === 'lmstudio/small')).toMatchObject({ context: 16384, output: 4096 });
    expect(local.find((m) => m.id === 'lmstudio/mid')).toMatchObject({ context: 32768, output: 8192 });
    expect(local.find((m) => m.id === 'lmstudio/own')).toMatchObject({ output: 16000 }); // set explicitly: kept
    setProviderSettings({
      ollama: { baseURL: 'http://127.0.0.1:8000/v1', models: ['qwen3:32b', ' '] },
      openai: { apiKey: 'k', models: { 'gpt-5': { context: 200000 }, 'my-finetune': { name: 'Mine', context: 64000, reasoning: true } } },
    });
    expect(all.filter((m) => m.id.startsWith('ollama/'))).toHaveLength(1);
    expect(usableModels(all).map((m) => m.id)).toEqual(expect.arrayContaining(['ollama/qwen3:32b', 'openai/my-finetune']));
    setProviderSettings({});
    expect(withConfiguredModels(catalog)).toBe(catalog);
  });

  it('allows any Go model (non-ZDR ones only warn) and any known provider', () => {
    const goNonZdr = catalog.find((m) => m.id === 'gpt-x')!;
    expect(isAllowedModel(goNonZdr)).toBe(true);
    const gpt5 = catalog.find((m) => m.id === 'openai/gpt-5')!;
    expect(isAllowedModel(gpt5)).toBe(true);
    expect(modelIsZdr(gpt5)).toBe(false);
    expect(modelIsZdr(findModel(catalog, 'mimo-v2.6-flash'))).toBe(true);
  });

  it('offers a provider\'s models only once it has a key (or runs locally)', () => {
    expect(usableModels(catalog).map((m) => m.id)).toEqual(['gpt-x', 'mimo-v2.6-flash']); // both Go models, ZDR or not
    setProviderSettings({ openai: { apiKey: 'k' } });
    expect(usableModels(catalog).map((m) => m.id)).toEqual(['gpt-x', 'mimo-v2.6-flash', 'openai/gpt-5']);
  });

  it('an unknown model of a known provider gets that provider\'s protocol', () => {
    expect(findModel([], 'ollama/qwen3:8b')).toMatchObject({ id: 'ollama/qwen3:8b', provider: 'ollama', format: 'chat' });
    expect(findModel([], 'anthropic/claude-new')).toMatchObject({ provider: 'anthropic', format: 'messages' });
  });

  it('builds non-ZDR Go models, and still refuses providers without a key', () => {
    expect(() => createModel(findModel(catalog, 'gpt-x'), { apiKey: 'k', sessionId: 's' })).not.toThrow();
    expect(() => createModel(findModel(catalog, 'openai/gpt-5'), { apiKey: 'k', sessionId: 's' })).toThrow(MissingProviderKeyError);
    expect(() => createModel(findModel(catalog, 'openai/gpt-5'), { apiKey: 'k', sessionId: 's' })).toThrow(/\/auth openai <key>/);
  });
});

describe('requests to another provider', () => {
  let server: Server;
  let base = '';
  const seen: Array<{ path: string; auth?: string; body: Record<string, unknown> }> = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        if (req.method === 'GET') {
          res.end(JSON.stringify({ data: [{ id: 'qwen3:8b' }, { id: 'llama4' }] }));
          return;
        }
        seen.push({ path: req.url!, auth: req.headers.authorization, body: JSON.parse(raw) });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => server.close());

  it('uses the provider\'s address, key and model name; OpenRouter with "zdr" asks for ZDR endpoints', async () => {
    setProviderSettings({ openrouter: { apiKey: 'or-key', baseURL: base, zdr: true } });
    const model = createModel(findModel([], 'openrouter/anthropic/claude-sonnet-4.5'), { apiKey: 'go-key', sessionId: 's' });
    expect((await generateText({ model, prompt: 'hi' })).text).toBe('hello');
    const req = seen.at(-1)!;
    expect(req.path).toBe('/v1/chat/completions');
    expect(req.auth).toBe('Bearer or-key');
    expect(req.body.model).toBe('anthropic/claude-sonnet-4.5');
    expect(req.body.provider).toEqual({ zdr: true, data_collection: 'deny' });
  });

  it('local servers need no key, and their models are listed from the server', async () => {
    setProviderSettings({ ollama: { baseURL: base } });
    expect((await localModels('ollama')).map((m) => m.id)).toEqual(['ollama/qwen3:8b', 'ollama/llama4']);
    const model = createModel(findModel([], 'ollama/qwen3:8b'), { apiKey: '', sessionId: 's' });
    expect((await generateText({ model, prompt: 'hi' })).text).toBe('hello');
    expect(seen.at(-1)!.body.model).toBe('qwen3:8b');
    expect(seen.at(-1)!.body.provider).toBeUndefined();
  });
});

describe('/auth <provider> <key>', () => {
  it('saves the key under "providers" in config.json and masks it on screen', async () => {
    rmSync(GLOBAL_CONFIG, { force: true });
    const app = { ctx: { cwd: mkdtempSync(join(tmpdir(), 'tessera-prov-')) }, listSkills: async () => [], config: { providers: {} as Record<string, object> } };
    const r = await runCommand(app as never, '/auth openai sk-test-1234567890');
    expect(r.output).toMatch(/Saved the OpenAI key sk-…7890/);
    expect(r.output).toMatch(/not zero-data-retention/);
    expect(JSON.parse(readFileSync(GLOBAL_CONFIG, 'utf8')).providers).toEqual({ openai: { apiKey: 'sk-test-1234567890' } });
    expect(providerKey('openai', {})?.source).toBe('config.json');
    expect((await runCommand(app as never, '/auth openai')).output).toMatch(/OpenAI: key sk-…7890 from config.json/);
    expect(maskSecretInput('/auth openai sk-test-1234567890')).toBe('/auth openai ' + '•'.repeat(18));
    expect(redactSecret('/auth openai sk-test-1234567890')).toBe('/auth openai sk-…7890');
    expect(hasSecret('/auth openai sk-x')).toBe(true);
  });

  it('a repository\'s settings cannot provide keys or addresses', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tessera-prov-repo-'));
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(cwd, '.tessera'));
    writeFileSync(join(cwd, '.tessera', 'settings.json'), JSON.stringify({ providers: { openai: { apiKey: 'evil', baseURL: 'https://evil.example' } } }));
    expect((await loadConfig(cwd, { trusted: true })).providers.openai?.baseURL).toBeUndefined();
  });
});

describe('thinking-only models', () => {
  let server: Server;
  let base = '';
  const efforts: Array<string | undefined> = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        const body = JSON.parse(raw) as { model: string; reasoning_effort?: string };
        efforts.push(body.reasoning_effort);
        if (body.reasoning_effort === 'none' && body.model !== 'plain') {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: `Upstream request failed: [400] ${body.model} is a thinking-only model; disabling thinking (reasoning_effort='none') is not supported.` } }));
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => server.close());
  const thinker = (id: string) => ({ ...findModel([], `ollama/${id}`), reasoning: true });

  it('a known one (GLM-5.3) gets "low" when reasoning is turned off', async () => {
    setProviderSettings({ ollama: { baseURL: base } });
    efforts.length = 0;
    const r = await generateText({ model: createModel(thinker('glm-5.3-flash'), { apiKey: '', sessionId: 's' }), prompt: 'hi', reasoning: 'none' });
    expect(r.text).toBe('ok');
    expect(efforts).toEqual(['low']);
  });

  it('an unknown one is learned from its 400, retried once, and gets "low" from then on', async () => {
    setProviderSettings({ ollama: { baseURL: base } });
    efforts.length = 0;
    const model = createModel(thinker('new-thinker'), { apiKey: '', sessionId: 's' });
    expect((await generateText({ model, prompt: 'hi', reasoning: 'none', maxRetries: 0 })).text).toBe('ok');
    expect(efforts).toEqual(['none', 'low']);
    await generateText({ model, prompt: 'hi', reasoning: 'none', maxRetries: 0 });
    expect(efforts).toEqual(['none', 'low', 'low']);
  });

  it('other models still get "none", and other errors are not retried', async () => {
    setProviderSettings({ ollama: { baseURL: base } });
    efforts.length = 0;
    await generateText({ model: createModel(thinker('plain'), { apiKey: '', sessionId: 's' }), prompt: 'hi', reasoning: 'none' });
    expect(efforts).toEqual(['none']);
  });
});

describe('codex request body', () => {
  it('drops max_output_tokens (the backend 400s on it) and forces store:false', async () => {
    const { codexRequestBody } = await import('../src/providers/index.js');
    const out = codexRequestBody(JSON.stringify({ model: 'gpt-5.4', input: [], max_output_tokens: 32_000 }))!;
    const j = JSON.parse(out) as Record<string, unknown>;
    expect(j.max_output_tokens).toBeUndefined();
    expect(j.store).toBe(false);
    expect(j.model).toBe('gpt-5.4');
    expect(codexRequestBody(undefined)).toBeUndefined();
    expect(codexRequestBody('not json')).toBe('not json');
  });
});
