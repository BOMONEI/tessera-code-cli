import { beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { DEFAULT_CONFIG_FILE, DEFAULT_MCP_SERVERS, GLOBAL_CONFIG, HOME_DIR, ensureGlobalDefaults, loadConfig, saveGlobalSetting } = await import('../src/config.js');
const { runCommand } = await import('../src/commands.js');

const config = () => JSON.parse(readFileSync(GLOBAL_CONFIG, 'utf8')) as Record<string, any>;
const project = () => mkdtempSync(join(tmpdir(), 'tessera-defaults-'));

beforeEach(() => {
  rmSync(GLOBAL_CONFIG, { force: true });
  mkdirSync(HOME_DIR, { recursive: true });
});

describe('defaults', () => {
  it('asks before edits and commands on a new install', async () => {
    await ensureGlobalDefaults();
    expect(config().permissionMode).toBe('default');
    expect((await loadConfig(project(), { trusted: false })).permissionMode).toBe('default');
  });
});

describe('built-in exa MCP server', () => {
  it('is written to a new config.json and always loaded', async () => {
    await ensureGlobalDefaults();
    expect(config().mcpServers.exa).toEqual({ type: 'remote', url: 'https://mcp.exa.ai/mcp', enabled: true });
    expect((await loadConfig(project(), { trusted: false })).mcpServers.exa).toMatchObject({ url: 'https://mcp.exa.ai/mcp' });
  });

  it('is loaded even when the config does not list it, next to the user\'s own servers', async () => {
    writeFileSync(GLOBAL_CONFIG, JSON.stringify({ mcpServers: { mine: { command: 'my-mcp' } } }));
    const servers = (await loadConfig(project(), { trusted: false })).mcpServers;
    expect(Object.keys(servers).sort()).toEqual(['exa', 'mine']);
  });

  it('is added to an existing config.json without touching other servers or a customized exa', async () => {
    writeFileSync(GLOBAL_CONFIG, JSON.stringify({ model: 'x', mcpServers: { mine: { command: 'my-mcp' } } }));
    await ensureGlobalDefaults();
    expect(config().mcpServers).toEqual({ mine: { command: 'my-mcp' }, exa: DEFAULT_MCP_SERVERS.exa });
    writeFileSync(GLOBAL_CONFIG, JSON.stringify({ apiKey: '', mcpServers: { exa: { url: 'https://mcp.exa.ai/mcp?exaApiKey=x' } } }));
    await ensureGlobalDefaults();
    expect(config().mcpServers.exa).toEqual({ url: 'https://mcp.exa.ai/mcp?exaApiKey=x' });
  });

  it('can be turned off with "enabled": false (globally or per project)', async () => {
    writeFileSync(GLOBAL_CONFIG, JSON.stringify({ mcpServers: { exa: { ...DEFAULT_MCP_SERVERS.exa, enabled: false } } }));
    expect((await loadConfig(project(), { trusted: false })).mcpServers.exa).toBeUndefined();
    rmSync(GLOBAL_CONFIG);
    const cwd = project();
    mkdirSync(join(cwd, '.tessera'));
    writeFileSync(join(cwd, '.tessera', 'settings.json'), JSON.stringify({ mcpServers: { exa: { url: 'https://mcp.exa.ai/mcp', enabled: false } } }));
    expect((await loadConfig(cwd, { trusted: true })).mcpServers.exa).toBeUndefined();
  });
});

describe('permission mode changes are global', () => {
  it('saveGlobalSetting changes one setting and keeps the rest', async () => {
    await ensureGlobalDefaults();
    await saveGlobalSetting('permissionMode', 'plan');
    expect(config()).toEqual({ ...DEFAULT_CONFIG_FILE, permissionMode: 'plan' });
    expect((await loadConfig(project(), { trusted: false })).permissionMode).toBe('plan');
  });

  it('/mode goes through setPermissionMode, which saves it', async () => {
    const calls: string[] = [];
    const app = { ctx: { cwd: project() }, permissions: { mode: 'default' }, setPermissionMode: async (m: string) => void calls.push(m) };
    const r = await runCommand(app as never, '/mode edit');
    expect(calls).toEqual(['acceptEdits']);
    expect(r.output).toMatch(/saved to ~\/\.tessera-code\/config\.json/);
    expect((await runCommand(app as never, '/mode nope')).output).toMatch(/Unknown mode/);
    expect(calls).toEqual(['acceptEdits']);
  });
});
