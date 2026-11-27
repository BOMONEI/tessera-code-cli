#!/usr/bin/env node
import { Command, Option } from 'commander';
import { spawn } from 'node:child_process';
import { stdout, stderr } from 'node:process';
import type { App } from './app.js';
import { VERSION } from './version.js';
import type { PromptFn } from './permissions.js';
import type { TuiBridge } from './ui/tui/App.js';
// Everything heavier (AI SDK, Ink/React, markdown) is imported where it is needed: `-v`, `sessions` and `-p`
// should not pay for the TUI, and the TUI modules load while the app is being set up.
import { dim, formatClock, formatTiming, formatTokens, formatUsage, red, toolLabel, yellow } from './ui/format.js';
import { createInterface } from 'node:readline/promises';

// The SDK prints provider compatibility warnings to stderr; they are noise for an interactive CLI.
(globalThis as { AI_SDK_LOG_WARNINGS?: false }).AI_SDK_LOG_WARNINGS = false;

/** Non-interactive mode: answer on stdout, activity on stderr. Permission prompts are denied. */
async function runPrint(app: App, input: string): Promise<void> {
  let prompt = input;
  if (input.startsWith('/')) {
    const { runCommand } = await import('./commands.js');
    const r = await runCommand(app, input);
    if (r.output) stdout.write(r.output + '\n');
    if (r.choose) {
      // A picker cannot be answered here: say so instead of silently doing nothing.
      stderr.write(red(`✗ "${r.choose.title}" needs a choice (${r.choose.options.map((o) => o.label).join(' / ')}): run it in the TUI, or give the choice in the command.\n`));
      process.exitCode = 1;
      return;
    }
    if (!r.prompt) return;
    prompt = r.prompt;
  }
  let failed = false;
  let midLine = false;
  // Subagents report on stderr like the main agent's tool calls, one line per step.
  app.onTaskProgress = (p) => {
    if (p.state === 'queued' || p.activity === 'starting') return;
    stderr.write(dim(`${midLine ? '\n' : ''}  ↳ ${p.type} · ${p.description} › ${p.activity}\n`));
    midLine = false;
  };
  for await (const ev of app.run(prompt)) {
    if (ev.type === 'text') {
      stdout.write(ev.text);
      midLine = !ev.text.endsWith('\n');
    } else if (ev.type === 'tool-call') {
      stderr.write(dim(`${midLine ? '\n' : ''}● ${toolLabel(ev.name, ev.input)}\n`));
      midLine = false;
    } else if (ev.type === 'info') {
      stderr.write(dim(`${ev.text}\n`));
    } else if (ev.type === 'fallback') {
      stderr.write(yellow(`${midLine ? '\n' : ''}↪ ${ev.from} ${ev.reason}; switched to ${ev.to}\n`));
      midLine = false;
    } else if (ev.type === 'turn-finish') {
      stderr.write(dim(`\n${formatTiming(ev)} · ${formatUsage(ev.usage)} · context ${formatTokens(app.agent.contextTokens)} · ${formatClock()}\n`));
    } else if (ev.type === 'error') {
      failed = true;
      stderr.write(red(`✗ ${ev.message}\n`));
    }
  }
  stdout.write('\n');
  process.exitCode = failed ? 1 : 0;
}

/** Asks whether to enable privileged project settings. Non-interactive runs never trust implicitly. */
async function confirmTrust(summary: string, interactive: boolean): Promise<boolean> {
  if (!interactive) return false;
  stderr.write(`\n${yellow('This project (.tessera/settings.json, project skills) wants to enable:')}\n${summary.replace(/^/gm, '  ')}\n`);
  stderr.write(dim('These run commands on your machine. Only trust projects you know.\n'));
  const rl = createInterface({ input: process.stdin, output: stderr });
  const answer = await rl.question('Trust this project? [y/N] ');
  rl.close();
  return answer.trim().toLowerCase() === 'y';
}

const program = new Command();

