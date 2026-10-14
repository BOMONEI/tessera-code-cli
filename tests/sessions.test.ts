import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';

process.env.TESSERA_HOME = mkdtempSync(join(tmpdir(), 'tessera-home-'));
const { SessionStore, parseSession, promptText } = await import('../src/session/store.js');
const { Checkpoints } = await import('../src/session/checkpoints.js');
const { transcriptOf } = await import('../src/ui/transcript.js');
const { copyTargets } = await import('../src/ui/clipboard.js');
const { searchHistory } = await import('../src/ui/history.js');
const { lastAnswer } = await import('../src/commands.js');

const user = (content: string): ModelMessage => ({ role: 'user', content });
const assistant = (content: string): ModelMessage => ({ role: 'assistant', content });

function project() {
  const cwd = mkdtempSync(join(tmpdir(), 'tessera-proj-'));
  const store = new SessionStore(cwd, `s-${Math.random().toString(36).slice(2)}`);
  const cps = new Checkpoints(() => store, cwd);
  return { cwd, store, cps };
}

describe('session store', () => {
  it('restores title, settings and checkpoints; rewind records drop later checkpoints', () => {
    const raw = [
      { type: 'meta', sessionId: 's', cwd: '/p', createdAt: 'x' },
      { type: 'messages', messages: [user('hi'), assistant('yo')], at: 'x' },
      { type: 'title', title: 'Greeting' },
      { type: 'state', model: 'm', thinking: false, mode: 'plan', total: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cost: 0.5 } },
      { type: 'checkpoint', turn: 1, index: 0, anchor: 'a', prompt: 'hi', at: 'x', files: [] },
      { type: 'checkpoint', turn: 2, index: 2, anchor: 'b', prompt: 'more', at: 'x', files: [] },
      { type: 'rewind', turn: 2 },
    ].map((r) => JSON.stringify(r)).join('\n');
    const s = parseSession(raw);
    expect(s.title).toBe('Greeting');
    expect(s.state).toMatchObject({ model: 'm', thinking: false, mode: 'plan', total: { cost: 0.5 } });
    expect(s.checkpoints.map((c) => c.turn)).toEqual([1]);
    expect(s.messages).toHaveLength(2);
  });

  it('creates the file lazily and lists sessions with title and message count', async () => {
    const { cwd, store } = project();
    expect(existsSync(store.path)).toBe(false);
    expect(await SessionStore.list(cwd)).toEqual([]);
    await store.sync({ messages: [user('fix the bug\n\n<context>\nfile contents\n</context>'), assistant('done')], generation: 0 });
    const list = await SessionStore.list(cwd);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: store.sessionId, title: 'fix the bug', messages: 2 });
    await store.setTitle('Bug fix');
    expect((await SessionStore.list(cwd))[0]!.title).toBe('Bug fix');
  });

  it('forks history and file snapshots into a new session', async () => {
    const { cwd, store } = project();
    await store.sync({ messages: [user('a'), assistant('b')], generation: 0 });
    const blob = await store.saveBlob(Buffer.from('old'));
    const copy = await store.fork('forked');
    const loaded = await copy.load();
    expect(loaded.messages).toHaveLength(2);
    expect((await copy.readBlob(blob)).toString()).toBe('old');
    expect(readFileSync(copy.path, 'utf8')).toContain(`"forkedFrom":"${store.sessionId}"`);
    expect((await SessionStore.list(cwd)).map((s) => s.id).sort()).toEqual(['forked', store.sessionId].sort());
  });

  it('starts a new line after a truncated record instead of corrupting the next one', async () => {
    const { store } = project();
    await store.sync({ messages: [user('a')], generation: 0 });
    writeFileSync(store.path, readFileSync(store.path, 'utf8') + '{"type":"messa');
    const next = new SessionStore(store.cwd, store.sessionId);
    const loaded = await next.load();
    next.adopt({ messages: loaded.messages, generation: 0 });
    await next.sync({ messages: [...loaded.messages, assistant('b')], generation: 0 });
    expect((await new SessionStore(store.cwd, store.sessionId).load()).messages.map((m) => m.content)).toEqual(['a', 'b']);
  });

  it('finds sessions by exact id first, else the newest prefix match', async () => {
    const { cwd } = project();
    const older = new SessionStore(cwd, 'abc-old');
    await older.sync({ messages: [user('x')], generation: 0 });
    await new Promise((r) => setTimeout(r, 20));
    const newer = new SessionStore(cwd, 'abc-new');
    await newer.sync({ messages: [user('y')], generation: 0 });
    expect(await SessionStore.find(cwd, 'abc')).toBe('abc-new');
    expect(await SessionStore.find(cwd, 'abc-old')).toBe('abc-old');
    expect(await SessionStore.find(cwd, '')).toBeUndefined();
    expect(await SessionStore.find(cwd, 'zzz')).toBeUndefined();
  });

  it('strips attachments and shell context from prompts', () => {
    expect(promptText(user('do it\n\n<context>\nCommands the user ran…\n</context>'))).toBe('do it');
  });
});

