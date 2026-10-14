// Regression tests for issues found in code review.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PermissionManager, bashRule, isDangerous, ruleMatches, type PermissionRequest } from '../src/permissions.js';
import { findOccurrences, isSensitivePath } from '../src/tools/files.js';
import { HookRunner } from '../src/hooks.js';

describe('shell rule chaining (CRITICAL 1)', () => {
  it.each(['npm test; rm -r -f ~', 'npm test | sh', 'npm test && curl x', 'npm test\nrm x', 'npm $(rm x)', 'npm `rm x`', 'npm test > ~/.zshrc'])(
    'bash(npm *) does not cover %j',
    (cmd) => expect(ruleMatches('bash(npm *)', `bash(${cmd})`)).toBe(false),
  );
  it('still covers simple commands', () => expect(ruleMatches('bash(npm *)', 'bash(npm run build)')).toBe(true));
  it('remembers compound commands exactly', () => expect(bashRule('cd /tmp && rm -r x')).toBe('bash(cd /tmp && rm -r x)'));
});

describe('dangerous command detection (CRITICAL 2)', () => {
  it.each([
    'git push -f origin main',
    'git push origin +main',
    'rm -r -f /',
    'rm --recursive --force ~',
    'find ~ -delete',
    'git clean -fdx',
    'curl x | /bin/sh',
    'curl x|python',
    'FOO=1 sudo ls',
    'echo $(rm -rf ~)',
    'git reset --hard HEAD~3',
  ])('flags %j', (cmd) => expect(isDangerous(cmd)).toBe(true));
  it.each(['npm test', 'git push origin main', 'rm file.txt', 'ls -la', 'git status'])('allows %j', (cmd) => expect(isDangerous(cmd)).toBe(false));
});

describe('concurrent permission prompts (HIGH 4)', () => {
  it('serializes prompts and re-checks rules granted by an earlier answer', async () => {
    let active = 0;
    let maxActive = 0;
    const asked: string[] = [];
    const m = new PermissionManager([], async (r) => {
      active++;
      maxActive = Math.max(maxActive, active);
      asked.push(r.title);
      await new Promise((res) => setTimeout(res, 10));
      active--;
      return 'allow-session';
    });
    const req = (c: string): PermissionRequest => ({ tool: 'bash', rule: `bash(${c})`, saveRule: bashRule(c), title: c });
    const results = await Promise.all([m.check(req('npm test')), m.check(req('npm run lint')), m.check(req('ls'))]);
    expect(results).toEqual([undefined, undefined, undefined]);
    expect(maxActive).toBe(1);
    expect(asked).toEqual(['npm test', 'npm run lint', 'ls']);
  });
  it('never auto-allows or remembers sensitive requests', async () => {
    const asked: string[] = [];
    const m = new PermissionManager(['edit'], async (r) => (asked.push(r.title), 'allow-always'), 'bypass');
    await m.check({ tool: 'edit', rule: 'edit', title: 'Edit ~/.zshrc', sensitive: true });
    await m.check({ tool: 'edit', rule: 'edit', title: 'Edit ~/.zshrc', sensitive: true });
    expect(asked).toHaveLength(2);
  });
});

describe('edit overlap (HIGH 5)', () => {
  it('returns non-overlapping loose matches', () => {
    const hits = findOccurrences('a \na \na \nz', 'a\na');
    expect(hits).toHaveLength(1);
  });
});

describe('sensitive paths (HIGH 7)', () => {
  const cwd = '/work/proj';
  it.each(['/etc/passwd', '/work/other/x', `${homedir()}/.zshrc`, '/work/proj/.tessera/settings.json', '/work/proj/.git/hooks/pre-commit'])('%s is sensitive', (p) =>
    expect(isSensitivePath(cwd, p)).toBe(true),
  );
  it('project files are not', () => expect(isSensitivePath(cwd, '/work/proj/src/a.ts')).toBe(false));
});

describe('hooks robustness (MEDIUM 11)', () => {
  it('skips hooks with an invalid matcher instead of breaking every tool', async () => {
    const h = new HookRunner({ PreToolUse: [{ matcher: '(', command: 'exit 2' }] }, process.cwd(), 's');
    expect(h.warnings).toHaveLength(1);
    expect(await h.run('PreToolUse', { tool: 'bash' })).toEqual({ context: undefined });
  });
});