program
  .name('tessera-code')
  .description('Fast, precise coding agent powered by OpenCode Go')
  .version(VERSION, '-v, --version')
  .argument('[prompt...]', 'initial prompt')
  .option('-p, --print', 'run the prompt non-interactively, print the answer and exit')
  .option('-m, --model <id>', 'model id (see `tessera-code models`)')
  .option('-c, --continue', 'continue the most recent session in this directory')
  .option('-r, --resume [sessionId]', 'resume a session (pick from a list when no id is given)')
  .addOption(new Option('--permission-mode <mode>', 'tool permission mode (default: "permissionMode" in ~/.tessera-code/config.json)').choices(['default', 'acceptEdits', 'edit', 'plan', 'bypass', 'dangerous']))
  .option('--thinking', 'force reasoning on for this run')
  .option('--no-thinking', 'force reasoning off for this run (faster)')
  .option('--repl', 'use the plain readline interface instead of the TUI')
  .action(async (promptParts: string[], opts) => {
    const prompt = promptParts.join(' ').trim() || undefined;
    if (opts.print && !prompt) throw new Error('--print requires a prompt');
    // "-r" without an id opens the session picker once the UI is up.
    const pickSession = opts.resume === true;
    if (pickSession && opts.print) throw new Error('--print needs a session id: tessera-code -p -r <id> (see `tessera-code sessions`)');
    // The UI that answers permission prompts is created after the app, so route through a late-bound function.
    let ask: PromptFn = async () => 'deny';
    const bridge: TuiBridge = {};
    const interactive = !opts.print && !opts.repl && process.stdin.isTTY === true;
    const tui = interactive ? Promise.all([import('react'), import('ink'), import('./ui/tui/App.js')]) : undefined;
    const [{ createApp }, config] = await Promise.all([import('./app.js'), import('./config.js')]);
    for (const file of await config.ensureGlobalDefaults()) {
      stderr.write(dim(`Created ${file} (API key (/auth), model, thinking, permission mode). Edit it to change the defaults.\n`));
    }
    const app = await createApp({
      cwd: process.cwd(),
      model: opts.model,
      resume: opts.continue ? true : pickSession ? undefined : opts.resume,
      permissionMode: opts.permissionMode === undefined ? undefined : config.parsePermissionMode(opts.permissionMode, '--permission-mode'),
      thinking: opts.thinking,
      prompt: (req) => ask(req),
      onDiff: (p, d) => bridge.onDiff?.(p, d),
      confirmTrust: (summary) => confirmTrust(summary, !opts.print && process.stdin.isTTY === true),
    });
    if (opts.print || opts.repl) for (const w of app.warnings) stderr.write(yellow(`⚠ ${w}\n`)); // the TUI shows them in its banner
    if (!app.projectTrusted) stderr.write(yellow('⚠ Ignoring untrusted hooks/MCP servers/allow rules in .tessera/settings.json\n'));
    try {
      if (opts.print) {
        await runPrint(app, prompt!);
      } else if (opts.repl || !process.stdin.isTTY) {
        const { Repl } = await import('./ui/repl.js');
        const repl = new Repl(app);
        ask = (req) => Repl.ask(repl.readline, req);
        await repl.start(pickSession ? '/resume' : prompt);
      } else {
        ask = (req) => (bridge.ask ? bridge.ask(req) : Promise.resolve('deny'));
        const [react, { render }, { TuiRoot }] = await tui!;
        // React is CommonJS: a bundled dynamic import exposes it under `default`.
        const { createElement } = (react as unknown as { default?: typeof react }).default ?? react;
        // A resumed conversation is drawn immediately, so it needs the markdown renderer before the first frame.
        if (app.agent.messages.length) await (await import('./ui/lazy-markdown.js')).loadMarkdown();
        // First run after an update: the release notes since the version last seen (a few ms; no network).
        const { whatsNew, markChangelogSeen } = await import('./changelog.js');
        const news = await whatsNew(VERSION);
        // Ink asks the terminal about the kitty keyboard protocol right away, but turns on raw mode only when the
        // input mounts. An answer arriving in between (VS Code answers instantly) was echoed by the tty as
        // "^[[?0u" and pushed the startup card down a line. In raw mode nothing is echoed; Ink still reads it.
        process.stdin.setRawMode(true);
        // Full screen (default): the alternate screen with mouse reporting; the mouse sequences are taken out of the
        // input before Ink reads it. Mouse reporting is turned off however the process ends.
        const [{ mouseInput, MOUSE_ON, MOUSE_OFF }, { default: onExit }] = await Promise.all([import('./ui/tui/mouse.js'), import('signal-exit')]);
        const mouse = app.config.fullscreen ? mouseInput(process.stdin, stdout) : undefined;
        if (mouse) {
          stdout.write(MOUSE_ON);
          // Also on a kill (SIGTERM, SIGHUP), where 'exit' never fires: the shell must not be left reporting clicks.
          onExit(() => void stdout.write(MOUSE_OFF), { alwaysLast: true });
        }
        const ink = render(createElement(TuiRoot, { core: app, bridge, initialPrompt: prompt, initialCommand: pickSession ? '/resume' : undefined, whatsNew: news, mouse }), {
          exitOnCtrlC: false,
          // Lets terminals that support it report shift+enter (newline) distinctly from enter.
          kittyKeyboard: { mode: 'auto' },
          ...(mouse ? { stdin: mouse.stdin, alternateScreen: true } : {}),
        });
        if (news) void markChangelogSeen(news.version).catch(() => {}); // shown once; /changelog shows it again
        await ink.waitUntilExit();
        if (mouse) stdout.write(MOUSE_OFF);
        await app.store.sync(app.agent);
        await app.saveState();
        const restart = app.restart;
        if (app.agent.messages.length && !restart) stdout.write(dim(`Resume with: tessera-code -r ${app.agent.sessionId.slice(0, 8)}${app.title ? `  (${app.title})` : ''}\n`));
        await app.close();
        if (restart) {
          // /update installed a new version and the terminal is restored: hand the session to a fresh process.
          const argv = process.argv.slice(1);
          const args: string[] = [];
          for (let i = 0; i < argv.length; i++) {
            const a = argv[i]!;
            if (a === '-r' || a === '--resume') {
              if (i + 1 < argv.length && !argv[i + 1]!.startsWith('-')) i++; // the old session id goes too
              continue;
            }
            if (a === '-c' || a === '--continue' || a.startsWith('--resume=')) continue;
            args.push(a);
          }
          if (restart.sessionId) args.push('-r', restart.sessionId);
          try {
            spawn(process.execPath, args, { stdio: 'inherit' });
          } catch {
            stdout.write(dim('Updated — start tessera-code again to use the new version.\n'));
          }
        }
        process.exit(); // don't linger for background work (MCP servers still starting, connection pool)
      }
    } finally {
      await app.close();
    }
  });

