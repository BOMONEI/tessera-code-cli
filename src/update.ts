import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions } from './changelog.js';

/** The public repository whose GitHub Releases carry the installable package (see install.sh). */
export const RELEASE_REPO = process.env.TESSERA_REPO ?? 'BOMONEI/tessera-code-cli';

/**
 * The newest released version. /releases/latest redirects to /releases/tag/vX.Y.Z, which needs no GitHub API call
 * (and so no API rate limit).
 */
export async function latestVersion(fetchFn: typeof fetch = fetch): Promise<string> {
  const r = await fetchFn(`https://github.com/${RELEASE_REPO}/releases/latest`, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  const tag = new URL(r.url).pathname.split('/').pop() ?? '';
  if (!r.ok || !/^v\d+\.\d+\.\d+/.test(tag)) throw new Error(`no release found at https://github.com/${RELEASE_REPO}/releases`);
  return tag.slice(1);
}

/** The folder holding package.json, from src/ (dev) or dist/bundle/ (built). */
function packageRoot(): string | undefined {
  for (let dir = dirname(fileURLToPath(import.meta.url)); dirname(dir) !== dir; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  return undefined;
}

/**
 * True when running from a source checkout (git clone + `npm link`) rather than an installed release. Installing
 * the release package over it would replace the link, so such a checkout is updated with git instead.
 */
export function isSourceCheckout(root = packageRoot()): boolean {
  return root !== undefined && existsSync(join(root, 'src', 'cli.ts'));
}

/** The SHA-256 listed for `file` in a SHA256SUMS file ("<hash>  <name>" or "<hash> *<name>" lines). */
export function expectedSha256(sums: string, file: string): string | undefined {
  for (const line of sums.split('\n')) {
    const [hash, name] = line.trim().split(/\s+\*?/);
    if (name === file && /^[0-9a-f]{64}$/i.test(hash ?? '')) return hash!.toLowerCase();
  }
  return undefined;
}

async function download(url: string, fetchFn: typeof fetch): Promise<string> {
  const r = await fetchFn(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`download failed (HTTP ${r.status}): ${url}`);
  return r.text();
}

export interface UpdateIo {
  write: (text: string) => void;
  fetch?: typeof fetch;
  /** Runs the release's installer; resolves with its exit code. */
  runInstaller?: (script: string, version: string) => Promise<number>;
  sourceCheckout?: boolean;
}

/** Runs install.sh with bash, pinned to `version`, its output going straight to the terminal. */
async function runInstallerScript(script: string, version: string): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-update-'));
  try {
    const file = join(dir, 'install.sh');
    await writeFile(file, script, { mode: 0o700 });
    return await new Promise<number>((resolve, reject) => {
      const child = spawn('bash', [file], { stdio: 'inherit', env: { ...process.env, TESSERA_VERSION: version } });
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 1));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * `tessera-code update [--check]`: compares this version with the latest release and, when newer, runs that
 * release's install.sh (checked against the release's SHA256SUMS) for the new version. Returns the exit code.
 */
export async function runUpdate(current: string, opts: { check?: boolean }, io: UpdateIo): Promise<number> {
  const fetchFn = io.fetch ?? fetch;
  const latest = await latestVersion(fetchFn);
  if (compareVersions(latest, current) <= 0) {
    io.write(`tessera-code ${current} is up to date (latest release: ${latest}).\n`);
    return 0;
  }
  io.write(`Update available: ${current} → ${latest}\n`);
  if (opts.check) {
    io.write('Run `tessera-code update` to install it.\n');
    return 0;
  }
  if (io.sourceCheckout ?? isSourceCheckout()) {
    io.write(
      'This tessera-code runs from a source checkout (npm link), so it is not replaced by the release package.\n' +
        `Update it there: cd ${packageRoot()} && git pull && npm ci && npm run build\n`,
    );
    return 1;
  }
  const base = `https://github.com/${RELEASE_REPO}/releases/download/v${latest}`;
  const [script, sums] = await Promise.all([download(`${base}/install.sh`, fetchFn), download(`${base}/SHA256SUMS`, fetchFn)]);
  const expected = expectedSha256(sums, 'install.sh');
  const actual = createHash('sha256').update(script).digest('hex');
  if (!expected || expected !== actual) throw new Error(`install.sh of ${latest} does not match its SHA256SUMS; nothing was changed.`);
  const code = await (io.runInstaller ?? runInstallerScript)(script, latest);
  if (code !== 0) return code;
  io.write(`\nUpdated ${current} → ${latest}. The next start shows what changed (or run /changelog).\n`);
  return 0;
}
