import { appendFile, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { HOME_DIR } from '../config.js';

/**
 * Local spend ledger. OpenCode Go enforces dollar caps per rolling 5 hours / week / month but exposes no
 * API for remaining quota, so we estimate from our own usage records (other clients' usage is not seen).
 */
const LEDGER = join(HOME_DIR, 'usage.jsonl');

export const GO_LIMITS = { fiveHour: 12, week: 30, month: 60 };

interface Entry {
  t: number;
  model: string;
  cost: number;
}

export async function recordSpend(model: string, cost: number): Promise<void> {
  if (cost <= 0) return;
  await mkdir(HOME_DIR, { recursive: true });
  await appendFile(LEDGER, JSON.stringify({ t: Date.now(), model, cost } satisfies Entry) + '\n');
}

export interface SpendWindows {
  fiveHour: number;
  week: number;
  month: number;
}

const HOUR = 3_600_000;
const MONTH = 30 * 24 * HOUR;

// Entries of the last 30 days and how far the file has been read: each call reads only what was appended since
// (other tessera-code processes append too), instead of re-parsing the whole, ever-growing ledger.
let cache: { entries: Entry[]; offset: number } = { entries: [], offset: 0 };

let inflight: Promise<Entry[]> | undefined;

/** Concurrent callers share one read: two reads from the same offset would count the new lines twice. */
function readNew(now: number): Promise<Entry[]> {
  inflight ??= readAppended(now).finally(() => (inflight = undefined));
  return inflight;
}

async function readAppended(now: number): Promise<Entry[]> {
  let fh;
  try {
    fh = await open(LEDGER, 'r');
  } catch {
    return cache.entries; // no ledger yet
  }
  try {
    const { size } = await fh.stat();
    if (size < cache.offset) cache = { entries: [], offset: 0 }; // replaced or truncated: start over
    if (size > cache.offset) {
      const buf = Buffer.alloc(size - cache.offset);
      await fh.read(buf, 0, buf.length, cache.offset);
      const text = buf.toString('utf8');
      const complete = text.lastIndexOf('\n') + 1; // a line still being written is read next time
      for (const line of text.slice(0, complete).split('\n')) {
        if (!line) continue;
        try {
          cache.entries.push(JSON.parse(line) as Entry);
        } catch {
          // a corrupt line costs nothing but its own amount
        }
      }
      cache.offset += Buffer.byteLength(text.slice(0, complete));
    }
  } finally {
    await fh.close();
  }
  const cutoff = now - MONTH;
  if (cache.entries.length && cache.entries[0]!.t < cutoff) cache.entries = cache.entries.filter((e) => e.t >= cutoff);
  return cache.entries;
}

export async function spendWindows(now = Date.now()): Promise<SpendWindows> {
  const w: SpendWindows = { fiveHour: 0, week: 0, month: 0 };
  for (const e of await readNew(now)) {
    const age = now - e.t;
    if (age < 5 * HOUR) w.fiveHour += e.cost;
    if (age < 7 * 24 * HOUR) w.week += e.cost;
    if (age < MONTH) w.month += e.cost;
  }
  return w;
}
