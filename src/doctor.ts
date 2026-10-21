import { access, constants, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { App } from './app.js';
import { BASE_URL, HOME_DIR } from './config.js';
import { findModel, modelIsZdr } from './providers/catalog.js';
import { apiFetch } from './providers/net.js';

export interface Check {
  ok: boolean | 'warn';
  name: string;
  detail: string;
}

function has(cmd: string): boolean {
  try {
    execFileSync('/bin/sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Environment checks for /doctor. One request to the models endpoint verifies network and API key (no model usage). */
export async function runDoctor(app: App): Promise<Check[]> {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({ ok: major >= 20, name: 'Node.js', detail: `v${process.versions.node}${major >= 20 ? '' : ' (20+ required)'}` });

  const started = Date.now();
  if (!app.agent.apiKey) checks.push({ ok: false, name: 'OpenCode Go API', detail: 'no API key registered — run /auth <key>' });
  else try {
    const r = await apiFetch(`${BASE_URL}/models`, { headers: { authorization: `Bearer ${app.agent.apiKey}` }, signal: AbortSignal.timeout(10_000) });
    const ms = Date.now() - started;
    if (r.ok) checks.push({ ok: true, name: 'OpenCode Go API', detail: `reachable, key accepted (${ms} ms) · key from ${app.apiKeySource}` });
    else checks.push({ ok: false, name: 'OpenCode Go API', detail: `HTTP ${r.status}${r.status === 401 ? ' — the API key was rejected (register another with /auth <key>)' : ''} · key from ${app.apiKeySource}` });
  } catch (e) {
    checks.push({ ok: false, name: 'OpenCode Go API', detail: `unreachable: ${(e as Error).message}` });
  }

  const chain = [app.agent.model, ...app.fallbackModels.map((id) => findModel(app.catalog, id))];
  const nonZdr = chain.filter((m) => !modelIsZdr(m)).map((m) => m.id);
  // Another provider's non-ZDR model is the user's choice (warned about), so it is a warning, not a failure.
  checks.push({ ok: nonZdr.length ? 'warn' : true, name: 'Models (ZDR)', detail: `${chain.map((m) => m.id).join(' → ')}${nonZdr.length ? ` · not ZDR: ${nonZdr.join(', ')}` : ''}` });

  const catalogFile = join(HOME_DIR, 'cache', 'models.json');
  const age = existsSync(catalogFile) ? (Date.now() - statSync(catalogFile).mtimeMs) / 3_600_000 : undefined;
  checks.push({ ok: app.catalog.length > 0, name: 'Model catalog', detail: `${app.catalog.length} models${age !== undefined ? `, cached ${age.toFixed(1)}h ago` : ''}` });

  try {
    await mkdir(HOME_DIR, { recursive: true });
    await access(HOME_DIR, constants.W_OK);
    checks.push({ ok: true, name: 'Data directory', detail: `${HOME_DIR} writable` });
  } catch {
    checks.push({ ok: false, name: 'Data directory', detail: `${HOME_DIR} is not writable` });
  }

  let git = 'not a git repository';
  try {
    git = `branch ${execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: app.ctx.cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()}`;
  } catch {
    // not a repository
  }
  checks.push({ ok: has('git') ? true : 'warn', name: 'git', detail: has('git') ? git : 'git not installed (file list and branch info disabled)' });

  const settings = join(app.ctx.cwd, '.tessera', 'settings.json');
  checks.push({
    ok: existsSync(settings) && !app.projectTrusted ? 'warn' : true,
    name: 'Project settings',
    detail: existsSync(settings) ? `.tessera/settings.json${app.projectTrusted ? '' : ' (hooks/MCP/allow ignored: not trusted)'}` : 'none',
  });

  await app.mcpReady;
  for (const s of app.mcpStatus) checks.push({ ok: s.ok, name: `MCP ${s.name}`, detail: s.ok ? `${s.tools.length} tools` : s.error ?? 'failed' });
  for (const w of app.warnings) checks.push({ ok: 'warn', name: 'Config', detail: w });

  const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM ?? '');
  checks.push({ ok: truecolor ? true : 'warn', name: 'Terminal', detail: `${process.env.TERM_PROGRAM ?? process.env.TERM ?? 'unknown'} ${process.stdout.columns ?? '?'}×${process.stdout.rows ?? '?'}${truecolor ? ', truecolor' : ', no truecolor (icon colors approximated)'}` });

  const clip = process.platform === 'darwin' ? has('pbcopy') : has('wl-copy') || has('xclip') || has('xsel');
  checks.push({ ok: clip ? true : 'warn', name: 'Clipboard', detail: clip ? 'available for /copy' : 'no clipboard tool; /copy falls back to OSC 52' });

  checks.push(copyOnSelect());

  const editor = process.env.VISUAL ?? process.env.EDITOR;
  checks.push({ ok: editor ? true : 'warn', name: 'Editor (ctrl+g)', detail: editor ?? '$EDITOR not set; using vi' });
  return checks;
}

/**
 * Copying output by dragging over it is the terminal's job: printed output lives in the terminal's scrollback,
 * where the app cannot see the selection. Reports whether this terminal copies a selection by itself.
 */
export function copyOnSelect(env = process.env, home = homedir()): Check {
  const name = 'Copy on select';
  switch (env.TERM_PROGRAM) {
    case 'vscode': {
      const dirs = ['Code', 'Code - Insiders', 'Cursor', 'VSCodium'].map((d) => join(home, 'Library', 'Application Support', d, 'User', 'settings.json'));
      const on = dirs.some((f) => {
        try {
          return /"terminal\.integrated\.copyOnSelection"\s*:\s*true/.test(readFileSync(f, 'utf8'));
        } catch {
          return false;
        }
      });
      return on
        ? { ok: true, name, detail: 'VS Code copies dragged selections' }
        : { ok: 'warn', name, detail: 'VS Code: set "terminal.integrated.copyOnSelection": true to copy by dragging (or cmd+c, /copy)' };
    }
    case 'iTerm.app':
      return { ok: true, name, detail: 'iTerm2 copies selections (Settings → General → Selection)' };
    case 'ghostty':
    case 'WezTerm':
      return { ok: true, name, detail: `${env.TERM_PROGRAM} copies selections by default` };
    case 'Apple_Terminal':
      return { ok: 'warn', name, detail: 'Terminal.app cannot copy on select; use cmd+c after selecting, or /copy' };
    default:
      return { ok: 'warn', name, detail: 'depends on the terminal; use its copy key after selecting, or /copy' };
  }
}

export function formatChecks(checks: Check[]): string {
  return checks.map((c) => `${c.ok === true ? '✓' : c.ok === 'warn' ? '!' : '✗'} ${c.name.padEnd(18)} ${c.detail}`).join('\n');
}
