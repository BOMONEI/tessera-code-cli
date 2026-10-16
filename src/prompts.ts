import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GLOBAL_INSTRUCTIONS } from './config.js';

/**
 * Prompts added with /prompt, kept in TESSERA.md files the user can also edit by hand:
 * - global: ~/.tessera-code/TESSERA.md, applied in every project;
 * - project: <project>/.tessera/TESSERA.md, applied in that project only. Kept under .tessera/ so it never shadows
 *   a TESSERA.md, AGENTS.md or CLAUDE.md the project has at its root.
 * Added prompts live as bullets under one heading; anything else in the file is left exactly as it is.
 */
export type PromptScope = 'global' | 'project';

export const SECTION = '## Added with /prompt';

export function promptFile(scope: PromptScope, cwd: string): string {
  return scope === 'global' ? GLOBAL_INSTRUCTIONS : join(cwd, '.tessera', 'TESSERA.md');
}

/** The section's bullets ("- text", continuation lines indented by two spaces) and where the section starts/ends. */
function parse(content: string): { items: string[]; start: number; end: number } | undefined {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => l.trim() === SECTION);
  if (start < 0) return undefined;
  let end = lines.findIndex((l, i) => i > start && /^#{1,2} /.test(l));
  if (end < 0) end = lines.length;
  const items: string[] = [];
  for (const line of lines.slice(start + 1, end)) {
    if (line.startsWith('- ')) items.push(line.slice(2));
    else if (line.startsWith('  ') && items.length) items[items.length - 1] += '\n' + line.slice(2);
  }
  return { items, start, end };
}

/** Prompts added to the file, in order (empty when the file or the section does not exist). */
export async function listPrompts(file: string): Promise<string[]> {
  if (!existsSync(file)) return [];
  return parse(await readFile(file, 'utf8'))?.items ?? [];
}

function render(items: string[]): string[] {
  return [SECTION, '', ...items.map((t) => `- ${t.trim().split('\n').join('\n  ')}`)];
}

async function save(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  // The global file is the user's own (like config.json); a project's file belongs with the project.
  await writeFile(file, content, file === GLOBAL_INSTRUCTIONS ? { mode: 0o600 } : {});
}

async function rewrite(file: string, update: (items: string[]) => string[]): Promise<string[]> {
  const content = existsSync(file) ? await readFile(file, 'utf8') : '';
  const parsed = parse(content);
  const items = update(parsed?.items ?? []);
  const lines = content.split('\n');
  let next: string[];
  if (parsed) {
    next = [...lines.slice(0, parsed.start), ...(items.length ? render(items) : []), ...lines.slice(parsed.end)];
  } else {
    next = content.trim() ? [content.replace(/\s+$/, ''), '', ...render(items)] : render(items);
  }
  await save(file, next.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n'));
  return items;
}

export async function addPrompt(file: string, text: string): Promise<number> {
  const clean = text.trim();
  if (!clean) throw new Error('The prompt is empty.');
  const items = await rewrite(file, (items) => [...items, clean]);
  return items.length;
}

/** Removes the n-th (1-based) added prompt and returns its text. */
export async function removePrompt(file: string, n: number): Promise<string> {
  const current = await listPrompts(file);
  if (!Number.isInteger(n) || n < 1 || n > current.length) throw new Error(`There is no prompt ${n} (${current.length ? `1-${current.length}` : 'none added'}).`);
  await rewrite(file, (items) => items.filter((_, i) => i !== n - 1));
  return current[n - 1]!;
}
