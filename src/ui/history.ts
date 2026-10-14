import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HOME_DIR } from '../config.js';

const FILE = join(HOME_DIR, 'history.jsonl');
const MAX = 1000;

/** Prompts typed in `cwd`, newest first (for ↑ and ctrl+r). */
export async function loadInputHistory(cwd: string): Promise<string[]> {
  if (!existsSync(FILE)) return [];
  const out: string[] = [];
  const lines = (await readFile(FILE, 'utf8')).split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < MAX; i--) {
    try {
      const rec = JSON.parse(lines[i]!) as { cwd: string; text: string };
      if (rec.cwd === cwd && !out.includes(rec.text)) out.push(rec.text);
    } catch {
      // blank or truncated line
    }
  }
  return out;
}

export async function appendInputHistory(cwd: string, text: string): Promise<void> {
  try {
    await mkdir(HOME_DIR, { recursive: true });
    await appendFile(FILE, JSON.stringify({ cwd, text, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  } catch {
    // history is a convenience
  }
}

/** Newest entry at or after `from` containing `query` (case-insensitive). */
export function searchHistory(history: string[], query: string, from = 0): number {
  const q = query.toLowerCase();
  for (let i = from; i < history.length; i++) if (history[i]!.toLowerCase().includes(q)) return i;
  return -1;
}
