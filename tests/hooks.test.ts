import { describe, expect, it } from 'vitest';
import { HookRunner } from '../src/hooks.js';
import { mcpToolName } from '../src/mcp.js';

describe('HookRunner', () => {
  const cwd = process.cwd();
  it('blocks on exit code 2 with stderr as the reason', async () => {
    const h = new HookRunner({ PreToolUse: [{ matcher: 'bash', command: "echo 'nope' >&2; exit 2" }] }, cwd, 's');
    expect(await h.run('PreToolUse', { tool: 'bash' })).toEqual({ blocked: 'nope' });
  });
  it('only runs hooks whose matcher matches the whole tool name', async () => {
    const h = new HookRunner({ PreToolUse: [{ matcher: 'edit|write', command: 'exit 2' }] }, cwd, 's');
    expect((await h.run('PreToolUse', { tool: 'bash' })).blocked).toBeUndefined();
    expect((await h.run('PreToolUse', { tool: 'editor' })).blocked).toBeUndefined();
    expect((await h.run('PreToolUse', { tool: 'write' })).blocked).toBeDefined();
  });
  it('passes the JSON payload on stdin and returns stdout as context', async () => {
    const h = new HookRunner({ UserPromptSubmit: [{ command: "node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).prompt.toUpperCase()))\"" }] }, cwd, 's');
    expect(await h.run('UserPromptSubmit', { prompt: 'hi' })).toEqual({ context: 'HI' });
  });
  it('ignores failures other than exit 2', async () => {
    const h = new HookRunner({ Stop: [{ command: 'exit 1' }] }, cwd, 's');
    expect(await h.run('Stop', {})).toEqual({ context: undefined });
  });
});

describe('mcpToolName', () => {
  it('namespaces and sanitizes', () => expect(mcpToolName('my.server', 'do/thing')).toBe('mcp__my_server__do_thing'));
});
