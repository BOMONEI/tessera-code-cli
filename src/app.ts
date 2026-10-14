import { randomUUID } from 'node:crypto';
import type { ToolSet } from 'ai';
import { THINKING_LEVELS, addProjectAllowRule, loadConfig, projectTrust, resolveApiKey, saveGlobalSetting, trustProject, type Config, type ThinkingLevel } from './config.js';
import { loadCatalog, findModel, isZdr, type ModelInfo } from './providers/catalog.js';
import { PermissionManager, type PermissionMode, type PromptFn } from './permissions.js';
import { Agent } from './agent/agent.js';
import { NonZdrModelError } from './providers/index.js';
import { warmUp } from './providers/net.js';
import { buildSystemPrompt } from './agent/prompt.js';
import { SessionStore, type Checkpoint, type SessionState } from './session/store.js';
import { Checkpoints, type RewindMode, type RewindResult } from './session/checkpoints.js';
import { generateTitle } from './agent/compact.js';
import type { AgentEvent, ImageInput } from './agent/agent.js';
import { runShell } from './tools/shell.js';
import { truncate } from './tools/context.js';
import { attachMentionedFiles } from './agent/attachments.js';
import { HookRunner } from './hooks.js';
import { connectMcp, type McpServerStatus } from './mcp.js';
import type { ToolContext } from './tools/context.js';
import { fileTools } from './tools/files.js';
import { searchTools } from './tools/search.js';
import { shellTools } from './tools/shell.js';

export interface AppOptions {
  cwd: string;
  model?: string;
  /** Session id to resume, or true for the most recent session in cwd. */
  resume?: string | true;
  permissionMode?: PermissionMode;
  /** Overrides config.thinking for this run. */
  thinking?: boolean;
  prompt: PromptFn;
  onDiff?: (path: string, diff: string) => void;
  /** Asked once when project settings would run hooks/MCP servers or widen permissions. */
  confirmTrust?: (summary: string) => Promise<boolean>;
}

export interface App {
  agent: Agent;
  /** The current session's store; replaced on /resume, /fork and /clear. */
  readonly store: SessionStore;
  readonly checkpoints: Checkpoints;
  /** Session title (generated after the first turn, or set with /rename). */
  readonly title: string | undefined;
  ctx: ToolContext;
  permissions: PermissionManager;
  catalog: ModelInfo[];
  config: Config;
  /** Where the API key came from ('' while none is registered). */
  readonly apiKeySource: string;
  /** Uses a key registered with /auth from now on (the caller has stored it). */
  setApiKey(key: string, source: string): void;
  /** Switches the permission mode and makes it the default everywhere ("permissionMode" in config.json). */
  setPermissionMode(mode: PermissionMode): Promise<void>;
  mcpStatus: McpServerStatus[];
  /** Resolves once MCP servers have connected (or failed); their tools are available from then on. */
  mcpReady: Promise<void>;
  /** Fallback model ids in use, in order. */
  fallbackModels: string[];
  /** Startup problems worth showing (invalid hook matchers etc.). */
  warnings: string[];
  /** False when privileged project settings were ignored because the user did not trust them. */
  projectTrusted: boolean;
  /** Runs one user turn with undo checkpoints, persistence and title generation around the agent. */
  run(prompt: string, signal?: AbortSignal, images?: ImageInput[]): AsyncGenerator<AgentEvent>;
  /** Runs a command typed by the user ("!cmd"); its output is given to the model with the next prompt. */
  shell(command: string, signal?: AbortSignal): Promise<{ output: string; code: number | null }>;
  /** Persists model/thinking/mode/usage for resume. */
  saveState(): Promise<void>;
  setModel(id: string): Promise<void>;
  /** Continues another session of this directory, restoring its history and settings. */
  switchSession(id: string): Promise<void>;
  /** Copies the current session into a new one and continues there; returns the new id. */
  fork(): Promise<string>;
  rename(title: string): Promise<void>;
  rewind(cp: Checkpoint, mode: RewindMode): Promise<RewindResult>;
  /** Starts a new, empty session. */
  clear(): Promise<void>;
  close(): Promise<void>;
}

export const NO_API_KEY = 'No OpenCode Go API key registered. Run /auth <key> (or: tessera-code auth <key>).';

