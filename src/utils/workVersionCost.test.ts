import { describe, expect, it } from 'vitest';

import { formatWorkVersionCost, getWorkVersionCostRefreshInterval } from './workVersionCost';

describe('formatWorkVersionCost', () => {
  it('hides missing or zero cost', () => {
    expect(formatWorkVersionCost(null)).toBeNull();
    expect(formatWorkVersionCost(0)).toBeNull();
  });

  it('keeps small cumulative costs visible', () => {
    expect(formatWorkVersionCost(0.000_295)).toBe('$0.0003');
    expect(formatWorkVersionCost(0.03)).toBe('$0.03');
  });

  it('refreshes recently created versions while cumulative cost is pending', () => {
    const now = new Date('2026-06-30T09:40:00.000Z').getTime();

    expect(
      getWorkVersionCostRefreshInterval(
        [{ createdAt: new Date(now - 10_000), cumulativeCost: null }],
        now,
      ),
    ).toBe(2000);
    expect(
      getWorkVersionCostRefreshInterval(
        [{ createdAt: new Date(now - 10_000), cumulativeCost: 0.000_692 }],
        now,
      ),
    ).toBe(0);
    expect(
      getWorkVersionCostRefreshInterval(
        [{ createdAt: new Date(now - 5 * 60 * 1000), cumulativeCost: null }],
        now,
      ),
    ).toBe(0);
  });
});
