import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME_DIR } from './config.js';

/** App state that is not a user setting (config.json is for the user to edit). */
const STATE_FILE = join(HOME_DIR, 'state.json');

export interface ChangelogSection {
  version: string;
  /** The section's markdown, heading included. */
  markdown: string;
}

/** Numeric x.y.z comparison (a pre-release suffix is ignored); negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, '').split(/[-+]/)[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Splits CHANGELOG.md at its "## x.y.z" headings. */
export function parseChangelog(md: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let current: { version: string; lines: string[] } | undefined;
  for (const line of md.split('\n')) {
    const heading = /^##\s+v?(\d+\.\d+\.\d+\S*)/.exec(line);
    if (heading) {
      if (current) sections.push({ version: current.version, markdown: current.lines.join('\n').trim() });
      current = { version: heading[1]!, lines: [line] };
    } else current?.lines.push(line);
  }
  if (current) sections.push({ version: current.version, markdown: current.lines.join('\n').trim() });
  return sections;
}

/** Sections newer than `seen` up to and including `current`, newest first. */
export function sectionsSince(sections: ChangelogSection[], seen: string, current: string): ChangelogSection[] {
  return sections.filter((s) => compareVersions(s.version, seen) > 0 && compareVersions(s.version, current) <= 0);
}

/** Top-level bullet points: the "N changes" in the one-line notice. */
export function countChanges(sections: ChangelogSection[]): number {
  return sections.reduce((n, s) => n + s.markdown.split('\n').filter((l) => /^[-*]\s/.test(l)).length, 0);
}

/** The packaged CHANGELOG.md, found from src/ (dev) or dist/bundle/ (built). */
export function changelogPath(): string | undefined {
  return ['../CHANGELOG.md', '../../CHANGELOG.md'].map((rel) => fileURLToPath(new URL(rel, import.meta.url))).find((p) => existsSync(p));
}

export async function readChangelog(): Promise<ChangelogSection[]> {
  const path = changelogPath();
  if (!path) return [];
  try {
    return parseChangelog(await readFile(path, 'utf8'));
  } catch {
    return [];
  }
}

/** ~/.tessera-code/state.json (release notes seen, update check); {} when absent or unreadable. */
export async function readState(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Merges `patch` into state.json (atomic write; other processes may read it at the same time). */
export async function updateState(patch: Record<string, unknown>): Promise<void> {
  const state = await readState();
  await mkdir(HOME_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...state, ...patch }, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, STATE_FILE);
}

/** Remembers that `version`'s changes were shown. */
export async function markChangelogSeen(version: string): Promise<void> {
  if ((await readState()).lastSeenVersion === version) return;
  await updateState({ lastSeenVersion: version });
}

export interface WhatsNew {
  version: string;
  /** The version seen before this update. */
  from: string;
  sections: ChangelogSection[];
  count: number;
}

/**
 * What changed since the version last seen, when this is the first run after an update. A first install (nothing
 * seen yet) only records the version: a changelog means nothing before the first use. Never throws.
 */
export async function whatsNew(current: string): Promise<WhatsNew | undefined> {
  try {
    const seen = (await readState()).lastSeenVersion;
    if (typeof seen !== 'string') {
      await markChangelogSeen(current);
      return undefined;
    }
    if (compareVersions(current, seen) <= 0) return undefined; // same version, or a downgrade
    const sections = sectionsSince(await readChangelog(), seen, current);
    if (!sections.length) {
      await markChangelogSeen(current); // nothing documented for this update
      return undefined;
    }
    return { version: current, from: seen, sections, count: countChanges(sections) };
  } catch {
    return undefined; // the notice is a convenience; startup must not fail over it
  }
}
