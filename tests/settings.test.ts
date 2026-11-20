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

async function reasoningSent(opts: { thinking: boolean; thinkingLevel?: 'low' | 'medium' | 'high'; thinkingAuto?: boolean }, prompt = 'hi') {
  calls.length = 0;
  const a = new Agent({ model, apiKey: 'k', sessionId: 's', system: '', tools: {}, maxSteps: 1, contextLimit: 50_000, ...opts });
  for await (const _ of a.run(prompt)) void _;
  return calls[0]?.reasoning;
}

describe('thinking level', () => {
  it('sends the level explicitly instead of the provider default', async () => {
    expect(await reasoningSent({ thinking: true })).toBe('medium');
    expect(await reasoningSent({ thinking: true, thinkingLevel: 'high' })).toBe('high');
    expect(await reasoningSent({ thinking: false, thinkingLevel: 'high' })).toBe('none');
  });

  it('auto picks the level per prompt, at most the configured one', async () => {
    const auto = (thinkingLevel: 'low' | 'medium' | 'high', prompt: string) => reasoningSent({ thinking: true, thinkingAuto: true, thinkingLevel }, prompt);
    expect(await auto('high', 'what does this repo do?')).toBe('none');
    expect(await auto('high', 'README에 설치 방법 추가해줘')).toBe('low');
    expect(await auto('high', '로그인 버그 고쳐줘')).toBe('medium');
    expect(await auto('high', '세션 저장 구조 설계 검토해줘')).toBe('high');
    // The cap: never above it, unchanged below it.
    expect(await auto('low', '세션 저장 구조 설계 검토해줘')).toBe('low');
    expect(await auto('medium', '세션 저장 구조 설계 검토해줘')).toBe('medium');
    expect(await auto('low', 'thanks')).toBe('none');
    expect(await reasoningSent({ thinking: false, thinkingAuto: true }, 'refactor the parser')).toBe('none');
    expect(await reasoningSent({ thinking: true }, 'thanks')).toBe('medium'); // auto off: always the level
  });
});

describe('auto thinking level', () => {
  it('grades prompts by the work they ask for', async () => {
    const { promptLevel, autoLevel } = await import('../src/agent/effort.js');
    for (const p of ['thanks!', 'yes', '커밋해줘', 'what is the default port?', '이 프로젝트 빌드 명령어가 뭐야?', 'ㅇㅋ']) {
      expect(promptLevel(p), p).toBe('none');
    }
    for (const p of ['add a --verbose flag', 'rename foo to bar', '버튼 문구 변경해줘']) expect(promptLevel(p), p).toBe('low');
    for (const p of [
      'why does the build fail on CI?',
      'implement retry with backoff in fetch',
      '로그인이 안 돼',
      'look at this:\n```ts\nconst a = 1\n```',
      'a'.repeat(400),
      'one\ntwo\nthree\nfour',
    ]) {
      expect(promptLevel(p), p).toBe('medium');
    }
    expect(promptLevel('read this', { images: true })).toBe('medium');
    for (const p of [
      '이 함수 리팩터링해줘',
      'find the root cause of the deadlock',
      '성능 최적화 방안',
      'TypeError: x is not a function\n    at foo (src/a.ts:3:1)',
      'a'.repeat(2000),
    ]) {
      expect(promptLevel(p), p).toBe('high');
    }
    expect(autoLevel('find the race condition', 'medium')).toBe('medium');
    expect(autoLevel('add a flag', 'medium')).toBe('low');
    // "Go on" inherits the previous turn's level (capped like any other).
    expect(promptLevel('계속해', { previous: 'none' })).toBe('none');
    expect(promptLevel('continue', { previous: 'medium' })).toBe('medium');
    expect(autoLevel('continue', 'low')).toBe('low');
  });
});

describe('/think', () => {
  it('sets on/auto/off and the level (the cap in auto) together or alone', async () => {
    const { BUILTIN_COMMANDS } = await import('../src/commands.js');
    const think = BUILTIN_COMMANDS.find((c) => c.name === 'think')!;
    const agent = { model, thinking: false, thinkingAuto: false, thinkingLevel: 'medium' };
    const app = { agent, config: { showThinking: true } } as unknown as Parameters<typeof think.run>[0];
    const state = () => ({ thinking: agent.thinking, thinkingAuto: agent.thinkingAuto, thinkingLevel: agent.thinkingLevel });
    expect((await think.run(app, 'auto high')).output).toMatch(/at most high/);
    expect(state()).toEqual({ thinking: true, thinkingAuto: true, thinkingLevel: 'high' });
    await think.run(app, 'low'); // a level alone: always that level, auto off
    expect(state()).toEqual({ thinking: true, thinkingAuto: false, thinkingLevel: 'low' });
    await think.run(app, 'auto low');
    await think.run(app, 'off');
    expect(state()).toEqual({ thinking: false, thinkingAuto: true, thinkingLevel: 'low' });
    await think.run(app, 'on medium');
    expect(state()).toEqual({ thinking: true, thinkingAuto: false, thinkingLevel: 'medium' });
    await think.run(app, 'auto');
    expect(state()).toEqual({ thinking: true, thinkingAuto: true, thinkingLevel: 'medium' });
    expect((await think.run(app, 'auto bogus')).output).toMatch(/^Usage/);
    expect((await think.run(app, 'off high')).output).toMatch(/^Usage/);
    expect(state()).toEqual({ thinking: true, thinkingAuto: true, thinkingLevel: 'medium' });
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
