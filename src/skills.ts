import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';

/**
 * Skills: folders holding a SKILL.md (front matter `name` and `description`, then instructions) plus any scripts or
 * reference files it uses — the Agent Skills format Claude Code uses, so its skills work here too.
 *
 * The model sees one line per skill (name: description) and loads a skill's instructions with the skill tool when a
 * task calls for it; `/<name> [args]` runs one directly.
 */
export type SkillSource = 'project' | 'global' | 'claude-project' | 'claude';

export interface Skill {
  name: string;
  description: string;
  /** The skill folder (scripts and references are relative to it). */
  dir: string;
  file: string;
  source: SkillSource;
}

export interface SkillRoots {
  /** ~/.tessera-code */
  home: string;
  cwd: string;
  /** Whether the project's own skills (.tessera/skills, .claude/skills) may be used: the user trusted the project. */
  projectTrusted: boolean;
  /** Folder holding Claude's user skills; defaults to ~/.claude. */
  claudeHome?: string;
}

/** Folders searched, highest priority first; on a name clash the first one wins. */
export function skillDirs(roots: SkillRoots): Array<{ dir: string; source: SkillSource }> {
  const claude = roots.claudeHome ?? join(homedir(), '.claude');
  return [
    ...(roots.projectTrusted ? [{ dir: join(roots.cwd, '.tessera', 'skills'), source: 'project' as const }] : []),
    { dir: join(roots.home, 'skills'), source: 'global' as const },
    ...(roots.projectTrusted ? [{ dir: join(roots.cwd, '.claude', 'skills'), source: 'claude-project' as const }] : []),
    { dir: join(claude, 'skills'), source: 'claude' as const },
  ];
}

/** `---` front matter: `key: value` lines, quoted values, and `>` / `|` blocks of indented lines. */
export function parseSkillFile(content: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return { meta: {}, body: content.trim() };
  const meta: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (/^[>|][-+]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1] === '')) block.push(lines[++i]!.trim());
      value = value.startsWith('>') ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim();
    } else if (/^(["']).*\1$/.test(value)) {
      value = value.slice(1, -1);
    }
    meta[kv[1]!.toLowerCase()] = value;
  }
  return { meta, body: content.slice(m[0].length).trim() };
}

/** Lowercase letters, digits, "-", "_" and ":" — usable as /<name>. */
export function skillName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_:-]/g, '');
}

/** Skills directly inside `dir` (each subfolder with a SKILL.md). */
export async function readSkillsIn(dir: string, source: SkillSource): Promise<Skill[]> {
  if (!existsSync(dir)) return [];
  const skills: Skill[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillDir = join(dir, entry.name);
    const file = join(skillDir, 'SKILL.md');
    if (!existsSync(file)) continue;
    try {
      const { meta } = parseSkillFile(await readFile(file, 'utf8'));
      const name = skillName(meta.name || entry.name);
      if (name) skills.push({ name, description: meta.description ?? '', dir: skillDir, file, source });
    } catch {
      // unreadable skill: skip it rather than break startup
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** All usable skills, one per name (see skillDirs for the order). */
export async function discoverSkills(roots: SkillRoots): Promise<Skill[]> {
  const byName = new Map<string, Skill>();
  for (const { dir, source } of skillDirs(roots)) {
    for (const s of await readSkillsIn(dir, source)) if (!byName.has(s.name)) byName.set(s.name, s);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The project's own skills, for the trust prompt: names, descriptions and a hash of their SKILL.md files. */
export async function projectSkills(cwd: string): Promise<{ skills: Skill[]; hash: string }> {
  const skills = [...(await readSkillsIn(join(cwd, '.tessera', 'skills'), 'project')), ...(await readSkillsIn(join(cwd, '.claude', 'skills'), 'claude-project'))];
  const h = createHash('sha256');
  for (const s of skills) h.update(`${s.name}\0${await readFile(s.file, 'utf8')}\0`);
  return { skills, hash: skills.length ? h.digest('hex') : '' };
}

const MAX_LISTED_FILES = 40;

/** Files of a skill folder besides SKILL.md (relative paths), so the model knows what it can read or run. */
async function skillFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (out.length >= MAX_LISTED_FILES) return;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 3) await walk(p, depth + 1);
      } else if (relative(dir, p) !== 'SKILL.md') out.push(relative(dir, p));
    }
  };
  await walk(dir, 0);
  return out.sort();
}

