import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { App } from './app.js';
import { HOME_DIR, THINKING_LEVELS, type ThinkingLevel } from './config.js';
import { GO_LIMITS, spendWindows } from './cost/ledger.js';
import { isZdr } from './providers/catalog.js';
import type { PermissionMode } from './permissions.js';
import { SessionStore } from './session/store.js';
import { formatTokens, formatUsage } from './ui/format.js';
import type { ModelMessage } from 'ai';
import { checkApiKey, maskKey, removeProjectAllowRule, saveApiKey, userProjectAllow } from './config.js';
import { apiFetch } from './providers/net.js';
import { copyTargets, copyToClipboard } from './ui/clipboard.js';
import { formatChecks, runDoctor } from './doctor.js';
import type { RewindMode } from './session/checkpoints.js';
import { INTERJECTION_PREFIX } from './agent/agent.js';
import { readChangelog } from './changelog.js';
import { VERSION } from './version.js';

export interface CommandResult {
  output?: string;
  /** Text to submit to the agent as the user's prompt. */
  prompt?: string;
  exit?: boolean;
  /** Ask the user to pick one option, then continue with `select`. */
  choose?: Choice;
  /** The conversation was replaced (resume, rewind, clear): redraw it. */
  reload?: boolean;
  /** Text to put back into the input box (e.g. the prompt that was rewound). */
  input?: string;
  /** File diffs to show. */
  diffs?: Array<{ path: string; diff: string }>;
  /** Markdown to render like an answer (e.g. release notes). */
  markdown?: string;
  /** Something was put on the clipboard (the TUI flashes a notice). */
  copied?: boolean;
}

export interface Choice {
  title: string;
  options: Array<{ label: string; hint?: string }>;
  select(index: number): Promise<CommandResult>;
}

export interface SlashCommand {
  name: string;
  description: string;
  argHint?: string;
  run(app: App, arg: string): Promise<CommandResult>;
  /** Argument candidates for completion menus. */
  suggest?(app: App): Promise<Array<{ value: string; hint?: string }>>;
}

/** /command: everything the bottom bar no longer spells out. */
export const KEYS_HELP = [
  'Keys',
  '  ctrl+t          thinking on/off (/think for the level and showing it)',
  '  shift+tab       permission mode: default → acceptEdits → plan → bypass (/mode for dangerous)',
  '  ctrl+o          expand/collapse tool output, thinking and diffs',
  '  ctrl+v          paste an image from the clipboard',
  '  ctrl+r          search earlier prompts',
  '  ctrl+g          edit the prompt in $EDITOR',
  '  ctrl+l          redraw the screen',
  '  ctrl+c          copy the selection, else clear the input, else quit',
  '  esc             interrupt the agent',
  '  shift+arrows    select text in the prompt',
  '  \\ enter         new line (shift+enter where the terminal supports it)',
  '',
  'Bottom bar',
  '  path ⎇ branch                 working directory and git branch',
  '  ctx ▕███░░░░░░░▏ 38% (500k)   context used of the limit in brackets (/context)',
  '  5h  ▕█░░░░░░░░░▏ 1%           OpenCode Go spend in the 5-hour window, this machine (/cost)',
  '  model · medium · bypass · mcp 2/3',
  '                                model, thinking level (ctrl+t), permission mode (shift+tab),',
  '                                MCP servers connected/configured (/mcp)',
].join('\n');

const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypass', 'dangerous'];

const INIT_PROMPT = `Analyze this repository and create a TESSERA.md file in the working directory with guidance for future coding sessions. Include:
- Build, lint and test commands (including how to run a single test)
- High-level architecture that requires reading multiple files to understand
- Project-specific conventions that are not obvious from any single file
Keep it concise; do not list every file or include generic advice. If TESSERA.md, AGENTS.md or CLAUDE.md already exists, improve it instead.`;

/** Text of the latest assistant answer (all assistant messages after the last user prompt). */
export function lastAnswer(messages: ModelMessage[]): string {
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && !(typeof m.content === 'string' && m.content.startsWith(INTERJECTION_PREFIX))) break;
    if (m.role !== 'assistant') continue;
    const text = typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
    if (text.trim()) out.unshift(text.trim());
  }
  return out.join('\n\n');
}

