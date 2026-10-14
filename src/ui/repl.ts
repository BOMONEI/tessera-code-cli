import { createInterface, type Interface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { App } from '../app.js';
import type { Decision, PermissionRequest } from '../permissions.js';
import { loadCommands, runCommand, type CommandResult } from '../commands.js';
import { complete } from './completion.js';
import { iconAnsi } from './logo.js';
import { VERSION } from '../version.js';
import { suggestFiles } from '../agent/attachments.js';
import { bold, colorDiff, cyan, dim, formatTiming, formatTokens, formatUsage, red, toolLabel, toolPreview, yellow } from './format.js';

/** Plain readline front end (Phase 2). The Ink TUI supersedes it for interactive use. */
export class Repl {
  private rl: Interface;
  private abort?: AbortController;

  constructor(private app: App) {
    this.rl = createInterface({
      input: stdin,
      output: stdout,
      terminal: true,
      // Tab completes @-mentions with project files.
      // Tab completes /commands, their arguments, @files and earlier !commands (same rules as the TUI menu).
      completer: async (line: string): Promise<[string[], string]> => {
        try {
          const commands = await loadCommands(app.ctx.cwd);
          const name = /^\/(\S+)\s/.exec(line)?.[1];
          const args = name ? ((await commands.find((c) => c.name === name)?.suggest?.(app)) ?? []) : [];
          const c = complete(line, line.length, { commands, args: () => args, files: (q) => suggestFiles(app.ctx.cwd, q, 20), history: [] });
          return c ? [c.items.map((i) => i.value), line.slice(c.start)] : [[], line];
        } catch {
          return [[], line];
        }
      },
    });
  }

  static async ask(rl: Interface, req: PermissionRequest): Promise<Decision> {
    stdout.write(`\n${yellow('⚠ Permission required:')} ${bold(req.title)}\n`);
    if (req.detail) stdout.write((req.tool === 'edit' ? colorDiff(req.detail) : dim(req.detail)) + '\n');
    const saved = req.saveRule ?? req.rule;
    const choices = req.sensitive ? '[y] once  [n] no' : `[y] once  [s] session (${saved})  [a] always (${saved})  [n] no`;
    const answer = (await rl.question(`${dim(choices)} > `)).trim().toLowerCase();
    if (req.sensitive) return answer === 'y' ? 'allow-once' : 'deny';
    return answer === 'y' || answer === '' ? 'allow-once' : answer === 's' ? 'allow-session' : answer === 'a' ? 'allow-always' : 'deny';
  }

  get readline(): Interface {
    return this.rl;
  }

  async start(initialPrompt?: string): Promise<void> {
    const { agent } = this.app;
    const info = [
      `${bold('tessera-code')} ${dim(`v${VERSION}`)}`,
      dim('Fast, precise coding agent'),
      '',
      `${dim('model ')} ${agent.model.id}${agent.model.reasoning ? dim(` · thinking ${agent.thinking ? 'on' : 'off'}`) : ''}`,
      `${dim('cwd   ')} ${this.app.ctx.cwd}`,
    ];
    const icon = stdout.isTTY && (stdout.columns ?? 80) >= 64 ? iconAnsi() : [];
    for (let i = 0; i < Math.max(icon.length, info.length); i++) stdout.write(`  ${icon[i] ?? (icon.length ? ' '.repeat(12) : '')}   ${info[i] ?? ''}\n`);
    stdout.write(dim(`session ${agent.sessionId} · ${this.app.apiKeySource ? `key from ${this.app.apiKeySource}` : 'no API key: /auth <key>'} · /help for commands\n`));
    if (agent.messages.length) stdout.write(dim(`(resumed ${agent.messages.length} messages)\n`));

    this.rl.on('SIGINT', () => {
      if (this.abort) {
        this.abort.abort();
      } else {
        stdout.write('\n');
        this.rl.close();
      }
    });

    let next = initialPrompt;
    for (;;) {
      if (next === undefined) {
        try {
          next = await this.rl.question(`\n${cyan('›')} `);
        } catch {
          break; // readline closed (Ctrl+C / Ctrl+D)
        }
      }
      const input = next.trim();
      next = undefined;
      if (!input) continue;
      if (input.startsWith('/')) {
        if ((await this.command(input)) === 'exit') break;
        continue;
      }
      if (input.startsWith('!')) {
        const { output } = await this.app.shell(input.slice(1).trim());
        stdout.write(dim((output || '(no output)').replace(/^/gm, '  ')) + '\n' + dim('(shared with the model along with your next message)\n'));
        continue;
      }
      await this.turn(input);
    }
    this.rl.close();
  }

  private async turn(input: string): Promise<void> {
    const { agent } = this.app;
    this.abort = new AbortController();
    let inText = false;
    try {
      for await (const ev of this.app.run(input, this.abort.signal)) {
        switch (ev.type) {
          case 'text':
            if (!inText) stdout.write('\n');
            inText = true;
            stdout.write(ev.text);
            break;
          case 'reasoning':
            break;
          case 'tool-call':
            inText = false;
            stdout.write(`\n${cyan('●')} ${toolLabel(ev.name, ev.input)}\n`);
            break;
          case 'tool-result':
            stdout.write(dim(toolPreview(ev.output).replace(/^/gm, '  ⎿ ')) + '\n');
            break;
          case 'turn-finish':
            stdout.write(`\n${dim(`${formatTiming(ev)} · ${formatUsage(ev.usage)} · context ${formatTokens(agent.contextTokens)}/${formatTokens(agent.contextLimit)}`)}\n`);
            break;
          case 'info':
            stdout.write(dim(`${ev.text}\n`));
            break;
          case 'fallback':
            stdout.write(yellow(`\n↪ ${ev.from} ${ev.reason}; switched to ${ev.to}\n`));
            break;
          case 'compacted':
            stdout.write(dim(`(context compacted from ${formatTokens(ev.before)} tokens)\n`));
            break;
          case 'error':
            stdout.write(`\n${red(`✗ ${ev.message}`)}\n`);
            break;
        }
      }
      if (this.abort.signal.aborted) stdout.write(`\n${yellow('Interrupted.')}\n`);
    } finally {
      this.abort = undefined;
    }
  }

  private async command(line: string): Promise<'exit' | void> {
    try {
      let r: CommandResult = await runCommand(this.app, line);
      // Pickers become numbered lists.
      while (r.choose) {
        if (r.output) stdout.write(r.output + '\n');
        const { title, options, select } = r.choose;
        stdout.write(`${title}\n${options.map((o, i) => `  ${String(i + 1).padStart(2)}. ${o.label}${o.hint ? dim(`  ${o.hint}`) : ''}`).join('\n')}\n`);
        const answer = Number((await this.rl.question(dim('number (enter to cancel): '))).trim());
        if (!Number.isInteger(answer) || answer < 1 || answer > options.length) return;
        r = await select(answer - 1);
      }
      if (r.output) stdout.write(r.output + '\n');
      for (const d of r.diffs ?? []) stdout.write(`${d.path}\n${colorDiff(d.diff)}\n`);
      if (r.input) stdout.write(dim(`Previous prompt: ${r.input}\n`));
      await this.app.saveState();
      if (r.prompt) await this.turn(r.prompt);
      if (r.exit) return 'exit';
    } catch (e) {
      stdout.write(red(`✗ ${(e as Error).message}\n`));
    }
  }
}