/** The text the model gets for a skill: its instructions, where it lives, its other files and the arguments. */
export async function skillPrompt(skill: Skill, args?: string): Promise<string> {
  const { body } = parseSkillFile(await readFile(skill.file, 'utf8'));
  const files = await skillFiles(skill.dir);
  const isLarge = (await stat(skill.file)).size > 200_000;
  const head = [`# Skill: ${skill.name}`, `Skill folder: ${skill.dir} (paths in these instructions are relative to it).`];
  if (files.length) head.push(`Files: ${files.join(', ')}${files.length >= MAX_LISTED_FILES ? ', …' : ''}`);
  const parts = [head.join('\n'), isLarge ? `${body.slice(0, 200_000)}\n\n[SKILL.md truncated; read ${skill.file} for the rest]` : body];
  if (args?.trim()) parts.push(`## Arguments\n${args.trim()}`);
  return parts.join('\n\n');
}

/** The system prompt's skill list (empty when there are none). */
export function skillsSection(skills: Skill[]): string {
  if (!skills.length) return '';
  const lines = skills.slice(0, 100).map((s) => `- ${s.name}: ${(s.description || '(no description)').replace(/\s+/g, ' ').slice(0, 300)}`);
  return [
    '# Skills',
    'Skills are packaged instructions (often with scripts) for specific kinds of tasks. When a task matches a skill, call the skill tool with its name first and follow what it says.',
    ...lines,
  ].join('\n');
}

/** Where `/skill install|new` puts a skill: ~/.tessera-code/skills or <project>/.tessera/skills. */
export function skillTarget(scope: 'global' | 'project', roots: { home: string; cwd: string }): string {
  return scope === 'global' ? join(roots.home, 'skills') : join(roots.cwd, '.tessera', 'skills');
}

export function isGitUrl(source: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/)/.test(source) || /\.git$/.test(source);
}

function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { cwd, timeout: 120_000 }, (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().split('\n').pop())) : resolve())),
  );
}

/** Skill folders in a downloaded or local source: the folder itself, or each subfolder (or skills/ subfolder) with a SKILL.md. */
async function findSkillFolders(root: string): Promise<string[]> {
  if (existsSync(join(root, 'SKILL.md'))) return [root];
  const found: string[] = [];
  for (const base of [root, join(root, 'skills')]) {
    if (!existsSync(base)) continue;
    for (const e of await readdir(base, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(base, e.name, 'SKILL.md'))) found.push(join(base, e.name));
    }
  }
  return found;
}

/**
 * Installs the skills in `source` (a local folder, or a git URL cloned shallowly) into `targetDir`. Existing skills
 * are never overwritten. Returns the installed names and the ones skipped because they exist.
 */
export async function installSkills(source: string, targetDir: string): Promise<{ installed: string[]; skipped: string[] }> {
  const work = await mkdtemp(join(tmpdir(), 'tessera-skill-'));
  try {
    let root = source;
    if (isGitUrl(source)) {
      root = join(work, 'src');
      await run('git', ['clone', '--depth', '1', '--quiet', source, root]);
    } else if (!existsSync(source)) {
      throw new Error(`${source} does not exist.`);
    }
    const folders = await findSkillFolders(root);
    if (!folders.length) throw new Error(`No SKILL.md found in ${source} (looked at its root, */SKILL.md and skills/*/SKILL.md).`);
    await mkdir(targetDir, { recursive: true });
    const installed: string[] = [];
    const skipped: string[] = [];
    for (const folder of folders) {
      const { meta } = parseSkillFile(await readFile(join(folder, 'SKILL.md'), 'utf8'));
      const name = skillName(meta.name || basename(folder));
      if (!name) continue;
      const dest = join(targetDir, name);
      if (existsSync(dest)) {
        skipped.push(name);
        continue;
      }
      await cp(folder, dest, { recursive: true, filter: (src) => basename(src) !== '.git' });
      installed.push(name);
    }
    return { installed, skipped };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** A new skill folder with a SKILL.md to fill in; returns its path. */
export async function createSkill(name: string, targetDir: string): Promise<string> {
  const clean = skillName(name);
  if (!clean) throw new Error('Give the skill a name: letters, digits, "-" or "_".');
  const dir = join(targetDir, clean);
  if (existsSync(dir)) throw new Error(`A skill "${clean}" already exists at ${dir}.`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${clean}\ndescription: What this skill does and when to use it (the model decides from this line).\n---\n\n# ${clean}\n\nStep-by-step instructions. Put scripts or reference files next to this file and mention them by relative path.\n`,
  );
  return join(dir, 'SKILL.md');
}
