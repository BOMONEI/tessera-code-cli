import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectMcp } from '../src/mcp.js';

// A minimal stdio MCP server with one tool; DELAY_MS holds back its answer to "initialize" (a slow server).
const SERVER = `
const readline = require('node:readline');
const delay = Number(process.env.DELAY_MS || 0);
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    setTimeout(() => send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 't', version: '1' } } }), delay);
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }] } });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
`;

describe('connectMcp', () => {
  it('reports each server as soon as it is done, so a slow one does not hold back the fast ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tessera-mcp-'));
    const script = join(dir, 'server.cjs');
    writeFileSync(script, SERVER);
    const progress: Array<{ at: number; tools: string[]; status: string[] }> = [];
    const started = Date.now();
    const conn = await connectMcp(
      {
        fast: { command: process.execPath, args: [script] },
        slow: { command: process.execPath, args: [script], env: { DELAY_MS: '1500' } },
        dead: { command: join(dir, 'missing-binary') },
      },
      dir,
      (p) => progress.push({ at: Date.now() - started, tools: Object.keys(p.tools).sort(), status: p.status.map((s) => `${s.name}:${s.ok ? 'ok' : s.error === 'connecting…' ? '…' : 'fail'}`) }),
    );
    try {
      // The first reports come long before the slow server answers, and already carry the fast server's tool.
      const fastReady = progress.find((p) => p.tools.includes('mcp__fast__ping'))!;
      expect(fastReady.at).toBeLessThan(1200);
      expect(fastReady.status).toContain('slow:…');
      // The last report is the complete picture, in configuration order.
      expect(progress.at(-1)!.status).toEqual(['fast:ok', 'slow:ok', 'dead:fail']);
      expect(progress).toHaveLength(3);
      expect(Object.keys(conn.tools).sort()).toEqual(['mcp__fast__ping', 'mcp__slow__ping']);
    } finally {
      await conn.close();
    }
  }, 20_000);
});
