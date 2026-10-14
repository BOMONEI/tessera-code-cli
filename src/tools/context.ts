import { isAbsolute, relative, resolve } from 'node:path';
import type { PermissionManager } from '../permissions.js';

export interface ToolContext {
  cwd: string;
  permissions: PermissionManager;
  /** Absolute path -> mtime at last read; edits require a prior read of the current version. */
  readFiles: Map<string, number>;
  /** Called after a file change is applied, for UI display only (not sent to the model). */
  onDiff?: (path: string, diff: string) => void;
  /** Called right before a file tool modifies `abs` (undo snapshots). */
  beforeWrite?: (abs: string) => Promise<void>;
}

export function resolvePath(ctx: ToolContext, p: string): string {
  return isAbsolute(p) ? p : resolve(ctx.cwd, p);
}

export function displayPath(ctx: ToolContext, abs: string): string {
  const rel = relative(ctx.cwd, abs);
  return rel.startsWith('..') ? abs : rel || '.';
}

export function truncate(text: string, max = 30_000): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max / 2);
  const tail = text.slice(-max / 2);
  return `${head}\n\n... [${text.length - max} characters truncated] ...\n\n${tail}`;
}
