import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// /login and /logout run against a scripted sign-in: no browser, no network.
vi.mock('../src/oauth.js', () => ({
  OAUTH_FLOWS: [{ id: 'anthropic', name: 'Anthropic (Claude Pro/Max)' }],
  oauthFlow: (id: string) => (id === 'anthropic' ? { id: 'anthropic', name: 'Anthropic (Claude Pro/Max)' } : undefined),
  loginFlow: async () => ({ oauth: { accessToken: 'tok-123', expiresAt: Date.now() + 3_600_000 } }),
  oauthStatus: () => 'subscription · renews in 1h',
  forgetProvider: async (config: { providers: Record<string, unknown> }, id: string) => {
    if (!config.providers[id]) return false;
    delete config.providers[id];
    return true;
  },
}));
import type { App } from '../src/app.js';
import { runCommand } from '../src/commands.js';
import { HOME_DIR } from '../src/config.js';
import { SessionStore } from '../src/session/store.js';

/** Bare /model and /mode open the argument selectbox (like /resume) instead of just printing; /think still toggles. */
const app = {
  ctx: { cwd: '/tmp/commands-test' },
  listSkills: async () => [],
  agent: {
    model: { id: 'mimo-v2.6-flash', format: 'chat', context: 500_000, output: 32_000, reasoning: true, cost: { input: 0, output: 0, cacheRead: 0 } },
    sessionId: 's',
    messages: [],
    thinking: true,
    thinkingLevel: 'medium',
    thinkingAuto: false,
  },
  config: { showThinking: true },
  catalog: [],
  permissions: { mode: 'default' },
} as unknown as App;

describe('bare slash commands', () => {
  it('opens the selectbox for /mode instead of printing the current mode', async () => {
    const r = await runCommand(app, '/mode');
    expect(r.choose?.title).toContain('/mode');
    expect(r.choose?.options.map((o) => o.label)).toEqual(['default', 'acceptEdits', 'plan', 'bypass', 'dangerous']);
    expect(r.choose?.options[0]!.hint).toContain('current');
  });

  it('opens the selectbox for bare /think too, and ctrl+s (select with save) stores it as the default', async () => {
    const think = await runCommand(app, '/think');
    expect(think.choose?.title).toContain('/think');
    expect(think.choose?.canSave).toBe(true);
    expect(think.choose?.options.map((o) => o.label)).toContain('off');
    const off = think.choose!.options.findIndex((o) => o.label === 'off');
    const applied = await think.choose!.select(off, true);
    expect(applied.output).toContain('saved as the default for new sessions');
    const resume = await runCommand(app, '/resume'); // its own richer picker, no other session in the temp dir
    expect(resume.choose).toBeUndefined();
  });
});

describe('/stats', () => {
  it('says there is nothing logged when the file is missing', async () => {
    const r = await runCommand(app, '/stats');
    expect(r.output).toBe('No compactions logged yet.');
  });

  it('summarizes the compaction log and skips broken lines', async () => {
    const now = Date.now();
    const at0 = new Date(now - 120_000).toISOString();
    const at1 = new Date(now - 60_000).toISOString();
    const at3 = new Date(now).toISOString();
    const lines = [
      ...Array.from({ length: 5 }, () => JSON.stringify({ at: at0, sessionId: '11111111-aaaa-bbbb-cccc-dddddddddddd', reads: 0 })),
      ...Array.from({ length: 2 }, () => JSON.stringify({ at: at1, sessionId: '22222222-aaaa-bbbb-cccc-dddddddddddd', reads: 1 })),
      JSON.stringify({ at: at3, sessionId: '22222222-aaaa-bbbb-cccc-dddddddddddd', reads: 3 }),
      'not json at all',
      JSON.stringify({ at: at0, reads: 99 }), // missing sessionId
    ];
    await mkdir(HOME_DIR, { recursive: true });
    await writeFile(join(HOME_DIR, 'compaction-log.jsonl'), lines.join('\n'));
    const r = await runCommand(app, '/stats');
    expect(r.output).toContain('8 compactions logged across 2 sessions');
    expect(r.output).toContain('reads after compaction: 0×5, 1×2, 3×1');
    expect(r.output).toContain('average 0.6 · median 0');
    expect(r.output).toContain('22222222 · 3 reads');
  });
});

describe('/resume by title', () => {
  it('resumes on a single title-substring match and falls back to a picker on several', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tessera-test-cwd-'));
    await new SessionStore(cwd, '11111111-1111-4111-8111-111111111111').setTitle('Fix resize bug');
    await new SessionStore(cwd, '22222222-2222-4222-8222-222222222222').setTitle('Add stats command');
    await new SessionStore(cwd, '33333333-3333-4333-8333-333333333333').setTitle('Fix resize bug in viewport');
    const resumeApp = {
      ...app,
      ctx: { cwd },
      agent: { ...app.agent, sessionId: 'current-session' },
      switchSession: async () => undefined,
      title: 'Fix resize bug',
    } as unknown as App;

    const one = await runCommand(resumeApp, '/resume resize'); // two "resize" matches → picker
    expect(one.choose?.options).toHaveLength(2);

    const hit = await runCommand(resumeApp, '/resume stats'); // one match → resume directly
    expect(hit.reload).toBe(true);
    expect(hit.output).toContain('"Fix resize bug"');

    const none = await runCommand(resumeApp, '/resume quantum');
    expect(none.output).toBe('No session matching "quantum" — Run /resume to pick one.');
  });
});

