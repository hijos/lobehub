import type { Cost, Usage } from '@lobechat/agent-runtime';
import type { UpdateWorkVersionCumulativeUsageParams } from '@lobechat/types';

const finiteNumberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export const buildWorkVersionCumulativeUsage = ({
  cost,
  now = new Date(),
  usage,
}: {
  cost?: Cost | null;
  now?: Date;
  usage?: Usage | null;
}): Pick<UpdateWorkVersionCumulativeUsageParams, 'cumulativeCost' | 'cumulativeUsage'> => ({
  cumulativeCost: finiteNumberOrNull(cost?.total),
  cumulativeUsage:
    cost || usage
      ? {
          capturedAt: now.toISOString(),
          cost: cost ?? null,
          usage: usage ?? null,
        }
      : null,
});
