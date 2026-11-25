import { describe, expect, it } from 'vitest';
import { formatUsage } from '../src/ui/format.js';

describe('formatUsage', () => {
  it('shows the cache share of the input, so a cold turn is visible', () => {
    const s = formatUsage({ inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 7_500, cost: 0.01 });
    expect(s).toContain('7.5k cached · 75%');
    const cold = formatUsage({ inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 0, cost: 0.01 });
    expect(cold).toContain('cached · 0%');
    const none = formatUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0 });
    expect(none).not.toContain('cached ·');
  });
});
