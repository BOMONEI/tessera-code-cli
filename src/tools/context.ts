import { isAbsolute, relative, resolve } from 'node:path';
import type { PermissionManager } from '../permissions.js';
import type { ImageInput } from '../agent/agent.js';
import type { Skill } from '../skills.js';

export interface ToolContext {
  cwd: string;
  permissions: PermissionManager;
  /** Absolute path -> mtime at last read; edits require a prior read of the current version. */
  readFiles: Map<string, number>;
  /** Called after a file change is applied, for UI display only (not sent to the model). */
  onDiff?: (path: string, diff: string) => void;
  /** Called right before a file tool modifies `abs` (undo snapshots). */
  beforeWrite?: (abs: string) => Promise<void>;
  /** Shows images to the model with its next request (read of an image or a rendered document). */
  showImages?: (label: string, images: ImageInput[]) => void;
  /** Whether the current model can see images at all. */
  canSeeImages?: () => boolean;
  /** Skills usable in this session (global, Claude's, and the project's own when it is trusted). */
  skills?: () => Promise<Skill[]>;
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
