/**
 * bypass skips prompts except for destructive commands and protected paths; dangerous skips every prompt.
 * Plan mode still blocks in both.
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypass' | 'dangerous';
export type Decision = 'allow-once' | 'allow-session' | 'allow-always' | 'deny';

export interface PermissionRequest {
  /** Tool category: "edit" covers write/edit, "bash" covers shell. */
  tool: 'edit' | 'bash' | 'webfetch' | 'mcp';
  /** Rule that would grant this request, e.g. "bash(npm test)", "edit", "mcp(github)". */
  rule: string;
  /** Broader rule to remember on allow-session/allow-always, e.g. "bash(npm *)". Defaults to `rule`. */
  saveRule?: string;
  title: string;
  /** Optional preview (diff, full command) shown to the user. */
  detail?: string;
  /** Always ask, regardless of mode or rules (e.g. edits outside the project). Not rememberable. */
  sensitive?: boolean;
  /** The turn's abort signal: once fired, queued prompts are denied without being shown. */
  signal?: AbortSignal;
}

export type PromptFn = (req: PermissionRequest) => Promise<Decision>;

/** Shell syntax that chains, substitutes or redirects; such commands never match wildcard rules. */
const COMPOUND = /[;&|`<>\n\r]|\$\(|\$\{/;

// Redirects that only discard or merge output; they do not change what a command does.
const HARMLESS_REDIRECTS = /\s*(?:2>&1|[12&]?>\s*\/dev\/null)/g;

export function isCompound(command: string): boolean {
  return COMPOUND.test(command.replace(HARMLESS_REDIRECTS, ''));
}

/** Splits on shell separators into simple commands, each as a list of words (quotes stripped, best effort). */
function simpleCommands(command: string): string[][] {
  return command
    .split(/\|\||&&|[;|&\n]/)
    .map((part) =>
      (part.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
        .map((w) => w.replace(/^["']|["']$/g, ''))
        .filter((w, i, all) => !(/^\w+=/.test(w) && all.slice(0, i).every((p) => /^\w+=/.test(p)))), // leading FOO=1
    )
    .filter((words) => words.length > 0);
}

// Commands that run another command given as their arguments.
const WRAPPERS = new Set(['env', 'command', 'exec', 'nohup', 'xargs', 'time', 'timeout', 'nice', 'ionice', 'caffeinate', 'stdbuf', 'builtin']);
const SHELLS = /^(?:(?:ba|z|da|k|fi)?sh)$/;

function isDangerousSimple(words: string[]): boolean {
  let [cmd, ...args] = words.map((w) => w.replace(/^\\/, '')); // "\rm" bypasses aliases, not us
  while (cmd !== undefined && (WRAPPERS.has(cmd.split('/').pop()!) || /^\w+=/.test(cmd) || /^-/.test(cmd) || /^\d+[smhd]?$/.test(cmd))) {
    [cmd, ...args] = args; // skip wrapper, its flags, env assignments and durations (timeout 5)
  }
  if (!cmd) return false;
  const base = cmd.split('/').pop()!;
  // sh -c "..." / bash -c '...': inspect the inner script.
  if (SHELLS.test(base)) {
    const i = args.indexOf('-c');
    return i !== -1 && args[i + 1] !== undefined && isDangerous(args[i + 1]!);
  }
  const flags = args.filter((w) => /^-[a-zA-Z]+$/.test(w)).map((w) => w.slice(1)).join('');
  const has = (...names: string[]) => names.some((n) => args.includes(n));
  switch (base) {
    case 'sudo':
    case 'doas':
    case 'mkfs':
    case 'dd':
    case 'shred':
    case 'diskutil':
    case 'shutdown':
    case 'reboot':
      return true;
    case 'rm':
      return (/[rR]/.test(flags) || has('--recursive')) && (flags.includes('f') || has('--force'));
    case 'git': {
      // Skip global options, including those taking a value (git -C dir push -f).
      let k = 0;
      while (k < args.length && args[k]!.startsWith('-')) k += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(args[k]!) ? 2 : 1;
      const sub = args[k];
      if (sub === 'push') return flags.includes('f') || args.some((a) => a.startsWith('--force') || a === '--mirror' || a === '--delete' || /^[+:]/.test(a));
      if (sub === 'reset') return has('--hard');
      if (sub === 'clean') return flags.includes('f') || has('--force');
      if (sub === 'checkout' || sub === 'restore') return has('.', '--force');
      if (sub === 'branch') return flags.includes('D');
      return false;
    }
    case 'find': {
      if (has('-delete')) return true;
      // -exec runs its own command: "find . -exec cat {} +" only reads, "find . -exec rm -rf {} ;" does not.
      for (let i = 0; i < args.length; i++) {
        if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[i]!)) continue;
        const end = args.findIndex((w, j) => j > i && /^\\?[;+]?$/.test(w));
        const inner = args.slice(i + 1, end === -1 ? undefined : end);
        if (!inner.length || isDangerousSimple(inner)) return true;
      }
      return false;
    }
    case 'chmod':
    case 'chown':
      return flags.includes('R') || has('--recursive');
    default:
      return base.startsWith('mkfs.');
  }
}

/** Heuristic guard for destructive commands. Always prompts, even in bypass mode or under allow rules. */
export function isDangerous(command: string): boolean {
  if (/\|\s*(?:sudo\s+)?(?:\S*\/)?(?:(?:ba|z|da|k|fi)?sh|python\d*|perl|ruby|node|bun|deno|php)\b/.test(command)) return true; // pipe into an interpreter
  if (/>\s*\/dev\/(?:sd|disk|nvme)/.test(command) || /:\(\)\s*\{/.test(command)) return true; // raw disk write, fork bomb
  if (/(?:^|[\s;&|(])(?:eval|source)\s/.test(command)) return true;
  // Inspect the contents of $(...) and backticks as well as the top level.
  const nested = [...command.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? '');
  return [command, ...nested].some((c) => simpleCommands(c).some(isDangerousSimple));
}

const RULE = /^(\w+)(?:\(([\s\S]*)\))?$/;

/** Matches "edit", "bash", "bash(npm test)", "bash(npm run *)" style rules. */
export function ruleMatches(rule: string, requested: string): boolean {
  if (rule === requested) return true;
  const m = RULE.exec(rule);
  const r = RULE.exec(requested);
  if (!m || !r || m[1] !== r[1]) return false;
  if (m[2] === undefined) return true; // bare "bash" grants every bash(...)
  if (r[2] === undefined) return false;
  if (m[2].endsWith('*')) {
    // Wildcards never cover chained/redirected shell commands: "npm *" must not allow "npm test; rm -rf ~".
    if (m[1] === 'bash' && isCompound(r[2])) return false;
    return r[2].startsWith(m[2].slice(0, -1));
  }
  return false;
}

export class PermissionManager {
  private sessionRules: string[] = [];
  /** Serializes prompts: tool calls in one step run in parallel, but only one dialog can be shown. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private persistentRules: string[],
    private prompt: PromptFn,
    public mode: PermissionMode = 'default',
    private persist: (rule: string) => Promise<void> = async () => {},
  ) {}

  /** Rules granted with "allow for this session". */
  get sessionAllowed(): readonly string[] {
    return this.sessionRules;
  }

  /** Forgets a rule granted in this session or loaded from settings (the caller removes it from disk). */
  forget(rule: string): void {
    this.sessionRules = this.sessionRules.filter((r) => r !== rule);
    this.persistentRules = this.persistentRules.filter((r) => r !== rule);
  }

  private rememberable(req: PermissionRequest): boolean {
    return !req.sensitive && !(req.tool === 'bash' && isDangerous(req.title));
  }

  private autoAllowed(req: PermissionRequest): boolean {
    if (!this.rememberable(req)) return false;
    if (this.mode === 'bypass') return true;
    if (this.mode === 'acceptEdits' && req.tool === 'edit') return true;
    return [...this.persistentRules, ...this.sessionRules].some((r) => ruleMatches(r, req.rule));
  }

  /** Returns undefined when allowed, or a reason string when denied. */
  async check(req: PermissionRequest): Promise<string | undefined> {
    if (this.mode === 'plan') return 'Plan mode is active: no edits or commands may run. Describe the plan instead.';
    if (this.mode === 'dangerous') return undefined;
    if (this.autoAllowed(req)) return undefined;
    const run = this.queue.then(async (): Promise<Decision> => {
      if (req.signal?.aborted) return 'deny';
      if (this.mode === 'dangerous') return 'allow-once'; // switched while this prompt waited in the queue
      // A decision made for an earlier queued request (e.g. "allow for session") may now cover this one.
      if (this.autoAllowed(req)) return 'allow-once';
      return this.prompt(req);
    });
    this.queue = run.catch(() => {});
    const decision = await run;
    const saved = req.saveRule ?? req.rule;
    switch (decision) {
      case 'allow-once':
        return undefined;
      case 'allow-session':
        if (this.rememberable(req)) this.sessionRules.push(saved);
        return undefined;
      case 'allow-always':
        if (this.rememberable(req)) {
          this.persistentRules.push(saved);
          await this.persist(saved);
        }
        return undefined;
      case 'deny':
        return 'The user denied permission for this action. Ask how they would like to proceed.';
    }
  }
}

// Tools whose first word alone says little (npx runs anything); remember them with their subcommand.
const MULTI_COMMAND = new Set(['npx', 'npm', 'pnpm', 'yarn', 'bunx', 'bun', 'git', 'docker', 'kubectl', 'cargo', 'go', 'uv']);
const UNGENERALIZABLE = new Set(['node', 'python', 'python3', 'perl', 'ruby', 'deno', 'php', 'osascript', 'eval', 'source', 'sudo', 'doas', 'ssh', 'curl', 'wget']);

/**
 * Rule to remember for a bash command, e.g. "ls -la" -> "bash(ls *)", "npm run build" -> "bash(npm run *)".
 * Compound commands are remembered exactly, since a prefix would not describe what they do.
 */
export function bashRule(command: string): string {
  const trimmed = command.trim();
  const words = trimmed.split(/\s+/);
  const first = (words[0] ?? '').split('/').pop()!;
  // Interpreters and wrappers run arbitrary code from their arguments ("node -e ...", "env rm ..."), and
  // "npx -y pkg" names nothing: a wildcard there would grant everything, so remember the exact command.
  const generalizable =
    !isCompound(trimmed) &&
    !SHELLS.test(first) &&
    !WRAPPERS.has(first) &&
    !UNGENERALIZABLE.has(first) &&
    !(MULTI_COMMAND.has(first) && (!words[1] || words[1].startsWith('-')));
  if (!generalizable) return `bash(${trimmed})`;
  const prefix = MULTI_COMMAND.has(first) ? words.slice(0, 2) : words.slice(0, 1);
  return `bash(${prefix.join(' ')} *)`;
}
