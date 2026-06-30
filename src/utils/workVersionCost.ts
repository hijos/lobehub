import type { TaskWorkSummaryItem, WorkVersionListItem } from '@lobechat/types';

const PENDING_COST_REFRESH_WINDOW = 2 * 60 * 1000;
const PENDING_COST_REFRESH_INTERVAL = 2000;

export const formatWorkVersionCost = (cost?: number | null): string | null => {
  if (!cost || cost <= 0) return null;

  if (cost < 0.01) return `$${cost.toFixed(4)}`;

  return `$${cost.toFixed(2)}`;
};

interface PendingCostItem {
  cost?: number | null;
  createdAt: Date | string;
}

type WorkSummaryCostRefreshItem = Pick<TaskWorkSummaryItem, 'totalCost'> & {
  context: Pick<TaskWorkSummaryItem['context'], 'createdAt'>;
};

const getPendingCostRefreshInterval = (items?: PendingCostItem[] | null, now = Date.now()) => {
  const hasRecentPendingCost = items?.some((item) => {
    if (item.cost !== null && item.cost !== undefined) return false;

    const createdAt = new Date(item.createdAt).getTime();
    if (!Number.isFinite(createdAt)) return false;

    return now - createdAt <= PENDING_COST_REFRESH_WINDOW;
  });

  return hasRecentPendingCost ? PENDING_COST_REFRESH_INTERVAL : 0;
};

export const getWorkSummaryCostRefreshInterval = (
  summaries?: WorkSummaryCostRefreshItem[] | Record<string, WorkSummaryCostRefreshItem[]> | null,
  now = Date.now(),
) => {
  const items = Array.isArray(summaries) ? summaries : Object.values(summaries ?? {}).flat();

  return getPendingCostRefreshInterval(
    items.map((item) => ({ cost: item.totalCost, createdAt: item.context.createdAt })),
    now,
  );
};

export const getWorkVersionCostRefreshInterval = (
  versions?: Pick<WorkVersionListItem, 'createdAt' | 'cumulativeCost'>[] | null,
  now = Date.now(),
) => {
  return getPendingCostRefreshInterval(
    versions?.map((version) => ({ cost: version.cumulativeCost, createdAt: version.createdAt })),
    now,
  );
};
