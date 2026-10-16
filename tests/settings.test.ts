import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider';
import type { ModelInfo } from '../src/providers/catalog.js';

const calls: LanguageModelV4CallOptions[] = [];
vi.mock('../src/providers/index.js', async (orig) => ({
  ...(await orig<typeof import('../src/providers/index.js')>()),
  createModel: (): LanguageModelV4 =>
    ({
      specificationVersion: 'v4',
      provider: 'mock',
      modelId: 'mock',
      supportedUrls: {},
      async doGenerate() {
        throw new Error('unused');
      },
      async doStream(options: LanguageModelV4CallOptions) {
        calls.push(options);
        const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
        const parts = [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'ok' },
          { type: 'text-end', id: 't' },
          { type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' } },
        ];
        return { stream: new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(p)), c.close()) }) };
      },
    }) as unknown as LanguageModelV4,
}));
vi.mock('../src/cost/ledger.js', () => ({ recordSpend: async () => {} }));

const { Agent } = await import('../src/agent/agent.js');
const { loadConfig, parsePermissionMode, ensureGlobalDefaults, GLOBAL_CONFIG, GLOBAL_INSTRUCTIONS, DEFAULT_CONFIG_FILE, projectTrust } = await import('../src/config.js');

const model: ModelInfo = { id: 'mock', name: 'mock', format: 'chat', context: 100_000, output: 1000, reasoning: true, cost: { input: 0, output: 0, cacheRead: 0 } };

async function reasoningSent(opts: { thinking: boolean; thinkingLevel?: 'low' | 'medium' | 'high' }) {
  calls.length = 0;
  const a = new Agent({ model, apiKey: 'k', sessionId: 's', system: '', tools: {}, maxSteps: 1, contextLimit: 50_000, ...opts });
  for await (const _ of a.run('hi')) void _;
  return calls[0]?.reasoning;
}

describe('thinking level', () => {
  it('sends the level explicitly instead of the provider default', async () => {
    expect(await reasoningSent({ thinking: true })).toBe('medium');
    expect(await reasoningSent({ thinking: true, thinkingLevel: 'high' })).toBe('high');
    expect(await reasoningSent({ thinking: false, thinkingLevel: 'high' })).toBe('none');
  });
});

describe('global config file', () => {
  it('is created once with model, thinking and permission mode', async () => {
    rmSync(GLOBAL_CONFIG, { force: true });
    rmSync(GLOBAL_INSTRUCTIONS, { force: true });
    // The default rules are built into the system prompt; no TESSERA.md is created for them.
    expect(await ensureGlobalDefaults()).toEqual([GLOBAL_CONFIG]);
    expect(existsSync(GLOBAL_INSTRUCTIONS)).toBe(false);
    expect(JSON.parse(readFileSync(GLOBAL_CONFIG, 'utf8'))).toEqual(DEFAULT_CONFIG_FILE);
    expect(DEFAULT_CONFIG_FILE).toMatchObject({ thinkingLevel: 'medium', permissionMode: 'default' });
    expect(statSync(GLOBAL_CONFIG).mode & 0o777).toBe(0o600);
    // An existing file (possibly edited by the user) is never overwritten.
    writeFileSync(GLOBAL_CONFIG, JSON.stringify({ permissionMode: 'plan' }));
    writeFileSync(GLOBAL_INSTRUCTIONS, 'my own rules');
    expect(await ensureGlobalDefaults()).toEqual([]);
    expect(readFileSync(GLOBAL_INSTRUCTIONS, 'utf8')).toBe('my own rules');
    const cwd = mkdtempSync(join(tmpdir(), 'tessera-cfg-'));
    const cfg = await loadConfig(cwd, { trusted: false });
    expect(cfg.permissionMode).toBe('plan');
    expect(cfg.thinkingLevel).toBe('medium'); // missing keys keep their defaults
    rmSync(GLOBAL_CONFIG, { force: true });
    rmSync(GLOBAL_INSTRUCTIONS, { force: true });
  });

  it('rejects invalid values with a message naming the setting', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tessera-cfg-'));
    writeFileSync(GLOBAL_CONFIG, JSON.stringify({ thinkingLevel: 'extreme' }));
    await expect(loadConfig(cwd, { trusted: false })).rejects.toThrow(/thinkingLevel/);
    writeFileSync(GLOBAL_CONFIG, JSON.stringify({ permissionMode: 'yolo' }));
    await expect(loadConfig(cwd, { trusted: false })).rejects.toThrow(/permissionMode/);
    writeFileSync(GLOBAL_CONFIG, JSON.stringify({ permissionMode: 'edit' }));
    expect((await loadConfig(cwd, { trusted: false })).permissionMode).toBe('acceptEdits');
    rmSync(GLOBAL_CONFIG, { force: true });
  });

  it('accepts "edit" as an alias and rejects unknown modes', () => {
    expect(parsePermissionMode('edit', 'x')).toBe('acceptEdits');
    expect(parsePermissionMode('bypass', 'x')).toBe('bypass');
    expect(parsePermissionMode('dangerous', 'x')).toBe('dangerous');
    expect(() => parsePermissionMode('all', '--permission-mode')).toThrow(/--permission-mode/);
  });

  it('does not let an untrusted project switch to bypass', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tessera-cfg-'));
    mkdirSync(join(cwd, '.tessera'));
    writeFileSync(join(cwd, '.tessera', 'settings.json'), JSON.stringify({ permissionMode: 'bypass' }));
    expect((await projectTrust(cwd)).summary).toContain('permission mode: bypass');
    expect((await loadConfig(cwd, { trusted: false })).permissionMode).toBe('default');
    expect((await loadConfig(cwd, { trusted: true })).permissionMode).toBe('bypass');
  });
});