function stringify(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Wraps every tool with PreToolUse/PostToolUse hooks, and MCP tools with a permission check. */
export function guardTools(tools: ToolSet, hooks: HookRunner, permissions: PermissionManager, mcpServerOf: Record<string, string> = {}): ToolSet {
  const out: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    const execute = t.execute;
    if (!execute) {
      out[name] = t;
      continue;
    }
    const server = mcpServerOf[name];
    out[name] = {
      ...t,
      execute: async (input: unknown, options: Parameters<typeof execute>[1]) => {
        if (server) {
          const denied = await permissions.check({
            tool: 'mcp',
            rule: `mcp(${server}/${name})`,
            saveRule: `mcp(${server}/*)`,
            title: `${server}: ${name}`,
            detail: JSON.stringify(input, null, 2).slice(0, 2000),
            signal: options.abortSignal,
          });
          if (denied) return denied;
        }
        if (hooks.configured) {
          const pre = await hooks.run('PreToolUse', { tool: name, input });
          if (pre.blocked) return `Blocked by PreToolUse hook: ${pre.blocked}`;
        }
        const result = await execute(input as never, options);
        if (hooks.configured) {
          const post = await hooks.run('PostToolUse', { tool: name, input, output: result });
          if (post.blocked) return `${stringify(result)}\n\n[PostToolUse hook feedback: ${post.blocked}]`;
        }
        return result;
      },
    } as typeof t;
  }
  return out;
}

export function buildTools(ctx: ToolContext): ToolSet {
  return { ...fileTools(ctx), ...searchTools(ctx), ...shellTools(ctx) };
}