describe('checkpoints (undo / rewind / diff)', () => {
  it('snapshots each file once per turn and rewinds code and conversation', async () => {
    const { cwd, cps } = project();
    const a = join(cwd, 'a.txt');
    const b = join(cwd, 'b.txt');
    writeFileSync(a, 'v1');
    const history: ModelMessage[] = [];

    cps.begin('first', history);
    await cps.beforeWrite(a);
    writeFileSync(a, 'v2');
    await cps.beforeWrite(a); // second edit in the same turn: keeps the first snapshot
    writeFileSync(a, 'v3');
    await cps.end();
    history.push(user('first'), assistant('ok'));

    cps.begin('second', history);
    await cps.beforeWrite(b); // new file
    writeFileSync(b, 'new');
    await cps.beforeWrite(a);
    writeFileSync(a, 'v4');
    await cps.end();
    history.push(user('second'), assistant('ok'));

    expect(await cps.diff()).toContain('b.txt (new)');

    // Undo the second turn only.
    const r1 = await cps.rewind(cps.list[1]!, 'both', history);
    expect(readFileSync(a, 'utf8')).toBe('v3');
    expect(existsSync(b)).toBe(false);
    expect(r1.conversation).toBe(true);
    expect(r1.messages).toHaveLength(2);
    expect(r1.redo).toBe(true);
    // Turn 2 is gone; a checkpoint holding the files as they were before the rewind replaces it.
    expect(cps.list.map((c) => c.prompt.startsWith('(files before rewinding'))).toEqual([false, true]);

    // Undoing the rewind brings the files back (redo).
    await cps.rewind(cps.list.at(-1)!, 'both', history.slice(0, 2));
    expect(readFileSync(a, 'utf8')).toBe('v4');
    expect(readFileSync(b, 'utf8')).toBe('new');

    // Rewind code only to before the first turn: the conversation is kept.
    const r2 = await cps.rewind(cps.list[0]!, 'code', history.slice(0, 2));
    expect(readFileSync(a, 'utf8')).toBe('v1');
    expect(r2.messages).toBeUndefined();
  });

  it('keeps file snapshots after a conversation-only rewind', async () => {
    const { cwd, cps } = project();
    const a = join(cwd, 'a.txt');
    const b = join(cwd, 'b.txt');
    writeFileSync(a, 'a1');
    writeFileSync(b, 'b1');
    const history: ModelMessage[] = [];
    cps.begin('one', history);
    await cps.beforeWrite(a);
    writeFileSync(a, 'a2');
    await cps.end();
    history.push(user('one'), assistant('ok'));
    cps.begin('two', history);
    await cps.beforeWrite(b);
    writeFileSync(b, 'b2');
    await cps.end();
    history.push(user('two'), assistant('ok'));

    const r = await cps.rewind(cps.list[1]!, 'conversation', history);
    expect(r.conversation).toBe(true);
    expect(readFileSync(b, 'utf8')).toBe('b2'); // files untouched
    expect(cps.list).toHaveLength(2); // both checkpoints kept
    await cps.rewind(cps.list[0]!, 'both', r.messages!);
    expect(readFileSync(a, 'utf8')).toBe('a1');
    expect(readFileSync(b, 'utf8')).toBe('b1'); // still restorable
  });

  it('never records a failed snapshot as a missing file', async () => {
    const { cwd, cps } = project();
    const f = join(cwd, 'dir-not-file');
    mkdirSync(f); // reading a directory fails
    cps.begin('x', []);
    await expect(cps.beforeWrite(f)).rejects.toThrow(/undo snapshot/);
    await cps.end();
    expect(cps.list[0]!.files).toEqual([]);
  });

  it('restores only files when the conversation was compacted since', async () => {
    const { cwd, cps } = project();
    const f = join(cwd, 'f.txt');
    writeFileSync(f, 'before');
    cps.begin('change', [user('old'), assistant('old')]);
    await cps.beforeWrite(f);
    writeFileSync(f, 'after');
    await cps.end();
    const r = await cps.rewind(cps.list[0]!, 'both', [user('summary'), assistant('ok'), user('change')]);
    expect(readFileSync(f, 'utf8')).toBe('before');
    expect(r.conversation).toBe(false);
  });

  it('persists checkpoints so a resumed session can still undo', async () => {
    const { cwd, store, cps } = project();
    mkdirSync(join(cwd, 'src'));
    const f = join(cwd, 'src', 'x.ts');
    writeFileSync(f, 'one');
    cps.begin('edit x', []);
    await cps.beforeWrite(f);
    writeFileSync(f, 'two');
    await cps.end();
    const loaded = await new SessionStore(cwd, store.sessionId).load();
    const resumed = new Checkpoints(() => store, cwd);
    resumed.reset(loaded.checkpoints);
    await resumed.rewind(resumed.list[0]!, 'code', []);
    expect(readFileSync(f, 'utf8')).toBe('one');
  });
});

