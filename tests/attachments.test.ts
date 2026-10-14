import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { attachMentionedFiles, parseMentions, suggestFiles } from '../src/agent/attachments.js';
import { mentionAt } from '../src/ui/completion.js';

function project() {
  const root = mkdtempSync(join(tmpdir(), 'mention-'));
  mkdirSync(join(root, 'src', 'ui'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), 'export const app = 1;\n');
  writeFileSync(join(root, 'src', 'ui', 'repl.ts'), 'repl\n');
  writeFileSync(join(root, 'Makefile'), 'all:\n\techo hi\n');
  writeFileSync(join(root, '.env'), 'SECRET=1\n');
  writeFileSync(join(root, 'big.txt'), Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n'));
  return root;
}

describe('parseMentions', () => {
  it('separates explicit @paths from bare file names and strips punctuation/line suffixes', () => {
    expect(parseMentions('look at @src/app.ts:12, @Makefile and median.ts.')).toEqual({ explicit: ['src/app.ts', 'Makefile'], implicit: ['median.ts'] });
  });
  it('ignores emails', () => expect(parseMentions('mail me at a@b.com').explicit).toEqual([]));
});

describe('mentionAt', () => {
  it('finds the mention under the cursor', () => {
    expect(mentionAt('fix @src/ap', 11)).toEqual({ start: 4, query: 'src/ap' });
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionAt('a@b', 3)).toBeUndefined();
    expect(mentionAt('@src/app.ts done', 16)).toBeUndefined();
  });
});

describe('suggestFiles', () => {
  const root = project();
  it('ranks basename prefix matches first and includes directories', () => {
    expect(suggestFiles(root, 'app')[0]).toBe('src/app.ts');
    expect(suggestFiles(root, 'src')).toContain('src/');
    expect(suggestFiles(root, 'srcrepl')).toContain('src/ui/repl.ts'); // subsequence
  });
  it('never suggests secrets', () => expect(suggestFiles(root, 'env')).not.toContain('.env'));
  it('shows top-level entries for an empty query', () => expect(suggestFiles(root, '')).toEqual(expect.arrayContaining(['Makefile', 'src/'])));
});

describe('explicit @ attachments', () => {
  it('attaches extensionless files, lists directories, truncates big files, and refuses secrets', async () => {
    const root = project();
    const ctx = { cwd: root, readFiles: new Map<string, number>() } as never;
    const r = await attachMentionedFiles(ctx, 'see @Makefile @src/ @big.txt @.env @missing.ts');
    expect(r.context).toContain('<file path="Makefile">');
    expect(r.context).toContain('<directory path="src">');
    expect(r.context).toContain('src/ui/repl.ts');
    expect(r.context).toContain('partial="true"');
    expect(r.context).not.toContain('SECRET');
    expect(r.notes.join('\n')).toMatch(/\.env: looks like a secret/);
    expect(r.notes.join('\n')).toMatch(/missing\.ts: not found/);
    // a truncated file must not count as read (edit would act on unseen content)
    expect([...(ctx as { readFiles: Map<string, number> }).readFiles.keys()].some((k) => k.endsWith('big.txt'))).toBe(false);
  });
});