program
  .command('models')
  .description('list usable models: OpenCode Go (ZDR) and connected providers (<provider>/<model>)')
  .option('--refresh', 'refetch the catalog from models.dev')
  .action(async (opts) => {
    const [{ loadCatalog, modelIsZdr, usableModels }, { loadConfig }, { setProviderSettings, unknownProviderWarnings }] = await Promise.all([
      import('./providers/catalog.js'),
      import('./config.js'),
      import('./providers/registry.js'),
    ]);
    const { providers } = await loadConfig(process.cwd(), { trusted: false });
    setProviderSettings(providers);
    for (const w of unknownProviderWarnings(providers)) stderr.write(yellow(`⚠ ${w}\n`));
    for (const m of usableModels(await loadCatalog({ refresh: opts.refresh }))) {
      stdout.write(`${m.id.padEnd(40)} ${(modelIsZdr(m) ? 'ZDR' : 'non-ZDR').padEnd(8)} ${m.format.padEnd(9)} ctx ${formatTokens(m.context).padEnd(7)} $${m.cost.input}/$${m.cost.output} per 1M\n`);
    }
  });

program
  .command('serve')
  .description('keep running in the background and let a paired browser drive sessions (remote control; 127.0.0.1 only)')
  .option('--port <port>', 'port to listen on (default: "remote.port" in config.json, else 8723)', (v) => Number(v))
  .option('--forget-devices', 'unpair every paired browser before starting')
  .action(async (opts: { port?: number; forgetDevices?: boolean }) => {
    if (opts.port !== undefined && !(Number.isInteger(opts.port) && opts.port >= 0 && opts.port <= 65535)) throw new Error('--port must be a port number');
    const { serve } = await import('./remote/daemon.js');
    await serve({ port: opts.port, forgetDevices: opts.forgetDevices, log: (line) => stderr.write(`${line}\n`) });
    process.exit(); // MCP servers and pooled connections of closed sessions must not keep the process alive
  });

