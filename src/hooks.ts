import { spawn } from 'node:child_process';

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop';

export interface HookConfig {
  /** Regex matched against the tool name (PreToolUse/PostToolUse only). Omit to match every tool. */
  matcher?: string;
  command: string;
  timeout_ms?: number;
}

export type HooksConfig = Partial<Record<HookEvent, HookConfig[]>>;

export interface HookOutcome {
  /** Set when a hook exits with code 2: the action is blocked and this reason is shown to the model. */
  blocked?: string;
  /** stdout of successful hooks; for UserPromptSubmit it is added to the prompt as context. */
  context?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

function runHook(hook: HookConfig, payload: unknown, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-c', hook.command], { cwd, env: { ...process.env, TESSERA_PROJECT_DIR: cwd }, detached: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL'); // whole process group, so grandchildren holding stdout die too
      } catch {
        child.kill('SIGKILL');
      }
    }, hook.timeout_ms ?? DEFAULT_TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {}); // hook may exit without reading stdin
    child.stdin.end(JSON.stringify(payload));
  });
}

/**
 * Hook protocol (shell commands, JSON payload on stdin):
 * exit 0 -> continue (stdout becomes context), exit 2 -> block (stderr is the reason), other -> ignored.
 */
export class HookRunner {
  private compiled: Partial<Record<HookEvent, Array<HookConfig & { re?: RegExp }>>> = {};
  /** Config problems (e.g. invalid matcher regex); those hooks are skipped. */
  readonly warnings: string[] = [];

  constructor(
    config: HooksConfig,
    private cwd: string,
    public sessionId: string,
  ) {
    for (const [event, hooks] of Object.entries(config) as Array<[HookEvent, HookConfig[] | undefined]>) {
      this.compiled[event] = [];
      for (const h of hooks ?? []) {
        if (!h.matcher) {
          this.compiled[event]!.push(h);
          continue;
        }
        try {
          this.compiled[event]!.push({ ...h, re: new RegExp(`^(?:${h.matcher})$`) });
        } catch (e) {
          this.warnings.push(`Skipping ${event} hook with invalid matcher "${h.matcher}": ${(e as Error).message}`);
        }
      }
    }
  }

  get configured(): boolean {
    return Object.values(this.compiled).some((list) => list?.length);
  }

  async run(event: HookEvent, data: { tool?: string; [k: string]: unknown }): Promise<HookOutcome> {
    const hooks = (this.compiled[event] ?? []).filter((h) => !h.re || !data.tool || h.re.test(data.tool));
    const context: string[] = [];
    for (const hook of hooks) {
      const r = await runHook(hook, { event, session_id: this.sessionId, cwd: this.cwd, ...data }, this.cwd);
      if (r.code === 2) return { blocked: r.stderr.trim() || `Blocked by ${event} hook: ${hook.command}` };
      if (r.code === 0 && r.stdout.trim()) context.push(r.stdout.trim());
    }
    return { context: context.join('\n') || undefined };
  }
}