export async function createApp(opts: AppOptions): Promise<App> {
  // Without a key the app still starts, so /auth can register one; turns are refused until then.
  let auth = (await resolveApiKey()) ?? { key: '', source: '' };
  if (auth.key) warmUp(auth.key); // TLS handshake happens while the rest starts up and the user types
  const trust = await projectTrust(opts.cwd);
  let trusted = !trust.needed;
  if (trust.needed && (await opts.confirmTrust?.(trust.summary))) {
    await trustProject(opts.cwd, trust.hash);
    trusted = true;
  }
  const config = await loadConfig(opts.cwd, { trusted });
  // MCP servers (npx-launched ones can take seconds) connect in the background; the first turn waits only if they
  // are still starting by then.
  const mcpConnecting = connectMcp(config.mcpServers, opts.cwd);
  let mcpStatus: McpServerStatus[] = Object.keys(config.mcpServers).map((name) => ({ name, ok: false, tools: [], error: 'connecting…' }));
  const catalog = await loadCatalog();

  let resumeId: string | undefined;
  if (opts.resume === true) {
    const latest = (await SessionStore.list(opts.cwd, 1))[0];
    if (!latest) throw new Error('No previous session in this directory.');
    resumeId = latest.id;
  } else if (typeof opts.resume === 'string') {
    resumeId = await SessionStore.find(opts.cwd, opts.resume);
    if (!resumeId) {
      throw new Error(
        `No session "${opts.resume}" in this directory. -r takes a session id (see \`tessera-code sessions\`); ` +
          'to pick one use -r alone, and put a prompt after the id: tessera-code -r <id> "prompt".',
      );
    }
  }
  const sessionId = randomUUID();
  let store = new SessionStore(opts.cwd, sessionId);
  const checkpoints = new Checkpoints(() => store, opts.cwd);
  let title: string | undefined;
  const pendingShell: string[] = [];
  // One turn at a time; session switches and rewinds must not interleave with a running turn (its end would
  // overwrite the history they install).
  let running = false;
  const idle = () => {
    if (running) throw new Error('Wait for the current turn to finish (esc to interrupt).');
  };

  const permissions = new PermissionManager(config.allow, opts.prompt, opts.permissionMode ?? config.permissionMode, (rule) =>
    addProjectAllowRule(opts.cwd, rule),
  );
  const ctx: ToolContext = { cwd: opts.cwd, permissions, readFiles: new Map(), onDiff: opts.onDiff, beforeWrite: (abs) => checkpoints.beforeWrite(abs) };
  const hooks = new HookRunner(config.hooks, opts.cwd, sessionId);
  const base = guardTools(buildTools(ctx), hooks, permissions);

  const model = findModel(catalog, opts.model ?? config.model);
  if (!isZdr(model.id)) throw new NonZdrModelError(model.id);
  // Fallbacks must be ZDR and known to the catalog (unknown ids would have no limits or prices).
  const skipped = config.fallback.models.filter((id) => !isZdr(id) || !catalog.some((m) => m.id === id));
  const fallbackModels = config.fallback.models.filter((id) => !skipped.includes(id)).map((id) => findModel(catalog, id));
  const agent: Agent = new Agent({
    model,
    apiKey: auth.key,
    sessionId,
    system: await buildSystemPrompt(opts.cwd, model.id),
    tools: base,
    maxSteps: config.maxSteps,
    thinking: opts.thinking ?? config.thinking,
    thinkingLevel: config.thinkingLevel,
    fallback: { models: fallbackModels, firstTokenTimeoutMs: config.fallback.firstTokenTimeoutMs, stickyMs: config.fallback.stickyMs },
    contextLimit: config.contextLimit,
    earlyTools: !hooks.configured,
    beforeTurn: async (prompt) => {
      const hook = hooks.configured ? await hooks.run('UserPromptSubmit', { prompt }) : {};
      if (hook.blocked) return hook;
      // Attachments are reads: they honor PreToolUse hooks for the read tool.
      const files = await attachMentionedFiles(ctx, prompt, async (abs) =>
        hooks.configured ? !(await hooks.run('PreToolUse', { tool: 'read', input: { path: abs } })).blocked : true,
      );
      const shell = pendingShell.length ? `Commands the user ran in the terminal:\n${pendingShell.splice(0).join('\n\n')}` : undefined;
      return { context: [hook.context, shell, files.context].filter(Boolean).join('\n\n') || undefined, notes: files.notes };
    },
    afterTurn: hooks.configured ? async () => void (await hooks.run('Stop', {})) : undefined,
  });

  const mcpReady = mcpConnecting
    .then((mcp) => {
      mcpStatus = mcp.status;
      if (Object.keys(mcp.tools).length) agent.tools = guardTools({ ...buildTools(ctx), ...mcp.tools }, hooks, permissions, mcp.serverOf);
    })
    .catch((e: Error) => {
      mcpStatus = mcpStatus.map((s) => ({ ...s, error: e.message }));
    });

  const saveState = async () => {
    if (!agent.messages.length && !store.exists) return; // an unused session leaves no file behind
    await store.saveState({ model: agent.model.id, thinking: agent.thinking, thinkingLevel: agent.thinkingLevel, mode: permissions.mode, total: { ...agent.total } });
  };

  const setModel = async (id: string) => {
    if (!isZdr(id)) throw new NonZdrModelError(id);
    agent.model = findModel(catalog, id);
    agent.resetFallback();
    agent.system = await buildSystemPrompt(opts.cwd, agent.model.id);
  };

  /** Moves the app onto `next`, with its history; `state` restores per-session settings. */
  const adoptSession = async (next: SessionStore, loaded: { messages: import('ai').ModelMessage[]; title?: string; state?: SessionState; checkpoints: Checkpoint[] }, keep: { model?: boolean; thinking?: boolean; mode?: boolean } = {}) => {
    store = next;
    pendingShell.length = 0; // "!cmd" output belongs to the session it was run in
    agent.switchSession(next.sessionId, loaded.messages, loaded.state?.total);
    store.adopt(agent);
    hooks.sessionId = next.sessionId;
    checkpoints.reset(loaded.checkpoints);
    ctx.readFiles.clear();
    title = loaded.title;
    const st = loaded.state;
    if (st) {
      if (!keep.model && st.model !== agent.model.id && isZdr(st.model) && catalog.some((m) => m.id === st.model)) await setModel(st.model);
      if (!keep.thinking) {
        agent.thinking = st.thinking;
        if (THINKING_LEVELS.includes(st.thinkingLevel as ThinkingLevel)) agent.thinkingLevel = st.thinkingLevel as ThinkingLevel;
      }
      // The configured mode applies to every run; a session only brings back plan mode (read-only, so restoring it
      // never grants more than the user chose). acceptEdits/bypass come from the config or are chosen each run.
      if (!keep.mode && st.mode === 'plan') permissions.mode = st.mode;
    }
  };

  const switchSession = async (id: string, keep?: { model?: boolean; thinking?: boolean; mode?: boolean }) => {
    idle();
    await store.sync(agent);
    const next = new SessionStore(opts.cwd, id);
    await adoptSession(next, await next.load(), keep);
  };

  if (resumeId) await switchSession(resumeId, { model: !!opts.model, thinking: opts.thinking !== undefined, mode: opts.permissionMode !== undefined });

  return {
    agent,
    get store() {
      return store;
    },
    checkpoints,
    get title() {
      return title;
    },
    ctx,
    permissions,
    catalog,
    config,
    get apiKeySource() {
      return auth.source;
    },
    async setPermissionMode(mode) {
      permissions.mode = mode;
      config.permissionMode = mode;
      await saveGlobalSetting('permissionMode', mode);
    },
    setApiKey(key, source) {
      auth = { key, source };
      agent.apiKey = key;
      warmUp(key);
    },
    get mcpStatus() {
      return mcpStatus;
    },
    mcpReady,
    projectTrusted: trusted,
    fallbackModels: fallbackModels.filter((m) => m.id !== model.id).map((m) => m.id),
    warnings: [
      ...(auth.key ? [] : [NO_API_KEY]),
      ...hooks.warnings,
      ...skipped.map((id) => `Fallback model ${id} ignored: ${isZdr(id) ? 'not in the model catalog' : 'not zero-data-retention'}.`)],
    async *run(prompt, signal, images) {
      if (!agent.apiKey) {
        yield { type: 'error', message: NO_API_KEY };
        return;
      }
      idle();
      running = true;
      const firstTurn = !agent.messages.length && !title;
      let started = false;
      try {
        // MCP servers still starting: wait for them (their tools belong to this turn), but let esc interrupt.
        const waitStart = performance.now();
        await Promise.race([mcpReady, new Promise<void>((resolve) => (signal?.aborted ? resolve() : signal?.addEventListener('abort', () => resolve(), { once: true })))]);
        const waited = performance.now() - waitStart;
        checkpoints.begin(prompt, agent.messages);
        for await (const ev of agent.run(prompt, signal, images)) {
          // A compaction before the turn replaces the history the checkpoint points to.
          if (ev.type === 'compacted' && !started) checkpoints.begin(prompt, agent.messages);
          else if (ev.type !== 'info') started = true;
          // Timings cover the whole turn as the user saw it, including the MCP wait.
          yield ev.type === 'turn-finish'
            ? { ...ev, elapsedMs: ev.elapsedMs + waited, firstOutputMs: ev.firstOutputMs === undefined ? undefined : ev.firstOutputMs + waited }
            : ev;
        }
      } finally {
        try {
          await checkpoints.end();
          await store.sync(agent);
          await saveState();
        } finally {
          running = false;
        }
      }
      if (firstTurn && !signal?.aborted) {
        const target = store;
        // Fall back to the prompt's first words when the model gives nothing usable.
        const fallback = prompt.replace(/\s+/g, ' ').trim().slice(0, 50);
        void generateTitle({ model: agent.model, apiKey: agent.apiKey, sessionId: agent.sessionId, prompt })
          .catch(() => undefined)
          .then(async (generated) => {
            const t = generated ?? fallback;
            if (!t || store !== target || title) return;
            title = t;
            await target.setTitle(t);
          })
          .catch(() => {}); // a missing title only affects the session list
      }
    },
    async shell(command, signal) {
      const { code, output, timedOut } = await runShell(command, opts.cwd, 120_000, signal);
      const body = truncate(output.trim(), 20_000) || '(no output)';
      const status = timedOut ? ' (timed out)' : code ? ` (exit code ${code})` : '';
      pendingShell.push(`$ ${command}${status}\n${body}`);
      return { output: output.trim(), code };
    },
    saveState,
    setModel,
    switchSession: (id) => switchSession(id),
    async fork() {
      idle();
      await store.sync(agent);
      await saveState();
      const next = await store.fork(randomUUID());
      const loaded = await next.load();
      if (title) await next.setTitle(`${title} (fork)`);
      await adoptSession(next, { ...loaded, title: title && `${title} (fork)` }, { model: true, thinking: true, mode: true });
      return next.sessionId;
    },
    async rename(t) {
      title = t;
      await store.setTitle(t);
    },
    async rewind(cp, mode) {
      idle();
      const r = await checkpoints.rewind(cp, mode, agent.messages);
      if (r.messages) agent.replaceHistory(r.messages);
      ctx.readFiles.clear(); // restored files must be read again before editing
      await store.sync(agent);
      return r;
    },
    async clear() {
      idle();
      await store.sync(agent);
      await saveState();
      await adoptSession(new SessionStore(opts.cwd, randomUUID()), { messages: [], checkpoints: [] }, { model: true, thinking: true, mode: true });
    },
    // Quitting never waits for MCP servers that are still starting: they are closed once they finish connecting.
    close: async () => {
      const mcp = await Promise.race([mcpConnecting, new Promise<undefined>((resolve) => setTimeout(resolve, 200))]);
      if (mcp) await mcp.close();
      else void mcpConnecting.then((m) => m.close());
    },
  };
}
