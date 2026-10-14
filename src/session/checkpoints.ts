import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import type { ModelMessage } from 'ai';
import { unifiedDiff } from '../tools/files.js';
import { historyAnchor, type Checkpoint, type SessionStore } from './store.js';

export type RewindMode = 'both' | 'conversation' | 'code';

export interface RewindResult {
  /** Files restored (relative paths); deleted ones are marked. */
  files: string[];
  /** Conversation restored to before the turn (false when it was compacted or cleared since). */
  conversation: boolean;
  /** The files' previous state was saved as a new checkpoint (/undo restores it). */
  redo?: boolean;
}

/**
 * Undo points per user turn. Before a turn's first change to a file (write/edit tools), the file's previous
 * content is saved, so turns can be undone. Changes made through bash are not tracked.
 */
export class Checkpoints {
  list: Checkpoint[] = [];
  private current?: Checkpoint;
  private pending: Promise<unknown>[] = [];

  constructor(
    private store: () => SessionStore,
    private cwd: string,
  ) {}

  reset(list: Checkpoint[]): void {
    this.list = list;
    this.current = undefined;
  }

  begin(prompt: string, history: ModelMessage[]): void {
    const turn = (this.list.at(-1)?.turn ?? 0) + 1;
    this.current = { turn, index: history.length, anchor: historyAnchor(history), prompt, at: new Date().toISOString(), files: [] };
  }

  /** Called by file tools right before they modify `abs`. */
  async beforeWrite(abs: string): Promise<void> {
    const cp = this.current;
    if (!cp || cp.files.some((f) => f.path === abs)) return;
    const entry: { path: string; blob?: string } = { path: abs };
    cp.files.push(entry); // claim synchronously: parallel edits of one file snapshot once
    const job = existsSync(abs) ? readFile(abs).then((buf) => this.store().saveBlob(buf)).then((b) => void (entry.blob = b)) : Promise.resolve();
    this.pending.push(job.catch(() => {}));
    try {
      await job;
    } catch (e) {
      // Without a snapshot the entry would read as "did not exist" and a rewind would delete the file.
      cp.files.splice(cp.files.indexOf(entry), 1);
      throw new Error(`Could not save an undo snapshot of ${relative(this.cwd, abs)}: ${(e as Error).message}`);
    }
  }

  async end(): Promise<void> {
    const cp = this.current;
    this.current = undefined;
    if (!cp) return;
    await Promise.allSettled(this.pending.splice(0));
    this.list.push(cp);
    await this.store().addCheckpoint(cp);
  }

  /**
   * Restores the state before `cp`'s turn. Files touched by that turn or any later one go back to their content
   * before their first change at or after `cp`; the conversation is cut back to before the turn's prompt.
   */
  /** Whether the conversation can still be rewound to before `cp` (not compacted or cleared since). */
  reachable(cp: Checkpoint, history: ModelMessage[]): boolean {
    return cp.index <= history.length && historyAnchor(history.slice(0, cp.index)) === cp.anchor;
  }

  async rewind(cp: Checkpoint, mode: RewindMode, history: ModelMessage[]): Promise<RewindResult & { messages?: ModelMessage[] }> {
    const later = this.list.filter((c) => c.turn >= cp.turn);
    const result: RewindResult & { messages?: ModelMessage[] } = { files: [], conversation: false };
    let safety: Checkpoint | undefined;
    if (mode !== 'conversation') {
      const original = new Map<string, string | undefined>();
      for (const c of later) for (const f of c.files) if (!original.has(f.path)) original.set(f.path, f.blob);
      // Save the current state first, so the rewind itself can be undone (manual edits are not lost).
      safety = { turn: 0, index: history.length, anchor: historyAnchor(history), prompt: `(files before rewinding to "${cp.prompt.replace(/\s+/g, ' ').slice(0, 40)}")`, at: new Date().toISOString(), files: [] };
      for (const path of original.keys()) {
        safety.files.push(existsSync(path) ? { path, blob: await this.store().saveBlob(await readFile(path)) } : { path });
      }
      for (const [path, blob] of original) {
        const rel = relative(this.cwd, path) || path;
        if (blob === undefined) {
          await rm(path, { force: true });
          result.files.push(`${rel} (deleted)`);
        } else {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, await this.store().readBlob(blob));
          result.files.push(rel);
        }
      }
    }
    if (mode !== 'code' && this.reachable(cp, history)) {
      result.messages = history.slice(0, cp.index);
      result.conversation = true;
    }
    // Code and conversation undone: those turns are gone. Conversation only: keep their checkpoints, since the
    // files still carry their changes (they stay rewindable as files-only points).
    if (mode === 'both' && result.conversation) {
      this.list = this.list.filter((c) => c.turn < cp.turn);
      await this.store().markRewind(cp.turn);
    }
    if (safety?.files.length) {
      safety.turn = (this.list.at(-1)?.turn ?? 0) + 1;
      if (result.messages) {
        safety.index = result.messages.length;
        safety.anchor = historyAnchor(result.messages);
      }
      this.list.push(safety);
      await this.store().addCheckpoint(safety);
      result.redo = true;
    }
    return result;
  }

  /** Unified diff of every file changed in this session, against its content before the first change. */
  async diff(): Promise<string> {
    const original = new Map<string, string | undefined>();
    for (const c of this.list) for (const f of c.files) if (!original.has(f.path)) original.set(f.path, f.blob);
    const parts: string[] = [];
    for (const [path, blob] of original) {
      const rel = relative(this.cwd, path) || path;
      const before = blob === undefined ? '' : (await this.store().readBlob(blob)).toString('utf8');
      const after = existsSync(path) ? await readFile(path, 'utf8') : '';
      if (before === after) continue;
      parts.push(`${rel}${blob === undefined ? ' (new)' : !existsSync(path) ? ' (deleted)' : ''}\n${unifiedDiff(rel, before, after)}`);
    }
    return parts.join('\n\n');
  }
}
