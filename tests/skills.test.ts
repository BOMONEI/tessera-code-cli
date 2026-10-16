import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createSkill, discoverSkills, installSkills, parseSkillFile, projectSkills, skillPrompt, skillsSection } = await import('../src/skills.js');
const { projectTrust } = await import('../src/config.js');
const { loadCommands } = await import('../src/commands.js');
const { skillTools } = await import('../src/tools/skill.js');

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `tessera-skills-${p}-`));
function skill(root: string, folder: string, frontMatter: string, body = 'Do the thing.', files: Record<string, string> = {}) {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, 'SKILL.md'), `---\n${frontMatter}\n---\n\n${body}\n`);
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(root, folder, f, '..'), { recursive: true });
    writeFileSync(join(root, folder, f), c);
  }
}

describe('SKILL.md', () => {
  it('reads front matter: plain, quoted and folded/literal block values', () => {
    const { meta, body } = parseSkillFile('---\nname: PDF Tools\ndescription: >\n  Fill and merge\n  PDF forms.\nlicense: "MIT"\nnotes: |\n  line one\n  line two\n---\n# Body\ntext\n');
    expect(meta).toEqual({ name: 'PDF Tools', description: 'Fill and merge PDF forms.', license: 'MIT', notes: 'line one\nline two' });
    expect(body).toBe('# Body\ntext');
    expect(parseSkillFile('no front matter').body).toBe('no front matter');
  });
});

describe('discovery', () => {
  it('finds tessera, Claude and project skills; the project\'s only when trusted; first name wins', async () => {
    const home = tmp('home');
    const claude = tmp('claude');
    const cwd = tmp('proj');
    skill(join(home, 'skills'), 'deploy', 'name: deploy\ndescription: tessera deploy');
    skill(join(claude, 'skills'), 'deploy', 'name: deploy\ndescription: claude deploy');
    skill(join(claude, 'skills'), 'pdf', 'name: pdf\ndescription: PDF work');
    skill(join(cwd, '.tessera', 'skills'), 'release', 'name: release\ndescription: project release');
    skill(join(cwd, '.claude', 'skills'), 'lint-fix', 'description: fix lint');
    const untrusted = await discoverSkills({ home, cwd, projectTrusted: false, claudeHome: claude });
    expect(untrusted.map((s) => `${s.name}:${s.source}`)).toEqual(['deploy:global', 'pdf:claude']);
    const trusted = await discoverSkills({ home, cwd, projectTrusted: true, claudeHome: claude });
    expect(trusted.map((s) => `${s.name}:${s.source}`)).toEqual(['deploy:global', 'lint-fix:claude-project', 'pdf:claude', 'release:project']);
    expect(trusted.find((s) => s.name === 'deploy')!.description).toBe('tessera deploy');
  });

  it('lists skills in the system prompt by name and description only', () => {
    const section = skillsSection([{ name: 'pdf', description: 'PDF\n work', dir: '/x', file: '/x/SKILL.md', source: 'claude' }]);
    expect(section).toContain('- pdf: PDF work');
    expect(section).toContain('call the skill tool');
    expect(skillsSection([])).toBe('');
  });
});