describe('transcript replay', () => {
  it('rebuilds prompts, answers and tool lines, hiding compaction plumbing', () => {
    const messages: ModelMessage[] = [
      user('This session continues from an earlier conversation that was compacted. Summary:\n\n...'),
      assistant('Understood. I will continue from where we left off.'),
      user('fix median\n\n<context>\nfiles\n</context>'),
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'read', input: { path: 'median.ts' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'read', output: { type: 'text', value: '1\tline' } }] },
      assistant('Fixed.'),
      user('[Interrupted by user]'),
    ];
    const t = transcriptOf(messages);
    expect(t.map((e) => e.kind)).toEqual(['info', 'user', 'tool', 'assistant', 'info']);
    expect(t[1]).toEqual({ kind: 'user', text: 'fix median' });
    expect(t[2]).toMatchObject({ kind: 'tool', label: 'read(median.ts)' });
  });

  it('shows only the last prompts of long sessions', () => {
    const messages = Array.from({ length: 50 }, (_, i) => [user(`q${i}`), assistant(`a${i}`)]).flat();
    const t = transcriptOf(messages, 5);
    expect(t[0]).toMatchObject({ kind: 'info', text: '… 45 earlier prompts not shown' });
    expect(t[1]).toEqual({ kind: 'user', text: 'q45' });
  });
});

describe('copy, history search, last answer', () => {
  it('offers the whole answer and each code block', () => {
    const t = copyTargets('Intro\n\n```ts\nconst a = 1;\n```\n\ntext\n\n```\nnpm test\n```');
    expect(t.map((x) => x.label)).toEqual(['Whole response', 'Code block 1 (ts)', 'Code block 2']);
    expect(t[1]!.text).toBe('const a = 1;');
    expect(t[2]!.text).toBe('npm test');
  });
  it('searches history newest first and continues to older matches', () => {
    const h = ['run tests', 'fix lint', 'run build'];
    expect(searchHistory(h, 'run')).toBe(0);
    expect(searchHistory(h, 'run', 1)).toBe(2);
    expect(searchHistory(h, 'nope')).toBe(-1);
  });
  it('collects the latest answer across tool steps', () => {
    const messages: ModelMessage[] = [user('q'), assistant('part one'), { role: 'tool', content: [] }, assistant('part two')];
    expect(lastAnswer(messages)).toBe('part one\n\npart two');
  });
});

describe('session titles', async () => {
  const { cleanTitle } = await import('../src/agent/compact.js');
  it('rejects answers and markdown, keeps plain titles', () => {
    expect(cleanTitle('```bash\nfind . | wc -l\n```')).toBeUndefined();
    expect(cleanTitle('"파일 개수 세기"')).toBe('파일 개수 세기');
    expect(cleanTitle('Title: Fix median bug.')).toBe('Fix median bug');
    expect(cleanTitle('## **README 정리**')).toBe('README 정리');
  });
});

describe('lastAnswer with interjections', async () => {
  const { INTERJECTION_PREFIX } = await import('../src/agent/agent.js');
  it('includes the text before and after an interjection', () => {
    const messages: ModelMessage[] = [user('q'), assistant('first'), user(`${INTERJECTION_PREFIX}\nshorter`), assistant('second')];
    expect(lastAnswer(messages)).toBe('first\n\nsecond');
  });
});
