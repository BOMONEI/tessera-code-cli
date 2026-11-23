import { describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const { recordSpend, spendWindows } = await import('../src/cost/ledger.js');
const { fetchGoUsage } = await import('../src/cost/go.js');
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
    // Reset estimates: the 5h window 5 hours after its earliest spend, the week at the next Monday 00:00 UTC.
    const w = await spendWindows();
    expect(w.fiveHourReset).toBeGreaterThan(Date.now());
    expect(w.weekReset).toBeGreaterThan(Date.now());
  });

  it('concurrent reads do not count new lines twice', async () => {
    const before = (await spendWindows()).fiveHour;
    await recordSpend('m', 2);
    const [a, b] = await Promise.all([spendWindows(), spendWindows()]);
    expect(a.fiveHour).toBe(before + 2);
    expect(b.fiveHour).toBe(before + 2);
  });
});

describe("go usage (the server's own numbers)", () => {
  const reply = () =>
    new Response(JSON.stringify({ usage: { rolling: { status: 'ok', percent: 4 }, weekly: { percent: 22.5 }, monthly: { percent: 16 } } }), { status: 200 });

  it('reads the windows once per key within the cache TTL', async () => {
    let calls = 0;
    const fetchFn = (async () => (calls++, reply())) as typeof fetch;
    expect(await fetchGoUsage('k1', fetchFn)).toEqual({ fiveHour: 4, week: 22.5, month: 16 });
    expect(await fetchGoUsage('k1', fetchFn)).toEqual({ fiveHour: 4, week: 22.5, month: 16 });
    expect(calls).toBe(1);
    expect(await fetchGoUsage('k2', fetchFn)).toEqual({ fiveHour: 4, week: 22.5, month: 16 });
    expect(calls).toBe(2); // a different key fetches again
  });

  it('says nothing when the endpoint fails or the reply has no usable windows', async () => {
    expect(await fetchGoUsage('k3', (async () => new Response('no', { status: 500 })) as typeof fetch)).toBeUndefined();
    expect(await fetchGoUsage('k4', (async () => { throw new Error('offline'); }) as typeof fetch)).toBeUndefined();
    expect(await fetchGoUsage('k5', (async () => new Response('{}', { status: 200 })) as typeof fetch)).toBeUndefined();
  });
});