program
  .command('relay')
  .description('run the remote-control relay on a server (forwards end-to-end encrypted traffic; token in TESSERA_RELAY_TOKEN)')
  .option('--port <port>', 'port to listen on', (v) => Number(v), 8080)
  .option('--host <host>', 'address to listen on (keep 127.0.0.1 behind a TLS proxy such as Caddy)', '127.0.0.1')
  .action(async (opts: { port: number; host: string }) => {
    if (!(Number.isInteger(opts.port) && opts.port >= 0 && opts.port <= 65535)) throw new Error('--port must be a port number');
    const token = process.env.TESSERA_RELAY_TOKEN ?? '';
    if (!token) throw new Error('Set TESSERA_RELAY_TOKEN (e.g. `openssl rand -base64 32`); the same value goes into "remote.relay.token" on your computer.');
    const { startRelay } = await import('./remote/relay.js');
    const log = (line: string) => stderr.write(`${new Date().toISOString()} ${line}\n`);
    const relay = await startRelay({ port: opts.port, host: opts.host, token, log });
    log(`tessera-code relay listening on ${opts.host}:${relay.port}`);
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    await relay.close();
  });

program
  .command('sessions')
  .description('list sessions for the current directory')
  .action(async () => {
    const { SessionStore } = await import('./session/store.js');
    for (const s of await SessionStore.list(process.cwd())) {
      stdout.write(`${s.id.slice(0, 8)}  ${dim(s.updatedAt.toISOString().slice(0, 16).replace('T', ' '))}  ${dim(`${String(s.messages).padStart(4)} msgs`)}  ${s.title}\n`);
    }
  });

program
  .command('auth')
  .description('register the OpenCode Go API key (same as /auth; stored in ~/.tessera-code/config.json)')
  .argument('<key>')
  .action(async (key: string) => {
    const { checkApiKey, maskKey, saveApiKey } = await import('./config.js');
    const { apiFetch } = await import('./providers/net.js');
    const check = await checkApiKey(key.trim(), apiFetch);
    if (check === 'rejected') throw new Error(`OpenCode Go rejected ${maskKey(key.trim())}; nothing was saved.`);
    await saveApiKey(key.trim());
    stdout.write(`${check === 'ok' ? 'Verified and saved' : 'Saved (could not verify it now)'}: ${maskKey(key.trim())} → ~/.tessera-code/config.json\n`);
  });

program
  .command('update')
  .description('update to the latest release (from GitHub Releases, checksum-verified)')
  .option('--check', 'only say whether an update is available')
  .action(async (opts: { check?: boolean }) => {
    const { runUpdate } = await import('./update.js');
    process.exitCode = await runUpdate(VERSION, { check: opts.check }, { write: (t) => stdout.write(t) });
  });

program.parseAsync().catch((e: Error) => {
  stderr.write(red(`✗ ${e.message}\n`));
  process.exit(1);
});