function ago(date: Date | string): string {
  const s = (Date.now() - new Date(date).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

function oneLine(text: string, max = 70): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

const REWIND_MODES: Array<{ mode: RewindMode; label: string; hint: string }> = [
  { mode: 'both', label: 'Conversation and code', hint: 'undo the files and forget the conversation from here' },
  { mode: 'conversation', label: 'Conversation only', hint: 'keep the files as they are now' },
  { mode: 'code', label: 'Code only', hint: 'keep the conversation' },
];

async function rewindTo(app: App, turn: number, mode: RewindMode): Promise<CommandResult> {
  const cp = app.checkpoints.list.find((c) => c.turn === turn);
  if (!cp) return { output: 'That point is no longer available.' };
  const r = await app.rewind(cp, mode);
  const lines = [
    r.files.length ? `Restored ${r.files.length} file${r.files.length > 1 ? 's' : ''}: ${r.files.join(', ')}` : mode !== 'conversation' ? 'No file changes to undo (changes made with bash are not tracked).' : '',
    mode !== 'code' ? (r.conversation ? 'Conversation rewound to before: ' + oneLine(cp.prompt) : 'The conversation was compacted or cleared since then; only files were restored.') : '',
    r.redo ? 'The files as they were before this rewind were saved: /undo brings them back.' : '',
  ].filter(Boolean);
  return { output: lines.join('\n'), reload: r.conversation, input: r.conversation ? cp.prompt : undefined };
}

async function newSession(app: App): Promise<CommandResult> {
  const previous = app.agent.messages.length ? app.agent.sessionId : undefined;
  await app.clear();
  return { reload: true, output: previous ? `New session. Resume the previous one with /resume or: tessera-code -r ${previous.slice(0, 8)}` : 'New session.' };
}

function pct(n: number, of: number): string {
  return `${((n / of) * 100).toFixed(0)}%`;
}

export const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    name: 'help',
    description: 'list commands',
    async run(app) {
      const all = await loadCommands(app.ctx.cwd);
      return { output: all.map((c) => `/${(c.name + (c.argHint ? ` ${c.argHint}` : '')).padEnd(22)} ${c.description}`).join('\n') };
    },
  },
  {
    name: 'auth',
    description: 'register the OpenCode Go API key (stored in ~/.tessera-code/config.json)',
    argHint: '[key]',
    async run(app, arg) {
      const key = arg.trim();
      if (!key) {
        return {
          output: app.agent.apiKey
            ? `API key ${maskKey(app.agent.apiKey)} · from ${app.apiKeySource}. Run /auth <key> to replace it.`
            : 'No API key registered. Get one at https://opencode.ai (OpenCode Go), then run /auth <key>.',
        };
      }
      if (/\s/.test(key)) return { output: 'An API key has no spaces. Usage: /auth <key>' };
      const check = await checkApiKey(key, apiFetch);
      if (check === 'rejected') return { output: `✗ OpenCode Go rejected ${maskKey(key)}; nothing was saved. Check the key and try again.` };
      await saveApiKey(key);
      app.setApiKey(key, '~/.tessera-code/config.json');
      const env = process.env.OPENCODE_API_KEY ? ' (OPENCODE_API_KEY is set in the environment and will override it on the next start)' : '';
      return {
        output:
          check === 'ok'
            ? `✓ API key ${maskKey(key)} verified and saved to ~/.tessera-code/config.json${env}.`
            : `API key ${maskKey(key)} saved to ~/.tessera-code/config.json, but it could not be verified now (network?)${env}.`,
      };
    },
  },
  {
    name: 'command',
    description: 'keyboard shortcuts and what the bottom bar shows',
    async run() {
      return { output: KEYS_HELP };
    },
  },
  {
    name: 'model',
    description: 'show or switch the model',
    argHint: '[id]',
    async run(app, arg) {
      if (!arg) return { output: `${app.agent.model.id} (${app.agent.model.format})` };
      if (!app.catalog.some((m) => m.id === arg)) return { output: `Unknown model "${arg}". See /models.` };
      if (!isZdr(arg)) return { output: `${arg} is not zero-data-retention and is not allowed.` };
      await app.setModel(arg);
      return { output: `Model set to ${app.agent.model.id} (${app.agent.model.format})` };
    },
    async suggest(app) {
      return app.catalog
        .filter((m) => isZdr(m.id))
        .map((m) => ({
          value: m.id,
          hint: `${m.id === app.agent.model.id ? 'current · ' : ''}ctx ${formatTokens(m.context)} · $${m.cost.input}/$${m.cost.output} per 1M${m.reasoning ? ' · thinking' : ''}`,
        }));
    },
  },
  {
    name: 'models',
    description: 'list available models',
    async run(app) {
      return {
        output: app.catalog
          .filter((m) => isZdr(m.id))
          .map((m) => `${m.id === app.agent.model.id ? '●' : ' '} ${m.id.padEnd(28)} ${m.format.padEnd(9)} ctx ${formatTokens(m.context).padEnd(7)} $${m.cost.input}/$${m.cost.output}`)
          .join('\n'),
      };
    },
  },
  {
    name: 'new',
    description: 'start a new session (the current one stays resumable)',
    run: newSession,
  },
  {
    name: 'clear',
    description: 'same as /new',
    run: newSession,
  },
  {
    name: 'changelog',
    description: 'release notes: this version | all | a version',
    argHint: '[all|x.y.z]',
    async run(_app, arg) {
      const sections = await readChangelog();
      if (!sections.length) return { output: 'No CHANGELOG.md found in this installation.' };
      const wanted = arg === 'all' ? sections : sections.filter((s) => s.version === (arg || VERSION));
      if (!wanted.length) return { output: `No notes for ${arg || VERSION}. Versions: ${sections.map((s) => s.version).join(', ')}` };
      return { markdown: wanted.map((s) => s.markdown).join('\n\n') };
    },
    async suggest() {
      const sections = await readChangelog();
      return [{ value: 'all', hint: 'every version' }, ...sections.map((s) => ({ value: s.version, hint: s.version === VERSION ? 'current' : '' }))];
    },
  },
  {
    name: 'compact',
    description: 'summarize the conversation to free context',
    argHint: '[focus]',
    async run(app, arg) {
      const before = app.agent.contextTokens;
      await app.agent.compact(arg || undefined);
      await app.store.sync(app.agent);
      return { output: `Compacted conversation (was ${formatTokens(before)} tokens of context).` };
    },
  },
  {
    name: 'cost',
    description: 'session usage and estimated OpenCode Go spend',
    async run(app) {
      const w = await spendWindows();
      return {
        output: [
          `Session: ${formatUsage(app.agent.total)}`,
          `Go spend (this machine): 5h $${w.fiveHour.toFixed(2)}/${GO_LIMITS.fiveHour} (${pct(w.fiveHour, GO_LIMITS.fiveHour)}) · ` +
            `week $${w.week.toFixed(2)}/${GO_LIMITS.week} · month $${w.month.toFixed(2)}/${GO_LIMITS.month}`,
        ].join('\n'),
      };
    },
  },
  {
    name: 'mode',
    description: 'permission mode: default | acceptEdits | plan | bypass | dangerous',
    argHint: '[mode]',
    async run(app, arg) {
      if (arg) {
        const mode = arg === 'edit' ? 'acceptEdits' : arg;
        if (!MODES.includes(mode as PermissionMode)) return { output: `Unknown mode. Choose one of: ${MODES.join(', ')} (or edit)` };
        await app.setPermissionMode(mode as PermissionMode);
        return { output: `Permission mode: ${mode} (saved to ~/.tessera-code/config.json for every project)` };
      }
      return { output: `Permission mode: ${app.permissions.mode}` };
    },
    async suggest(app) {
      const hints: Record<PermissionMode, string> = {
        default: 'ask before edits and commands',
        acceptEdits: 'apply edits without asking; still ask for commands',
        plan: 'read-only: no edits or commands',
        bypass: 'ask only for destructive commands (careful)',
        dangerous: 'never ask, not even for rm -rf or files outside the project',
      };
      return MODES.map((m) => ({ value: m, hint: `${m === app.permissions.mode ? 'current · ' : ''}${hints[m]}` }));
    },
  },
  {
    name: 'think',
    description: 'reasoning: on | off | low | medium | high; show | hide its text',
    argHint: '[on|off|low|medium|high|show|hide]',
    async run(app, arg) {
      const { agent } = app;
      if (arg === 'show' || arg === 'hide') {
        app.config.showThinking = arg === 'show';
        return { output: app.config.showThinking ? 'Thinking is shown while the model works (folded afterwards; ctrl+o expands).' : 'Thinking is hidden (only the status line shows it is thinking; ctrl+o still shows it in full).' };
      }
      if (!agent.model.reasoning) return { output: `${agent.model.id} has no reasoning mode.` };
      if (arg && arg !== 'on' && arg !== 'off' && !THINKING_LEVELS.includes(arg as ThinkingLevel)) return { output: 'Usage: /think [on|off|low|medium|high|show|hide]' };
      if (THINKING_LEVELS.includes(arg as ThinkingLevel)) {
        agent.thinkingLevel = arg as ThinkingLevel;
        agent.thinking = true;
      } else agent.thinking = arg ? arg === 'on' : !agent.thinking;
      return { output: agent.thinking ? `Thinking on (${agent.thinkingLevel}) — slower, more accurate` : 'Thinking off — faster, best for simple edits' };
    },
    async suggest(app) {
      const { thinking: on, thinkingLevel: level } = app.agent;
      const hints: Record<ThinkingLevel, string> = { low: 'quick reasoning', medium: 'balanced (default)', high: 'deepest, slowest' };
      return [
        { value: 'on', hint: `${on ? 'current · ' : ''}reasoning at ${level}` },
        { value: 'off', hint: `${on ? '' : 'current · '}faster, best for simple edits` },
        ...THINKING_LEVELS.map((l) => ({ value: l, hint: `${on && l === level ? 'current · ' : ''}${hints[l]}` })),
        { value: 'show', hint: `${app.config.showThinking ? 'current · ' : ''}show thinking text` },
        { value: 'hide', hint: `${app.config.showThinking ? '' : 'current · '}hide thinking text` },
      ];
    },
  },
  {
    name: 'context',
    description: 'show context window usage',
    async run(app) {
      const { contextTokens, model, contextLimit, messages } = app.agent;
      return {
        output: `${formatTokens(contextTokens)} / ${formatTokens(contextLimit)} tokens (${pct(contextTokens, contextLimit)}) · ${messages.length} messages · auto-compacts at the limit (model window ${formatTokens(model.context)})`,
      };
    },
  },
  {
    name: 'resume',
    description: 'continue an earlier session of this directory',
    argHint: '[id]',
    async run(app, arg) {
      const list = (await SessionStore.list(app.ctx.cwd)).filter((x) => x.id !== app.agent.sessionId);
      const open = async (id: string): Promise<CommandResult> => {
        await app.switchSession(id);
        return { reload: true, output: `Resumed ${app.title ? `"${app.title}"` : id.slice(0, 8)} (${app.agent.messages.length} messages).` };
      };
      if (arg) {
        const hit = list.find((x) => x.id.startsWith(arg));
        return hit ? open(hit.id) : { output: `No session ${arg}. Run /resume to pick one.` };
      }
      if (!list.length) return { output: 'No other sessions in this directory.' };
      return {
        choose: {
          title: 'Resume a session',
          options: list.map((x) => ({ label: oneLine(x.title, 60), hint: `${ago(x.updatedAt)} · ${x.messages} msgs${x.model ? ` · ${x.model}` : ''} · ${x.id.slice(0, 8)}` })),
          select: (i) => open(list[i]!.id),
        },
      };
    },
    async suggest(app) {
      return (await SessionStore.list(app.ctx.cwd))
        .filter((x) => x.id !== app.agent.sessionId)
        .map((x) => ({ value: x.id.slice(0, 8), hint: `${oneLine(x.title, 40)} · ${ago(x.updatedAt)} · ${x.messages} msgs` }));
    },
  },
  {
    name: 'sessions',
    description: 'list sessions in this directory',
    async run(app) {
      const list = await SessionStore.list(app.ctx.cwd);
      return { output: list.slice(0, 15).map((s) => `${s.id === app.agent.sessionId ? '●' : ' '} ${s.id.slice(0, 8)}  ${ago(s.updatedAt).padEnd(9)} ${String(s.messages).padStart(4)} msgs  ${s.title}`).join('\n') || 'No sessions.' };
    },
  },
  {
    name: 'rename',
    description: 'set the session title',
    argHint: '<title>',
    async run(app, arg) {
      if (!arg) return { output: `Title: ${app.title ?? '(none yet)'}. Usage: /rename <title>` };
      await app.rename(arg.slice(0, 80));
      return { output: `Session renamed to "${arg.slice(0, 80)}".` };
    },
  },
  {
    name: 'fork',
    description: 'copy this session and continue in the copy',
    async run(app) {
      if (!app.agent.messages.length) return { output: 'Nothing to fork yet.' };
      const original = app.agent.sessionId;
      const id = await app.fork();
      return { output: `Forked into ${id.slice(0, 8)}. The original stays as it was: /resume ${original.slice(0, 8)}` };
    },
  },
  {
    name: 'undo',
    description: 'undo the last turn: its file changes and messages',
    async run(app) {
      const cp = app.checkpoints.list.at(-1);
      if (!cp) return { output: 'Nothing to undo in this session.' };
      return rewindTo(app, cp.turn, 'both');
    },
  },
  {
    name: 'rewind',
    description: 'go back to before an earlier prompt (code and/or conversation)',
    async run(app) {
      const list = [...app.checkpoints.list].reverse();
      if (!list.length) return { output: 'Nothing to rewind in this session.' };
      return {
        choose: {
          title: 'Rewind to before…',
          options: list.map((c) => ({
            label: oneLine(c.prompt, 60),
            hint: `${ago(c.at)}${c.files.length ? ` · ${c.files.length} file${c.files.length > 1 ? 's' : ''}` : ''}${app.checkpoints.reachable(c, app.agent.messages) ? '' : ' · files only'}`,
          })),
          select: async (i) => {
            const cp = list[i]!;
            return {
              choose: {
                title: `Rewind to before "${oneLine(cp.prompt, 40)}"`,
                options: REWIND_MODES.map((m) => ({ label: m.label, hint: m.hint })),
                select: (j) => rewindTo(app, cp.turn, REWIND_MODES[j]!.mode),
              },
            };
          },
        },
      };
    },
  },
  {
    name: 'diff',
    description: 'show the file changes made in this session',
    async run(app) {
      const all = await app.checkpoints.diff();
      if (!all) return { output: 'No file changes in this session (changes made with bash are not tracked).' };
      const diffs = all.split(/\n\n(?=\S)/).map((block) => {
        const [head, ...rest] = block.split('\n');
        return { path: head!, diff: rest.join('\n') };
      });
      return { diffs, output: `${diffs.length} file${diffs.length > 1 ? 's' : ''} changed in this session.` };
    },
  },
  {
    name: 'permissions',
    description: 'show and remove "always allow" rules',
    async run(app) {
      const project = await userProjectAllow(app.ctx.cwd);
      const session = app.permissions.sessionAllowed;
      const fromConfig = app.config.allow.filter((r) => !project.includes(r));
      const rules = [
        ...session.map((rule) => ({ rule, source: 'this session', removable: true })),
        ...project.map((rule) => ({ rule, source: 'always (this project)', removable: true })),
        ...fromConfig.map((rule) => ({ rule, source: 'config file', removable: false })),
      ];
      if (!rules.length) return { output: `No allow rules. Permission mode: ${app.permissions.mode}.` };
      return {
        choose: {
          title: 'Allow rules (select one to remove it)',
          options: rules.map((r) => ({ label: r.rule, hint: r.source + (r.removable ? '' : ' · edit the config file to remove') })),
          async select(i) {
            const r = rules[i]!;
            if (!r.removable) return { output: `${r.rule} comes from a config file (~/.tessera-code/config.json or .tessera/settings.json); edit it there.` };
            app.permissions.forget(r.rule);
            await removeProjectAllowRule(app.ctx.cwd, r.rule);
            app.config.allow = app.config.allow.filter((x) => x !== r.rule);
            return { output: `Removed ${r.rule}. The agent will ask again.` };
          },
        },
      };
    },
  },
  {
    name: 'copy',
    description: 'copy the last response or one of its code blocks',
    argHint: '[n]',
    async run(app, arg) {
      const answer = lastAnswer(app.agent.messages);
      if (!answer) return { output: 'No response to copy yet.' };
      const targets = copyTargets(answer);
      const copy = async (i: number): Promise<CommandResult> => {
        const t = targets[i];
        if (!t) return { output: `No block ${i}. Run /copy to pick.` };
        const via = await copyToClipboard(t.text);
        return { copied: Boolean(via), output: via ? `Copied ${t.label.toLowerCase()} (${t.hint.split(' · ')[0]}) via ${via}.` : 'Could not reach the clipboard (no pbcopy/wl-copy/xclip and no terminal support).' };
      };
      if (arg) return copy(Number(arg));
      if (targets.length === 1) return copy(0);
      return { choose: { title: 'Copy', options: targets.map((t) => ({ label: t.label, hint: t.hint })), select: copy } };
    },
    async suggest(app) {
      const answer = lastAnswer(app.agent.messages);
      return answer ? copyTargets(answer).map((t, i) => ({ value: String(i), hint: `${t.label} · ${t.hint}` })) : [];
    },
  },
  {
    name: 'doctor',
    description: 'check API key, network, models and the environment',
    async run(app) {
      return { output: formatChecks(await runDoctor(app)) };
    },
  },
  {
    name: 'mcp',
    description: 'show MCP server status',
    async run(app) {
      await app.mcpReady;
      if (!app.mcpStatus.length) return { output: 'No MCP servers configured. Add "mcpServers" to .tessera/settings.json or ~/.tessera-code/config.json.' };
      return {
        output: app.mcpStatus.map((s) => (s.ok ? `● ${s.name}: ${s.tools.length} tools (${s.tools.join(', ')})` : `✗ ${s.name}: ${s.error}`)).join('\n'),
      };
    },
  },
  {
    name: 'init',
    description: 'create a TESSERA.md with project guidance',
    async run() {
      return { prompt: INIT_PROMPT };
    },
  },
  {
    name: 'exit',
    description: 'quit',
    async run() {
      return { exit: true };
    },
  },
];

