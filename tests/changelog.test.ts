import { describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME_DIR } from '../src/config.js';
import { changelogPath, compareVersions, countChanges, markChangelogSeen, parseChangelog, readChangelog, sectionsSince, whatsNew } from '../src/changelog.js';
import { VERSION } from '../src/version.js';

const STATE = join(HOME_DIR, 'state.json');
const MD = `# Changelog

## 0.3.0 — 2026-11-01

### Added
- Feature C

## 0.2.1 — 2026-10-14

### Fixed
- Bug B
- Bug B2

## 0.2.0 — 2026-10-14

- Feature A
`;

describe('changelog parsing', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('v0.2.1', '0.2.1')).toBe(0);
    expect(compareVersions('0.2.0', '0.2.1')).toBeLessThan(0);
  });

  it('splits sections and picks those after the last seen version up to the current one', () => {
    const sections = parseChangelog(MD);
    expect(sections.map((s) => s.version)).toEqual(['0.3.0', '0.2.1', '0.2.0']);
    expect(sections[1]!.markdown).toMatch(/^## 0\.2\.1[\s\S]*Bug B2$/);
    const since = sectionsSince(sections, '0.2.0', '0.2.1');
    expect(since.map((s) => s.version)).toEqual(['0.2.1']); // 0.3.0 is newer than the running version
    expect(countChanges(sectionsSince(sections, '0.1.0', '0.3.0'))).toBe(4);
  });

  it('ships a CHANGELOG with a section for the running version', async () => {
    expect(changelogPath()).toBeDefined();
    expect((await readChangelog()).some((s) => s.version === VERSION)).toBe(true);
  });
});

describe('whatsNew (first run after an update)', () => {
  it('records the version on a first install without showing anything', async () => {
    rmSync(STATE, { force: true });
    expect(await whatsNew(VERSION)).toBeUndefined();
    expect(JSON.parse(readFileSync(STATE, 'utf8')).lastSeenVersion).toBe(VERSION);
  });

  it('shows the notes once after an update, then not again', async () => {
    writeFileSync(STATE, JSON.stringify({ lastSeenVersion: '0.0.1' }));
    const news = await whatsNew(VERSION);
    expect(news?.from).toBe('0.0.1');
    expect(news?.sections[0]?.version).toBe(VERSION);
    expect(news!.count).toBeGreaterThan(0);
    await markChangelogSeen(VERSION);
    expect(await whatsNew(VERSION)).toBeUndefined();
  });

  it('ignores downgrades and unreadable state', async () => {
    writeFileSync(STATE, JSON.stringify({ lastSeenVersion: '99.0.0' }));
    expect(await whatsNew(VERSION)).toBeUndefined();
    writeFileSync(STATE, '{not json');
    expect(await whatsNew(VERSION)).toBeUndefined(); // treated as a first install
    rmSync(STATE, { force: true });
  });
});
