import { chmod, readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { HooksConfig } from './hooks.js';
import { projectSkills } from './skills.js';
import type { PermissionMode } from './permissions.js';

export const HOME_DIR = process.env.TESSERA_HOME ?? join(homedir(), '.tessera-code');
export const BASE_URL = process.env.TESSERA_BASE_URL ?? 'https://opencode.ai/zen/go/v1';
export const DEFAULT_MODEL = 'mimo-v2.6-flash';
// ZDR fallbacks on upstreams independent of MiMo, so a stalled MiMo backend does not stall the fallback too.
// See README "Fallback".
export const DEFAULT_FALLBACK = ['glm-5.3-flash', 'qwen3.8-flash'];

export interface Config {
  model: string;
  /** Upper bound on agent steps (LLM calls) per user turn. */
  maxSteps: number;
  /** Context cap in tokens; history is compacted automatically (before or during a turn) to stay under it.
   *  Also capped at 80% of the smallest model window in the fallback chain. */
  contextLimit: number;
  /** Persistent tool permission rules, e.g. "bash(npm test)" or "edit". */
  allow: string[];
  mcpServers: Record<string, McpServerConfig>;
  hooks: HooksConfig;
  /** Retry a call on the next model when the current one returns an error. Only ZDR models are used. */
  fallback: FallbackConfig;
  /** Let reasoning models think before answering (slower, more accurate). Toggle at runtime with ctrl+t or /think. */
  thinking: boolean;
  /** How hard to think when thinking is on. Sent explicitly: the model's own default was measured slower. */
  thinkingLevel: ThinkingLevel;
  /** Show the model's thinking in the TUI (streamed live, then folded into one line). Toggle with /think show|hide. */
  showThinking: boolean;
  /** Permission mode at startup: default (ask), acceptEdits (alias "edit"), plan (read-only) or bypass (never ask). */
  permissionMode: PermissionMode;
  /** Notify (bell + desktop notification) when a turn took at least this many seconds; 0 disables. */
  notifyAfterSeconds: number;
  /** Check GitHub Releases (at most once a day) and say when a newer version is out. */
  updateCheck: boolean;
  /** Let the agent delegate tasks to subagents (the task tool), one at a time. */
  subagents: boolean;
  /** Let several subagents run in parallel (implies subagents). Both false: a single agent only. */
  multiAgent: boolean;
}

export interface FallbackConfig {
  /** Tried in order after the main model. */
  models: string[];
  /** Optional: no output (text, thinking or tool call) within this time also triggers the next model. 0 = off. */
  firstTokenTimeoutMs: number;
  /** After falling back, keep using the fallback model this long before retrying the main model. */
  stickyMs: number;
}

export const THINKING_LEVELS = ['low', 'medium', 'high'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypass', 'dangerous'];

/**
 * A local (stdio) or remote (HTTP) MCP server. `type` ("local" | "remote") is accepted for opencode-style entries and
 * otherwise implied by command/url; `"enabled": false` turns a server off, including a built-in one.
 */
export type McpServerConfig = { type?: 'local' | 'remote'; enabled?: boolean } & (
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { url: string; headers?: Record<string, string> }
);

/** MCP servers every install has (web search). Listed in config.json; "enabled": false there turns one off. */
export const DEFAULT_MCP_SERVERS: Record<string, McpServerConfig> = {
  exa: { type: 'remote', url: 'https://mcp.exa.ai/mcp', enabled: true },
};

const DEFAULTS: Config = {
  model: DEFAULT_MODEL,
  maxSteps: 50,
  contextLimit: 500_000,
  allow: [],
  mcpServers: {},
  hooks: {},
  thinking: true,
  thinkingLevel: 'medium',
  showThinking: true,
  permissionMode: 'default',
  notifyAfterSeconds: 20,
  updateCheck: true,
  subagents: false,
  multiAgent: false,
  fallback: { models: DEFAULT_FALLBACK, firstTokenTimeoutMs: 0, stickyMs: 5 * 60_000 },
};

async function readJson(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    throw new Error(`Invalid JSON in ${path}: ${(e as Error).message}`);
  }
}

export const GLOBAL_CONFIG = join(HOME_DIR, 'config.json');

export function projectConfigPath(cwd: string): string {
  return join(cwd, '.tessera', 'settings.json');
}

/** Project settings keys that can run code or widen permissions; ignored until the user trusts the project. */
const PRIVILEGED_KEYS = ['hooks', 'mcpServers', 'allow', 'permissionMode'] as const;
const TRUST_FILE = join(HOME_DIR, 'trusted-projects.json');

function hashOf(json: Record<string, unknown>): string {
  const privileged = Object.fromEntries(PRIVILEGED_KEYS.map((k) => [k, json[k]]));
  return createHash('sha256').update(JSON.stringify(privileged)).digest('hex');
}

function hasPrivileged(json: Record<string, unknown>): boolean {
  return PRIVILEGED_KEYS.some((k) => json[k] !== undefined && JSON.stringify(json[k]) !== '{}' && JSON.stringify(json[k]) !== '[]');
}

export interface ProjectTrust {
  /** True when the project settings contain privileged keys the user has not approved in their current form. */
  needed: boolean;
  /** Human-readable summary of what would be enabled. */
  summary: string;
  /** Hash of exactly the settings summarized; pass it to trustProject so later edits are not trusted. */
  hash: string;
}

/**
 * Trust is keyed by project path and a hash of the privileged settings and the project's own skills
 * (.tessera/skills, .claude/skills: instructions and scripts from the repository), so any change asks again.
 */
export async function projectTrust(cwd: string): Promise<ProjectTrust> {
  const project = await readJson(projectConfigPath(cwd));
  const { skills, hash: skillsHash } = await projectSkills(cwd);
  // Without skills the hash is the settings hash alone, as before, so earlier trust decisions still hold.
  const hash = skills.length ? createHash('sha256').update(hashOf(project) + skillsHash).digest('hex') : hashOf(project);
  if (!hasPrivileged(project) && !skills.length) return { needed: false, summary: '', hash };
  const trusted = await readJson(TRUST_FILE);
  if (trusted[cwd] === hash) return { needed: false, summary: '', hash };
  const lines: string[] = [];
  for (const s of skills) lines.push(`skill "${s.name}" (${s.source === 'project' ? '.tessera' : '.claude'}/skills): ${s.description.replace(/\s+/g, ' ').slice(0, 100)}`);
  const mcp = (project.mcpServers ?? {}) as Record<string, McpServerConfig>;
  for (const [name, cfg] of Object.entries(mcp)) lines.push(`MCP server "${name}": ${'url' in cfg ? cfg.url : [cfg.command, ...(cfg.args ?? [])].join(' ')}`);
  for (const [event, hooks] of Object.entries((project.hooks ?? {}) as HooksConfig)) {
    for (const h of hooks ?? []) lines.push(`${event} hook${h.matcher ? ` (${h.matcher})` : ''}: ${h.command}`);
  }
  for (const rule of (project.allow as string[] | undefined) ?? []) lines.push(`auto-allow: ${rule}`);
  if (typeof project.permissionMode === 'string') lines.push(`permission mode: ${project.permissionMode}`);
  return { needed: true, summary: lines.join('\n'), hash };
}

export async function trustProject(cwd: string, hash: string): Promise<void> {
  const trusted = await readJson(TRUST_FILE);
  trusted[cwd] = hash;
  await mkdir(HOME_DIR, { recursive: true });
  await writeFile(TRUST_FILE, JSON.stringify(trusted, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Global config, overlaid by project config (.tessera/settings.json). `allow` and `hooks` lists are merged.
 * Privileged project keys are dropped unless `trusted` (see projectTrust).
 */
export async function loadConfig(cwd: string, opts: { trusted: boolean }): Promise<Config> {
  const global = await readJson(GLOBAL_CONFIG);
  const project = await readJson(projectConfigPath(cwd));
  if (!opts.trusted) for (const k of PRIVILEGED_KEYS) delete project[k];
  // The API key is read by resolveApiKey from the global file only; it never becomes part of the settings.
  delete global.apiKey;
  delete project.apiKey;
  const merged = { ...DEFAULTS, ...global, ...project } as Config;
  // Pre-0.2 name of the same setting.
  const legacy = (project.autoCompactTokens ?? global.autoCompactTokens) as unknown;
  if (typeof legacy === 'number' && project.contextLimit === undefined && global.contextLimit === undefined) merged.contextLimit = legacy;
  merged.allow = [...new Set([...((global.allow as string[]) ?? []), ...(await userProjectAllow(cwd)), ...((project.allow as string[]) ?? [])])];
  merged.mcpServers = Object.fromEntries(
    Object.entries({ ...DEFAULT_MCP_SERVERS, ...(global.mcpServers as object), ...(project.mcpServers as object) } as Record<string, McpServerConfig>).filter(
      ([, s]) => s && s.enabled !== false,
    ),
  );
  merged.fallback = { ...DEFAULTS.fallback, ...(global.fallback as object), ...(project.fallback as object) };
  // Hooks from both levels run; global first.
  const gh = (global.hooks ?? {}) as HooksConfig;
  const ph = (project.hooks ?? {}) as HooksConfig;
  merged.hooks = Object.fromEntries(
    [...new Set([...Object.keys(gh), ...Object.keys(ph)])].map((k) => [k, [...(gh[k as keyof HooksConfig] ?? []), ...(ph[k as keyof HooksConfig] ?? [])]]),
  );
  merged.permissionMode = parsePermissionMode(merged.permissionMode, '"permissionMode" in config');
  for (const k of ['subagents', 'multiAgent'] as const) {
    if (typeof merged[k] !== 'boolean') throw new Error(`Invalid "${k}" in config: use true or false (got ${JSON.stringify(merged[k])}).`);
  }
  if (typeof merged.showThinking !== 'boolean') throw new Error(`Invalid "showThinking" in config: use true or false (got ${JSON.stringify(merged.showThinking)}).`);
  if (typeof merged.thinking !== 'boolean') throw new Error(`Invalid "thinking" in config: use true or false (got ${JSON.stringify(merged.thinking)}).`);
  if (!THINKING_LEVELS.includes(merged.thinkingLevel)) {
    throw new Error(`Invalid "thinkingLevel" in config: use one of ${THINKING_LEVELS.join(', ')} (got ${JSON.stringify(merged.thinkingLevel)}).`);
  }
  return merged;
}

/** Accepts the mode names plus "edit" for acceptEdits; anything else is an error naming `where`. */
export function parsePermissionMode(value: unknown, where: string): PermissionMode {
  if (value === 'edit') return 'acceptEdits';
  if (PERMISSION_MODES.includes(value as PermissionMode)) return value as PermissionMode;
  throw new Error(`Invalid ${where}: use one of ${[...PERMISSION_MODES, 'edit'].join(', ')} (got ${JSON.stringify(value)}).`);
}

/** Written on first run so the main settings are visible and editable in one place. */
export const DEFAULT_CONFIG_FILE = {
  apiKey: '', // OpenCode Go API key: set with /auth <key> (or edit it here)
  model: DEFAULT_MODEL,
  thinking: true,
  thinkingLevel: 'medium',
  showThinking: true,
  permissionMode: 'default',
  mcpServers: DEFAULT_MCP_SERVERS,
};

export const GLOBAL_INSTRUCTIONS = join(HOME_DIR, 'TESSERA.md');

/**
 * SHA-256 of the default instructions earlier releases copied to ~/.tessera-code/TESSERA.md (0.3.0-0.3.2 and 0.3.3).
 * Those rules are built into the system prompt now, so an unedited copy would only repeat them; it is removed. A file
 * the user changed in any way is kept.
 */
const OLD_DEFAULT_INSTRUCTIONS = new Set([
  'e88e307fa7503b6632368d24740408239602a8c405a0ab45280edd11f906b5ba',
  '76eee05a79de79cc3e2e215cd20a193ec472a924c5dc2630c0991e1a33e7fe50',
]);

async function removeOldDefaultInstructions(): Promise<boolean> {
  try {
    const content = await readFile(GLOBAL_INSTRUCTIONS, 'utf8');
    if (!OLD_DEFAULT_INSTRUCTIONS.has(createHash('sha256').update(content.trim()).digest('hex'))) return false;
    await rm(GLOBAL_INSTRUCTIONS);
    return true;
  } catch {
    return false; // absent or unreadable: nothing to do
  }
}

/**
 * First run: creates ~/.tessera-code/config.json (main defaults) when it does not exist, and brings an existing one
 * up to date (see addMissingDefaults). Also drops an unedited copy of the old default instructions. Returns the
 * paths created.
 */
export async function ensureGlobalDefaults(): Promise<string[]> {
  const created: string[] = [];
  await mkdir(HOME_DIR, { recursive: true });
  try {
    await writeFile(GLOBAL_CONFIG, JSON.stringify(DEFAULT_CONFIG_FILE, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    created.push(GLOBAL_CONFIG);
  } catch {
    // exists already (or was created meanwhile by another tessera-code process): make sure it has the apiKey entry
    await addMissingDefaults();
  }
  await removeOldDefaultInstructions();
  return created;
}

/**
 * "Always allow" decisions live in the user's home, keyed by project path, not in the repo: they are the
 * user's own choices, so they apply without project trust and cannot be planted by a cloned repository.
 */
function userProjectAllowPath(cwd: string): string {
  return join(HOME_DIR, 'projects', createHash('sha256').update(cwd).digest('hex').slice(0, 16) + '.json');
}

export async function userProjectAllow(cwd: string): Promise<string[]> {
  return ((await readJson(userProjectAllowPath(cwd))).allow as string[] | undefined) ?? [];
}

export async function addProjectAllowRule(cwd: string, rule: string): Promise<void> {
  const allow = new Set(await userProjectAllow(cwd));
  allow.add(rule);
  await mkdir(join(HOME_DIR, 'projects'), { recursive: true });
  await writeFile(userProjectAllowPath(cwd), JSON.stringify({ cwd, allow: [...allow] }, null, 2) + '\n', { mode: 0o600 });
}

export async function removeProjectAllowRule(cwd: string, rule: string): Promise<boolean> {
  const allow = await userProjectAllow(cwd);
  if (!allow.includes(rule)) return false;
  await writeFile(userProjectAllowPath(cwd), JSON.stringify({ cwd, allow: allow.filter((r) => r !== rule) }, null, 2) + '\n', { mode: 0o600 });
  return true;
}

/**
 * Brings an existing config.json up to date without touching what is there:
 * - "apiKey" (from /auth) is added: empty, or the key an earlier `tessera-code auth <key>` stored in
 *   ~/.tessera-code/auth.json;
 * - each built-in MCP server (DEFAULT_MCP_SERVERS) missing from "mcpServers" is added. An entry the user changed
 *   or disabled stays as it is.
 * A file that cannot be parsed is left alone; loadConfig reports it.
 */
async function addMissingDefaults(): Promise<void> {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(await readFile(GLOBAL_CONFIG, 'utf8'));
  } catch {
    return;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return;
  let changed = false;
  if (!('apiKey' in json)) {
    const legacy = (await readJson(join(HOME_DIR, 'auth.json')).catch(() => ({}))) as { key?: unknown };
    json = { apiKey: typeof legacy.key === 'string' ? legacy.key : '', ...json };
    changed = true;
  }
  const servers = (json.mcpServers && typeof json.mcpServers === 'object' ? json.mcpServers : {}) as Record<string, unknown>;
  const missing = Object.keys(DEFAULT_MCP_SERVERS).filter((name) => !(name in servers));
  if (missing.length) {
    json.mcpServers = { ...servers, ...Object.fromEntries(missing.map((name) => [name, DEFAULT_MCP_SERVERS[name]])) };
    changed = true;
  }
  if (changed) await writeGlobalConfig(json);
}

/** Sets one setting in ~/.tessera-code/config.json (e.g. the permission mode chosen with shift+tab), keeping the rest. */
export async function saveGlobalSetting(key: string, value: unknown): Promise<void> {
  const json = await readJson(GLOBAL_CONFIG);
  await writeGlobalConfig(Object.keys(json).length ? { ...json, [key]: value } : { ...DEFAULT_CONFIG_FILE, [key]: value });
}

/** Rewrites config.json atomically (other tessera-code processes may be reading it), readable by the user only. */
async function writeGlobalConfig(json: Record<string, unknown>): Promise<void> {
  await mkdir(HOME_DIR, { recursive: true });
  const tmp = `${GLOBAL_CONFIG}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(json, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, GLOBAL_CONFIG);
  await chmod(GLOBAL_CONFIG, 0o600);
}

/**
 * The OpenCode Go API key registered with /auth: "apiKey" in ~/.tessera-code/config.json. OPENCODE_API_KEY in the
 * environment overrides it for one run (CI, scripts). Project settings never provide a key, and keys of other
 * tools (e.g. an opencode CLI login) are not picked up.
 */
export async function resolveApiKey(): Promise<{ key: string; source: string } | undefined> {
  if (process.env.OPENCODE_API_KEY) return { key: process.env.OPENCODE_API_KEY, source: 'env OPENCODE_API_KEY' };
  const key = (await readJson(GLOBAL_CONFIG)).apiKey;
  if (typeof key === 'string' && key.trim()) return { key: key.trim(), source: '~/.tessera-code/config.json' };
  return undefined;
}

/** Stores the key as "apiKey" in ~/.tessera-code/config.json, keeping the other settings. */
export async function saveApiKey(key: string): Promise<void> {
  const json = await readJson(GLOBAL_CONFIG);
  await writeGlobalConfig(Object.keys(json).length ? { ...json, apiKey: key } : { ...DEFAULT_CONFIG_FILE, apiKey: key });
}

/** "sk-…a1b2": enough to tell keys apart, never the key. */
export function maskKey(key: string): string {
  return key.length <= 8 ? '••••' : `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/**
 * Checks a key against the models endpoint (no model usage). 'rejected' is a definite 401/403; 'unknown' means the
 * check itself failed (offline, timeout, server error).
 */
export async function checkApiKey(key: string, fetchFn: typeof fetch = fetch): Promise<'ok' | 'rejected' | 'unknown'> {
  try {
    const r = await fetchFn(`${BASE_URL}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    if (r.status === 401 || r.status === 403) return 'rejected';
    return r.ok ? 'ok' : 'unknown';
  } catch {
    return 'unknown';
  }
}
