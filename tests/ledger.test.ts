import { describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const { recordSpend, spendWindows } = await import('../src/cost/ledger.js');
const { HOME_DIR } = await import('../src/config.js');

describe('spend ledger', () => {
  it('reads appended lines incrementally, skips corrupt lines and waits for a partial line to complete', async () => {
    const ledger = join(HOME_DIR, 'usage.jsonl');
    await recordSpend('m', 1);
    expect((await spendWindows()).fiveHour).toBe(1);

    const sixHoursAgo = Date.now() - 6 * 3_600_000;
    appendFileSync(ledger, JSON.stringify({ t: sixHoursAgo, model: 'm', cost: 2 }) + '\nnot json\n{"t":');
    expect(await spendWindows()).toMatchObject({ fiveHour: 1, week: 3 }); // old entry counts for the week only

    appendFileSync(ledger, `${Date.now()},"model":"m","cost":4}\n`); // another process finishes the partial line
    expect((await spendWindows()).fiveHour).toBe(5);

    await recordSpend('m', 0.5);
    expect((await spendWindows()).fiveHour).toBe(5.5);
  });

  it('concurrent reads do not count new lines twice', async () => {
    const before = (await spendWindows()).fiveHour;
    await recordSpend('m', 2);
    const [a, b] = await Promise.all([spendWindows(), spendWindows()]);
    expect(a.fiveHour).toBe(before + 2);
    expect(b.fiveHour).toBe(before + 2);
  });
});
