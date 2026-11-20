import { randomUUID } from 'node:crypto';
import type { App } from '../app.js';
import type { Choice, CommandResult } from '../commands.js';
import type { PermissionMode, PermissionRequest } from '../permissions.js';
import { formatClock, formatTiming, formatTokens, formatUsage, outputText, redactSecret, toolLabel } from '../ui/format.js';
import { transcriptOf } from '../ui/transcript.js';
import type { Decision, RemoteEvent, Sequenced, SessionState } from './protocol.js';

/**
 * Commands the remote app may not run: they change keys, global settings, prompts, rules or skills, re-trust project
 * settings, or act on this computer's desktop. (A paired device can still run any shell line with "!": pairing is
 * the boundary; these keep the setup of the computer itself out of a remote session's reach.)
 */
const BLOCKED_COMMANDS = new Set(['auth', 'prompt', 'providers', 'permissions', 'copy', 'exit', 'command', 'agents']);
/** Subcommands blocked remotely: skills are installed for every project (and re-trust project settings); a reload
 * would start MCP servers added to the project since it was trusted. */
const BLOCKED_SUBCOMMANDS: Record<string, RegExp> = { skill: /^(new|install|remove)\b/i, mcp: /^reload\b/i };
/** Permission modes a remote session may switch to (for this session only; the saved default is not changed). */
const REMOTE_MODES: Record<string, PermissionMode> = { default: 'default', acceptEdits: 'acceptEdits', edit: 'acceptEdits', plan: 'plan' };
/** Tool output beyond this is cut for the remote view (the model still got all of it). */
const MAX_OUTPUT = 20_000;
/** Streamed text is sent in pieces at most this often. */
const STREAM_MS = 80;

export type Listener = (e: Sequenced) => void;

/**
 * One session driven from the remote app: runs turns, shell lines and commands like the TUI does, and records what
 * happens as numbered events. Clients read the record from any point (a reconnect resumes after the last event it
 * saw) and get new events as they come.
 */
export class SessionController {
  private log: Sequenced[] = [];
  private seq = 0;
  private listeners = new Set<Listener>();
  private abort?: AbortController;
  private busy?: string;
  private turn = false;
  private queue: string[] = [];
  private interjecting: string[] = [];
  private pending = new Map<string, { done: (d: Decision) => void; rememberable: boolean }>();
  private choices = new Map<string, Choice>();
  private stream?: { kind: 'text' | 'reasoning'; text: string; timer: ReturnType<typeof setTimeout> };
  private diffs: Array<{ path: string; diff: string }> = [];
  private closed = false;
  readonly id = randomUUID();

  constructor(
    private app: App,
    private opts: { maxEvents?: number } = {},
  ) {
    this.history();
  }

  state(): SessionState {
    const { agent } = this.app;
    return {
      id: this.id,
      session: agent.sessionId,
      cwd: this.app.ctx.cwd,
      title: this.app.title,
      model: agent.model.id,
      thinking: agent.model.reasoning ? agent.thinking : undefined,
      thinkingAuto: agent.model.reasoning && agent.thinking ? agent.thinkingAuto : undefined,
      mode: this.app.permissions.mode,
      busy: this.busy,
      queued: [...this.interjecting.map((t) => `↳ ${t}`), ...this.queue],
    };
  }

  /** Recorded events after `after` (all of them without it). `reset`: events before the oldest one were dropped. */
  events(after?: number): { events: Sequenced[]; reset: boolean } {
    if (after === undefined) return { events: [...this.log], reset: false };
    const first = this.log[0]?.seq ?? this.seq + 1;
    return { events: this.log.filter((e) => e.seq > after), reset: after < first - 1 };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** The app's permission prompt: shown to the connected clients until one answers or the turn ends. */
  ask = (req: PermissionRequest): Promise<Decision> =>
    new Promise((resolve) => {
      if (req.signal?.aborted || this.closed) return resolve('deny');
      const id = randomUUID();
      const label = this.busy;
      const done = (d: Decision) => {
        if (!this.pending.delete(id)) return;
        req.signal?.removeEventListener('abort', onAbort);
        this.emit({ kind: 'permission-done', id, decision: d });
        if (this.busy === 'Waiting for approval') this.setBusy(label);
        resolve(d);
      };
      const onAbort = () => done('deny');
      req.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { done, rememberable: !req.sensitive });
      this.emit({ kind: 'permission', id, title: req.title, detail: req.detail, tool: req.tool, rememberable: !req.sensitive });
      this.setBusy('Waiting for approval');
    });