describe('loading a skill', () => {
  it('gives its instructions, folder, other files and the arguments', async () => {
    const root = tmp('load');
    skill(root, 'pdf', 'name: pdf\ndescription: PDF work', 'Run scripts/fill.py <file>.', { 'scripts/fill.py': 'print(1)', 'ref/forms.md': '#' });
    const [s] = await discoverSkills({ home: tmp('h'), cwd: tmp('c'), projectTrusted: false, claudeHome: join(root, '..') }).then(() => [
      { name: 'pdf', description: 'PDF work', dir: join(root, 'pdf'), file: join(root, 'pdf', 'SKILL.md'), source: 'global' as const },
    ]);
    const text = await skillPrompt(s!, 'fill form.pdf');
    expect(text).toContain('# Skill: pdf');
    expect(text).toContain(`Skill folder: ${join(root, 'pdf')}`);
    expect(text).toContain('Files: ref/forms.md, scripts/fill.py');
    expect(text).toContain('Run scripts/fill.py <file>.');
    expect(text).toContain('## Arguments\nfill form.pdf');
    expect(text).not.toContain('description: PDF work'); // front matter stripped
  });

  it('the skill tool loads by name and names the available ones otherwise', async () => {
    const root = tmp('tool');
    skill(root, 'pdf', 'name: pdf\ndescription: PDF work', 'PDF steps');
    const s = { name: 'pdf', description: 'PDF work', dir: join(root, 'pdf'), file: join(root, 'pdf', 'SKILL.md'), source: 'global' as const };
    const t = skillTools({ skills: async () => [s] } as never).skill as unknown as { execute: (i: object, o: object) => Promise<string> };
    expect(await t.execute({ name: 'PDF' }, {})).toContain('PDF steps');
    await expect(t.execute({ name: 'nope' }, {})).rejects.toThrow(/No skill "nope". Available: pdf/);
  });

  it('runs as /<name>, never shadowing built-in commands', async () => {
    const root = tmp('cmd');
    skill(root, 'pdf', 'name: pdf\ndescription: PDF work', 'PDF steps');
    skill(root, 'help', 'name: help\ndescription: would shadow /help', 'x');
    const mk = (name: string) => ({ name, description: '', dir: join(root, name), file: join(root, name, 'SKILL.md'), source: 'global' as const });
    const cmds = await loadCommands(tmp('cwd'), [mk('pdf'), mk('help')]);
    const pdf = cmds.find((c) => c.name === 'pdf')!;
    expect((await pdf.run({} as never, 'merge a.pdf b.pdf')).prompt).toMatch(/PDF steps[\s\S]*## Arguments\nmerge a\.pdf b\.pdf/);
    expect(cmds.find((c) => c.name === 'help')!.description).toBe('list commands');
  });
});

describe('install and new', () => {
  it('installs from a folder or a git repository, without overwriting', async () => {
    const src = tmp('src');
    skill(join(src, 'skills'), 'alpha', 'name: alpha\ndescription: a', 'A', { 'run.sh': 'echo a' });
    skill(join(src, 'skills'), 'beta', 'name: beta\ndescription: b');
    const target = join(tmp('target'), 'skills');
    expect(await installSkills(src, target)).toEqual({ installed: ['alpha', 'beta'], skipped: [] });
    expect(readFileSync(join(target, 'alpha', 'run.sh'), 'utf8')).toBe('echo a');
    expect(await installSkills(src, target)).toEqual({ installed: [], skipped: ['alpha', 'beta'] });
    // A git repository with one skill at its root (cloned through file://).
    const repo = tmp('repo');
    writeFileSync(join(repo, 'SKILL.md'), '---\nname: gamma\ndescription: g\n---\nG\n');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'init', '--allow-empty'], { cwd: repo });
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'skill'], { cwd: repo });
    expect((await installSkills(`file://${repo}/.git`, target)).installed).toEqual(['gamma']);
    expect(existsSync(join(target, 'gamma', '.git'))).toBe(false);
    await expect(installSkills(tmp('empty'), target)).rejects.toThrow(/No SKILL.md found/);
  });

  it('creates a skill to fill in', async () => {
    const target = join(tmp('new'), 'skills');
    const file = await createSkill('My Skill', target);
    expect(file).toBe(join(target, 'my-skill', 'SKILL.md'));
    expect(parseSkillFile(readFileSync(file, 'utf8')).meta.name).toBe('my-skill');
    await expect(createSkill('my-skill', target)).rejects.toThrow(/already exists/);
  });
});

describe('project trust', () => {
  it('asks before using the project\'s own skills, and again when they change', async () => {
    const cwd = tmp('trust');
    expect((await projectTrust(cwd)).needed).toBe(false);
    skill(join(cwd, '.claude', 'skills'), 'deploy', 'name: deploy\ndescription: ships to prod');
    const t = await projectTrust(cwd);
    expect(t.needed).toBe(true);
    expect(t.summary).toContain('skill "deploy" (.claude/skills): ships to prod');
    expect((await projectSkills(cwd)).skills.map((s) => s.name)).toEqual(['deploy']);
    writeFileSync(join(cwd, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: changed\n---\n');
    expect((await projectTrust(cwd)).hash).not.toBe(t.hash);
  });
});
