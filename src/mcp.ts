import type { MCPClient } from '@ai-sdk/mcp';
import type { ToolSet } from 'ai';
import type { McpServerConfig } from './config.js';

export interface McpServerStatus {
  name: string;
  ok: boolean;
  tools: string[];
  error?: string;
}

export interface McpConnection {
  tools: ToolSet;
  /** Namespaced tool name -> server name (names may contain "__", so never parse them back). */
  serverOf: Record<string, string>;
  status: McpServerStatus[];
  close(): Promise<void>;
}

const CONNECT_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms))]);
}

/**
 * A local server's command line, from tessera's form ({ command: "npx", args: [...], env }) or opencode's
 * ({ command: ["npx", ...], environment }), so a config copied from opencode works as it is.
 */
export function localCommand(cfg: Record<string, unknown>): { command: string; args: string[]; env: Record<string, string> } {
  const raw = cfg.command;
  const parts = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
  if (!parts[0]) throw new Error('no "command" to run');
  const args = [...parts.slice(1), ...(Array.isArray(cfg.args) ? cfg.args.map(String) : [])];
  const env = { ...((cfg.environment ?? {}) as Record<string, string>), ...((cfg.env ?? {}) as Record<string, string>) };
  return { command: parts[0], args, env };
}

/** Tool names are namespaced as mcp__<server>__<tool> and sanitized to provider-safe characters. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/**
 * Connects to every configured server in parallel; a failing server is reported, not fatal. `onProgress` gets the
 * tools and status so far each time one server is done, so fast servers are usable before a slow one finishes.
 */
export async function connectMcp(
  servers: Record<string, McpServerConfig>,
  cwd: string,
  onProgress?: (partial: Omit<McpConnection, 'close'>) => void,
): Promise<McpConnection> {
  if (!Object.keys(servers).length) return { tools: {}, serverOf: {}, status: [], close: async () => {} };
  // The MCP SDK loads only when servers are configured.
  const [{ createMCPClient }, { Experimental_StdioMCPTransport: StdioMCPTransport }] = await Promise.all([import('@ai-sdk/mcp'), import('@ai-sdk/mcp/mcp-stdio')]);
  const clients: MCPClient[] = [];
  const tools: ToolSet = {};
  const serverOf: Record<string, string> = {};
  const settled = new Map<string, McpServerStatus>();
  const snapshot = (): McpServerStatus[] => Object.keys(servers).map((name) => settled.get(name) ?? { name, ok: false, tools: [], error: 'connecting…' });
  const report = (s: McpServerStatus): McpServerStatus => {
    settled.set(s.name, s);
    onProgress?.({ tools: { ...tools }, serverOf: { ...serverOf }, status: snapshot() });
    return s;
  };
  const status = await Promise.all(
    Object.entries(servers).map(async ([name, cfg]): Promise<McpServerStatus> => {
      try {
        const transport =
          'url' in cfg
            ? { type: 'http' as const, url: cfg.url, headers: cfg.headers }
            : (() => {
                const local = localCommand(cfg as Record<string, unknown>);
                return new StdioMCPTransport({ command: local.command, args: local.args, env: { ...(process.env as Record<string, string>), ...local.env }, cwd, stderr: 'ignore' });
              })();
        const client = await withTimeout(createMCPClient({ transport }), CONNECT_TIMEOUT_MS, `MCP server "${name}"`);
        clients.push(client);
        const serverTools = await withTimeout(client.tools(), CONNECT_TIMEOUT_MS, `Listing tools of "${name}"`);
        for (const [toolName, t] of Object.entries(serverTools)) {
          const qualified = mcpToolName(name, toolName);
          tools[qualified] = t;
          serverOf[qualified] = name;
        }
        return report({ name, ok: true, tools: Object.keys(serverTools) });
      } catch (e) {
        return report({ name, ok: false, tools: [], error: (e as Error).message });
      }
    }),
  );
  return {
    tools,
    serverOf,
    status,
    async close() {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}