  /**
   * Answers a permission prompt; false when it was already answered (by another client) or is unknown. Nothing is
   * remembered beyond this session from remote (no "always" rules on disk), and sensitive requests not even for it.
   */
  answer(id: string, decision: Decision): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    const d = decision === 'allow-always' ? 'allow-session' : decision;
    p.done(p.rememberable || d === 'deny' ? d : 'allow-once');
    return true;
  }

  /** Diffs arrive from inside a tool; they are shown after its result line. */
  onDiff = (path: string, diff: string): void => {
    this.diffs.push({ path, diff });
  };

  /** A message from the app: a prompt, "!command" or "/command". While busy it steers the turn or waits its turn. */
  send(raw: string): void {
    const text = raw.trim();
    if (!text || this.closed) return;
    if (this.busy) {
      if (this.turn && !/^[/!]/.test(text)) {
        this.app.agent.interject(text);
        this.interjecting.push(text);
      } else {
        this.queue.push(text);
      }
      this.pushState();
      return;
    }
    void this.dispatch(text);
  }

  interrupt(): void {
    this.abort?.abort();
  }

  async choose(id: string, index: number): Promise<boolean> {
    const choice = this.choices.get(id);
    if (!choice || this.busy) return false;
    this.choices.delete(id);
    this.emit({ kind: 'choose-done', id });
    if (!Number.isInteger(index) || index < 0 || index >= choice.options.length) return true; // dismissed
    await this.command(() => choice.select(index));
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abort?.abort();
    for (const p of [...this.pending.values()]) p.done('deny');
    this.flushStream();
    await this.app.close();
  }

  private async dispatch(text: string): Promise<void> {
    if (text.startsWith('!')) {
      this.emit({ kind: 'user', text });
      const command = text.slice(1).trim();
      const controller = this.start(`Running ${command}`);
      try {
        const { output, code } = await this.app.shell(command, controller.signal);
        this.emit({ kind: 'tool-result', id: '', label: `$ ${command}`, output: cut(output || '(no output)'), isError: code !== 0 && !controller.signal.aborted });
        this.emit({ kind: 'info', text: 'Output will be shared with the model along with your next message.' });
      } catch (e) {
        this.emit({ kind: 'error', text: (e as Error).message });
      } finally {
        this.finish();
      }
    } else if (text.startsWith('/')) {
      this.emit({ kind: 'user', text: redactSecret(text) }); // "/auth <key>" is never shown with the key
      const [name = '', ...rest] = text.slice(1).split(/\s+/);
      const args = rest.join(' ').trim();
      if (BLOCKED_COMMANDS.has(name) || BLOCKED_SUBCOMMANDS[name]?.test(args)) {
        // Only a blocked subcommand's name is echoed: the arguments may be a key ("/auth sk-…").
        const what = BLOCKED_COMMANDS.has(name) ? name : `${name} ${args.split(/\s+/)[0]}`;
        this.emit({ kind: 'error', text: `/${what} is not available remotely; run it on the computer.` });
      } else if (name === 'mode') {
        const mode = Object.hasOwn(REMOTE_MODES, args) ? REMOTE_MODES[args] : undefined;
        if (mode) {
          this.app.permissions.mode = mode;
          this.emit({ kind: 'info', text: `Permission mode: ${mode} (this session only)` });
          this.pushState();
        } else {
          this.emit({ kind: 'error', text: args ? `/mode ${args} can only be set on the computer.` : 'Give the mode: /mode default, /mode acceptEdits or /mode plan.' });
        }
      } else {
        const { runCommand } = await import('../commands.js');
        await this.command(() => runCommand(this.app, text));
      }
    } else {
      await this.runTurn(text, this.emit({ kind: 'user', text }));
    }
    this.drain();
  }

  private async command(run: () => Promise<CommandResult>): Promise<void> {
    this.start('Running command');
    let r: CommandResult;
    try {
      r = await run();
    } catch (e) {
      this.emit({ kind: 'error', text: (e as Error).message });
      return;
    } finally {
      this.finish();
    }
    if (r.reload) {
      this.emit({ kind: 'reset' });
      this.history();
    }
    if (r.output) this.emit({ kind: 'info', text: r.output });
    if (r.markdown) this.emit({ kind: 'markdown', text: r.markdown });
    for (const d of r.diffs ?? []) this.emit({ kind: 'diff', path: d.path, diff: d.diff });
    if (r.choose) {
      const id = randomUUID();
      this.choices.set(id, r.choose);
      this.emit({ kind: 'choose', id, title: r.choose.title, options: r.choose.options });
    }
    if (r.prompt) await this.runTurn(r.prompt);
    this.pushState(); // model, mode, title may have changed
  }

  /** `userSeq`: the event of the prompt as typed; a turn cancelled before any answer removes everything from it on. */
  private async runTurn(prompt: string, userSeq?: number): Promise<void> {
    const controller = this.start('Thinking');
    this.turn = true;
    const labels = new Map<string, string>();
    let discarded = false;
    try {
      for await (const ev of this.app.run(prompt, controller.signal)) {
        switch (ev.type) {
          case 'text':
          case 'reasoning':
            this.streamText(ev.type, ev.text);
            this.setBusy(ev.type === 'text' ? 'Writing' : 'Reasoning');
            break;
          case 'tool-input-start':
            this.setBusy(`Preparing ${ev.name}`);
            break;
          case 'step-finish':
            this.setBusy('Thinking');
            break;
          case 'tool-call': {
            const label = toolLabel(ev.name, ev.input);
            labels.set(ev.id, label);
            this.emit({ kind: 'tool', id: ev.id, label });
            this.setBusy(`Running ${label}`);
            break;
          }
          case 'tool-result':
            this.emit({ kind: 'tool-result', id: ev.id, label: labels.get(ev.id) ?? ev.name, output: cut(outputText(ev.output)), isError: ev.isError });
            for (const d of this.diffs.splice(0)) this.emit({ kind: 'diff', ...d });
            this.setBusy('Thinking');
            break;
          case 'info':
            this.emit({ kind: 'info', text: ev.text });
            break;
          case 'interjection':
            this.interjecting = this.interjecting.filter((t) => t !== ev.text);
            this.emit({ kind: 'user', text: `↳ ${ev.text}` });
            this.pushState();
            break;
          case 'fallback':
            this.emit({ kind: 'info', text: `↪ ${ev.from} ${ev.reason}; switched to ${ev.to}` });
            break;
          case 'compacted':
            this.emit({ kind: 'info', text: `(context compacted from ${formatTokens(ev.before)} tokens)` });
            break;
          case 'turn-finish':
            if (ev.discarded && userSeq !== undefined) discarded = true;
            else this.emit({ kind: 'turn-finish', summary: `${formatTiming(ev)} · ${formatUsage(ev.usage)}` });
            break;
          case 'error':
            this.emit({ kind: 'error', text: ev.message });
            break;
        }
      }
    } catch (e) {
      this.emit({ kind: 'error', text: (e as Error).message });
    } finally {
      this.flushStream();
      this.diffs = [];
      const unread = this.app.agent.takeInterjections();
      this.interjecting = [];
      if (discarded) {
        // Nothing was answered: the turn leaves no trace, and the message goes back to the sender's input.
        this.log = this.log.filter((e) => e.seq < userSeq!);
        this.emit({ kind: 'discard', from: userSeq!, text: [prompt, ...unread].join('\n') });
      } else {
        if (controller.signal.aborted) this.emit({ kind: 'info', text: 'Interrupted.' });
        if (controller.signal.aborted && unread.length) this.emit({ kind: 'info', text: `Not delivered: ${unread.join(' / ')}` });
        else this.queue.push(...unread);
      }
      this.turn = false;
      this.finish();
    }
  }

  /** Runs what was typed while busy, one at a time, once idle. */
  private drain(): void {
    if (this.busy || this.closed) return;
    const next = this.queue.shift();
    if (next !== undefined) void this.dispatch(next);
    else this.pushState();
  }

  private start(label: string): AbortController {
    this.abort = new AbortController();
    this.setBusy(label);
    return this.abort;
  }

  private finish(): void {
    this.abort = undefined;
    this.setBusy(undefined);
  }

  /** Recorded history of a resumed or replaced conversation. */
  private history(): void {
    for (const e of transcriptOf(this.app.agent.messages)) {
      if (e.kind === 'user') this.emit({ kind: 'user', text: e.text });
      else if (e.kind === 'assistant') this.emit({ kind: 'markdown', text: e.text });
      else if (e.kind === 'tool') this.emit({ kind: 'tool-result', id: '', label: e.label, output: cut(e.output), isError: e.isError ?? false });
      else this.emit({ kind: 'info', text: e.text });
    }
  }

  private streamText(kind: 'text' | 'reasoning', text: string): void {
    if (this.stream && this.stream.kind !== kind) this.flushStream();
    if (!this.stream) this.stream = { kind, text: '', timer: setTimeout(() => this.flushStream(), STREAM_MS) };
    this.stream.text += text;
  }

  private flushStream(): void {
    const s = this.stream;
    if (!s) return;
    clearTimeout(s.timer);
    this.stream = undefined;
    if (s.text) this.record({ kind: s.kind, text: s.text });
  }

  /** Records an event (after any streamed text before it) and sends it; returns its seq. */
  private emit(event: RemoteEvent): number {
    this.flushStream();
    return this.record(event);
  }

  private record(event: RemoteEvent): number {
    const e = { seq: ++this.seq, event };
    this.log.push(e);
    if (this.log.length > (this.opts.maxEvents ?? 5000)) this.log.shift();
    for (const fn of this.listeners) fn(e);
    return e.seq;
  }

  private setBusy(label: string | undefined): void {
    if (this.busy === label) return;
    this.busy = label;
    this.pushState();
  }

  /** State changes are not recorded: a client always gets the current state when it connects. */
  private pushState(): void {
    const e = { seq: 0, event: { kind: 'state', state: this.state() } as RemoteEvent };
    for (const fn of this.listeners) fn(e);
  }
}

function cut(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… (${text.length - MAX_OUTPUT} more characters)` : text;
}
