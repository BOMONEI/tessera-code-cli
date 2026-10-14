import { glob as fsGlob, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tool } from 'ai';
import { z } from 'zod';
import { type ToolContext, resolvePath, displayPath, truncate } from './context.js';

const IGNORED_DIR = /(^|\/)(node_modules|\.git|dist|\.next|build)(\/|$)/;
const MAX_RESULTS = 200;

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export function searchTools(ctx: ToolContext) {
  return {
    glob: tool({
      description:
        'Find files by glob pattern (e.g. "src/**/*.ts"). Returns paths sorted by modification time, newest first. ' +
        'node_modules, .git and build output are excluded.',
      inputSchema: z.object({
        pattern: z.string(),
        path: z.string().optional().describe('Directory to search in; defaults to the working directory'),
      }),
      execute: async ({ pattern, path }) => {
        const root = resolvePath(ctx, path ?? '.');
        const found: Array<{ p: string; m: number }> = [];
        for await (const entry of fsGlob(pattern, { cwd: root, exclude: (p: string) => IGNORED_DIR.test(p) })) {
          const abs = resolvePath({ ...ctx, cwd: root }, entry);
          try {
            const s = await stat(abs);
            if (s.isFile()) found.push({ p: abs, m: s.mtimeMs });
          } catch {
            // vanished between listing and stat
          }
          if (found.length >= 5000) break;
        }
        if (found.length === 0) return 'No files found';
        found.sort((a, b) => b.m - a.m);
        const shown = found.slice(0, MAX_RESULTS).map((f) => displayPath(ctx, f.p));
        return found.length > MAX_RESULTS ? `${shown.join('\n')}\n(${found.length - MAX_RESULTS} more results; narrow the pattern)` : shown.join('\n');
      },
    }),

    grep: tool({
      description:
        'Search file contents with a regular expression (ripgrep syntax). Returns matching lines as path:line:text. ' +
        'Use the glob filter (e.g. "*.ts") to narrow file types.',
      inputSchema: z.object({
        pattern: z.string(),
        path: z.string().optional(),
        glob: z.string().optional().describe('File glob filter, e.g. "*.tsx"'),
        ignore_case: z.boolean().optional(),
        files_only: z.boolean().optional().describe('Return only file paths that match'),
      }),
      execute: async ({ pattern, path, glob, ignore_case, files_only }) => {
        const args = ['--line-number', '--no-heading', '--color=never', '--max-columns=300', '--max-count=50'];
        if (ignore_case) args.push('-i');
        if (files_only) args.push('-l');
        if (glob) args.push('--glob', glob);
        args.push('--', pattern, resolvePath(ctx, path ?? '.'));
        let out: Awaited<ReturnType<typeof run>>;
        try {
          out = await run('rg', args, ctx.cwd);
        } catch {
          // ripgrep not installed: fall back to grep -rn
          const flags = [...(ignore_case ? ['-i'] : []), ...(files_only ? ['-l'] : []), ...(glob ? [`--include=${glob}`] : [])];
          out = await run('grep', ['-rnE', ...flags, '--exclude-dir=node_modules', '--exclude-dir=.git', '-e', pattern, resolvePath(ctx, path ?? '.')], ctx.cwd);
        }
        if (out.code === 1) return 'No matches found';
        if (out.code !== 0) throw new Error(out.stderr.trim() || `search failed with exit code ${out.code}`);
        const lines = out.stdout.trim().split('\n').map((l) => l.replace(ctx.cwd + '/', ''));
        const shown = lines.slice(0, MAX_RESULTS).join('\n');
        return truncate(lines.length > MAX_RESULTS ? `${shown}\n(${lines.length - MAX_RESULTS} more matches; narrow the search)` : shown);
      },
    }),
  };
}
