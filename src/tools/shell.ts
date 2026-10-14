import { spawn } from 'node:child_process';
import { tool } from 'ai';
import { z } from 'zod';
import { bashRule } from '../permissions.js';
import { type ToolContext, truncate } from './context.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_BUFFER = 2_000_000;

export function runShell(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-c', command], { cwd, env: { ...process.env, TESSERA_CODE: '1' }, detached: true });
    let output = '';
    let timedOut = false;
    const kill = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL'); // kill the whole process group
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    if (signal?.aborted) kill();
    else signal?.addEventListener('abort', kill, { once: true });
    // Keep memory bounded for chatty commands; the head and tail are what truncate() shows anyway.
    const append = (d: Buffer) => {
      output += d;
      if (output.length > MAX_BUFFER) output = output.slice(0, MAX_BUFFER / 2) + '\n…\n' + output.slice(-MAX_BUFFER / 2);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      resolve({ code, output, timedOut });
    });
  });
}

export function shellTools(ctx: ToolContext) {
  return {
    bash: tool({
      description:
        'Run a shell command with bash in the working directory and return combined stdout/stderr. ' +
        'Use for builds, tests, git and other CLI tools. Do not use it to read, search or edit files (use the dedicated tools). ' +
        'Commands are non-interactive; avoid commands that wait for input.',
      inputSchema: z.object({
        command: z.string(),
        description: z.string().optional().describe('Short description of what the command does'),
        timeout_ms: z.number().int().max(MAX_TIMEOUT_MS).optional(),
      }),
      execute: async ({ command, description, timeout_ms }, { abortSignal }) => {
        const denied = await ctx.permissions.check({
          tool: 'bash',
          rule: `bash(${command.trim()})`,
          saveRule: bashRule(command),
          title: command,
          detail: description,
          signal: abortSignal,
        });
        if (denied) return denied;
        const { code, output, timedOut } = await runShell(command, ctx.cwd, timeout_ms ?? DEFAULT_TIMEOUT_MS, abortSignal);
        const body = truncate(output.trim()) || '(no output)';
        if (timedOut) return `${body}\n\n[command timed out after ${timeout_ms ?? DEFAULT_TIMEOUT_MS}ms]`;
        return code === 0 ? body : `${body}\n\n[exit code ${code}]`;
      },
    }),

  };
}