describe('/memo — per-session memories', () => {
  const memos: string[] = [];
  const memoApp = {
    ...app,
    memos: () => memos,
    addMemo: async (t: string) => void memos.push(t),
    removeMemo: async (i: number) => {
      if (i < 0 || i >= memos.length) throw new Error(`No memo ${i + 1}.`);
      memos.splice(i, 1);
    },
  } as unknown as App;

  it('saves, lists and removes memos', async () => {
    expect((await runCommand(memoApp, '/memo')).output).toContain('No memos');
    await runCommand(memoApp, '/memo use pnpm, not npm in this repo');
    await runCommand(memoApp, '/memo the user prefers Korean answers');
    const list = await runCommand(memoApp, '/memo');
    expect(list.output).toContain('2.');
    expect(list.output).toContain('use pnpm, not npm');
    const removed = await runCommand(memoApp, '/memo remove 1');
    expect(removed.output).toContain('Removed');
    expect((await runCommand(memoApp, '/memo')).output).not.toContain('pnpm');
    await expect(runCommand(memoApp, '/memo remove 5')).rejects.toThrow(/No memo 5/);
  });
});

describe('/sessions', async () => {
  const { SessionStore } = await import('../src/session/store.js');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  it('numbers the list, removes a session, and refuses the current one', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sess-cmd-'));
    const a = new SessionStore(cwd, 'sess-aaaa');
    await a.setTitle('first session');
    const b = new SessionStore(cwd, 'sess-bbbb');
    await b.setTitle('second session');
    const app2 = {
      ...app,
      ctx: { cwd },
      agent: { ...app.agent, sessionId: 'sess-bbbb' },
      pruneSessions: async () => [],
    } as unknown as App;
    const list = await runCommand(app2, '/sessions');
    const lineFor = (id8: string) => (list.output ?? '').split('\n').find((l) => l.includes(id8))!;
    // The order of equal-mtime files is the filesystem's, so the numbers are read from the list, not assumed.
    const num = (id8: string) => Number(lineFor(id8).trim().replace(/^\D+/, '').split('.')[0]); // the current row starts with ●
    expect(lineFor('sess-aaa')).toBeDefined();
    expect(lineFor('sess-bbb')).toContain('●'); // the current one is marked
    const refused = await runCommand(app2, `/sessions remove ${num('sess-bbb')}`);
    expect(refused.output).toContain('session you are in');
    const removed = await runCommand(app2, `/sessions remove ${num('sess-aaa')}`);
    expect(removed.output).toContain('Removed sess-aaa');
    expect((await runCommand(app2, '/sessions')).output).not.toContain('sess-aaa');
    expect((await runCommand(app2, '/sessions remove 9')).output).toContain('No session 9');
  });
});

describe('/login and /logout', () => {
  const loginApp = () => {
    const invalidated: string[] = [];
    const a = {
      ...app,
      config: { providers: {} as Record<string, { apiKey?: string; oauth?: { accessToken: string; expiresAt: number } }> },
      catalog: [{ id: 'anthropic/claude-test', name: 'claude-test', format: 'messages', context: 200_000, output: 8_192, reasoning: true, images: true, provider: 'anthropic', cost: { input: 3, output: 15, cacheRead: 0.3 } }],
      setModel: async (_id: string) => {},
      invalidateModels: () => invalidated.push('x'),
    };
    return { a: a as unknown as App, config: a.config, invalidated };
  };

  it('bare /login opens the provider list', async () => {
    const { a } = loginApp();
    const r = await runCommand(a, '/login');
    expect(r.choose?.options.map((o) => o.label)).toContain('anthropic');
  });

  it('saves the subscription and opens that provider\'s models', async () => {
    const { a, config, invalidated } = loginApp();
    const r = await runCommand(a, '/login anthropic');
    expect(r.output).toContain('Signed in with');
    expect(r.output).toContain('subscription');
    expect(config.providers.anthropic?.oauth?.accessToken).toBe('tok-123');
    expect(r.choose?.title).toContain('Anthropic');
    expect(r.choose?.options.map((o) => o.label)).toEqual(['anthropic/claude-test']);
    expect(invalidated).toEqual(['x']); // the cached clients must drop the old key
  });

  it('/logout removes the credentials', async () => {
    const { a, config, invalidated } = loginApp();
    config.providers.anthropic = { oauth: { accessToken: 't', expiresAt: 1 } };
    const r = await runCommand(a, '/logout anthropic');
    expect(r.output).toContain('Removed the saved credentials for anthropic');
    expect(config.providers.anthropic).toBeUndefined();
    expect(invalidated).toEqual(['x']);
    expect((await runCommand(a, '/logout anthropic')).output).toContain('Nothing saved');
  });
});
