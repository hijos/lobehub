import type { WorkVersionListItem } from '@lobechat/types';

const PENDING_COST_REFRESH_WINDOW = 2 * 60 * 1000;
const PENDING_COST_REFRESH_INTERVAL = 2000;

export const formatWorkVersionCost = (cost?: number | null): string | null => {
  if (!cost || cost <= 0) return null;

  if (cost < 0.01) return `$${cost.toFixed(4)}`;

  return `$${cost.toFixed(2)}`;
};

export const getWorkVersionCostRefreshInterval = (
  versions?: Pick<WorkVersionListItem, 'createdAt' | 'cumulativeCost'>[] | null,
  now = Date.now(),
) => {
  const hasRecentPendingCost = versions?.some((version) => {
    if (version.cumulativeCost) return false;

    const createdAt = new Date(version.createdAt).getTime();
    if (!Number.isFinite(createdAt)) return false;

    return now - createdAt <= PENDING_COST_REFRESH_WINDOW;
  });

  return hasRecentPendingCost ? PENDING_COST_REFRESH_INTERVAL : 0;
};
