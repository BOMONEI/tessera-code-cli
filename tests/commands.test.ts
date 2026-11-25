import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