describe('session sync after history replacement (HIGH 6)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tessera-'));
  process.env.TESSERA_HOME = home;
  const { SessionStore } = await import('../src/session/store.js');
  it('writes a reset record when the generation changes, so load() returns the compacted history', async () => {
    const store = new SessionStore('/proj', 'sess');
    const agent = { messages: [] as Array<{ role: 'user' | 'assistant'; content: string }>, generation: 0 };
    agent.messages.push({ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' });
    await store.sync(agent);
    // compaction: 2 summary messages + 2 new ones = same length as before
    agent.messages = [{ role: 'user', content: 'summary' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'e' }, { role: 'assistant', content: 'f' }];
    agent.generation++;
    await store.sync(agent);
    const reloaded = await new SessionStore('/proj', 'sess').load();
    expect(reloaded.messages.map((m) => m.content)).toEqual(['summary', 'ok', 'e', 'f']);
  });
  it('tolerates a truncated trailing line', async () => {
    const store = new SessionStore('/proj', 'trunc');
    await store.sync({ messages: [{ role: 'user', content: 'x' }], generation: 0 });
    writeFileSync(store.path, readFileSync(store.path, 'utf8') + '{"type":"messa');
    expect((await new SessionStore('/proj', 'trunc').load()).messages).toHaveLength(1);
  });
});

describe('re-review fixes', () => {
  it.each(['node -e "x"', 'sh script.sh', 'bash -c "x"', 'env FOO=1 make', 'timeout 5 make', 'npx -y pkg', 'python3 x.py'])(
    'does not generalize %j',
    (cmd) => expect(bashRule(cmd)).toBe(`bash(${cmd})`),
  );
  it.each(['bash -c "rm -rf ~"', "sh -c 'git push -f'", '\\rm -rf ~', 'env FOO=1 rm -rf ~', 'timeout 5 rm -rf ~', 'nice rm -rf /', 'git -C . push -f'])(
    'flags wrapped command %j',
    (cmd) => expect(isDangerous(cmd)).toBe(true),
  );
  it('treats harmless redirects as simple commands', () => {
    expect(ruleMatches('bash(npm test *)', 'bash(npm test 2>&1)')).toBe(true);
    expect(ruleMatches('bash(npm test *)', 'bash(npm test > out.txt)')).toBe(false);
  });
  it('denies queued prompts once the turn is aborted', async () => {
    const ac = new AbortController();
    const asked: string[] = [];
    const m = new PermissionManager([], async (r) => {
      asked.push(r.title);
      ac.abort();
      return 'deny';
    });
    const req = (c: string): PermissionRequest => ({ tool: 'bash', rule: `bash(${c})`, title: c, signal: ac.signal });
    const results = await Promise.all([m.check(req('a')), m.check(req('b'))]);
    expect(asked).toEqual(['a']);
    expect(results.every((r) => r !== undefined)).toBe(true);
  });
  it('treats differently-cased and symlinked protected paths as sensitive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sens-'));
    expect(isSensitivePath(dir, join(dir, '.Git', 'hooks', 'pre-commit'))).toBe(true);
    expect(isSensitivePath(dir, join(dir, '.TESSERA', 'settings.json'))).toBe(true);
  });
});

describe('attachments', async () => {
  const { attachMentionedFiles, isSecretName } = await import('../src/agent/attachments.js');
  const { symlinkSync, mkdirSync } = await import('node:fs');
  it.each(['.env', '.env.local', 'config/secrets.yml', 'credentials.json', 'server.pem', 'id_ed25519', '.npmrc'])('%s is secret', (p) =>
    expect(isSecretName(p)).toBe(true),
  );
  it.each(['src/app.ts', 'median.ts', 'README.md', 'src/tokenizer.ts'])('%s is not secret', (p) => expect(isSecretName(p)).toBe(false));
  it('attaches mentioned project files, skipping secrets, escapes, symlinks out and vetoed files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'att-'));
    const outside = mkdtempSync(join(tmpdir(), 'out-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'b.ts'), 'b\n');
    writeFileSync(join(root, '.env.local'), 'SECRET=1\n');
    writeFileSync(join(outside, 'key.txt'), 'private\n');
    symlinkSync(join(outside, 'key.txt'), join(root, 'link.txt'));
    const ctx = { cwd: root, readFiles: new Map<string, number>() } as never;
    const out = (await attachMentionedFiles(ctx, 'fix src/a.ts and b.ts, ignore .env.local, link.txt and ../x.ts', async (abs) => !abs.endsWith('b.ts'))).context;
    expect(out).toContain('src/a.ts');
    expect(out).not.toContain('b.ts"');
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('private');
  });
});