/** Parses optional `---\ndescription: ...\n---` frontmatter. */
function parseCommandFile(name: string, raw: string): SlashCommand {
  let body = raw;
  let description = 'custom command';
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (fm) {
    body = raw.slice(fm[0].length);
    const d = /^description:\s*(.+)$/m.exec(fm[1]!);
    if (d) description = d[1]!.trim();
  }
  return {
    name,
    description,
    argHint: body.includes('$ARGUMENTS') ? '<args>' : undefined,
    async run(_app, arg) {
      return { prompt: body.includes('$ARGUMENTS') ? body.replaceAll('$ARGUMENTS', arg) : arg ? `${body}\n\n${arg}` : body };
    },
  };
}

/** Built-ins plus markdown commands from ~/.tessera-code/commands and .tessera/commands (project wins). */
export async function loadCommands(cwd: string): Promise<SlashCommand[]> {
  const byName = new Map(BUILTIN_COMMANDS.map((c) => [c.name, c]));
  for (const dir of [join(HOME_DIR, 'commands'), join(cwd, '.tessera', 'commands')]) {
    if (!existsSync(dir)) continue;
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.md')) continue;
      const name = basename(f, '.md');
      if (BUILTIN_COMMANDS.some((c) => c.name === name)) continue; // built-ins cannot be shadowed
      byName.set(name, parseCommandFile(name, await readFile(join(dir, f), 'utf8')));
    }
  }
  return [...byName.values()];
}

export async function runCommand(app: App, line: string): Promise<CommandResult> {
  const [name = '', ...rest] = line.slice(1).split(/\s+/);
  const cmd = (await loadCommands(app.ctx.cwd)).find((c) => c.name === name);
  if (!cmd) return { output: `Unknown command /${name}. Try /help.` };
  return cmd.run(app, rest.join(' ').trim());
}
