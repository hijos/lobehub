'use client';

import type { WorkSummaryItem, WorkSummaryMap } from '@lobechat/types';
import { Flexbox } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import isEqual from 'fast-deep-equal';
import { memo } from 'react';

import WorkSummaryCard from '@/features/AgentTasks/features/WorkSummaryCard';
import { useClientDataSWR } from '@/libs/swr';
import { workKeys } from '@/libs/swr/keys';
import { workService } from '@/services/work';
import { getWorkSummaryCostRefreshInterval } from '@/utils/workVersionCost';

import { dataSelectors, useConversationStore } from '../../store';

const styles = createStaticStyles(({ css }) => ({
  container: css`
    width: 100%;
    margin-block-start: 8px;
  `,
}));

interface MessageWorksProps {
  rootOperationId?: string | null;
}

const MessageWorks = memo<MessageWorksProps>(({ rootOperationId }) => {
  // Memoized per displayMessages snapshot, so the conversation tree is walked
  // once regardless of how many messages mount a MessageWorks instance.
  const rootOperationIds = useConversationStore(dataSelectors.workRootOperationIds, isEqual);

  const { data: workSummaryMap = {} } = useClientDataSWR<WorkSummaryMap>(
    rootOperationId && rootOperationIds.length > 0
      ? workKeys.rootOperationSummaries(rootOperationIds)
      : null,
    () => workService.listSummariesByRootOperations({ rootOperationIds }),
    {
      fallbackData: {},
      refreshInterval: getWorkSummaryCostRefreshInterval,
      revalidateOnFocus: false,
    },
  );
  const data: WorkSummaryItem[] = rootOperationId ? (workSummaryMap[rootOperationId] ?? []) : [];

  if (data.length === 0) return null;

  return (
    <Flexbox className={styles.container} gap={8}>
      {data.map((item) => (
        <WorkSummaryCard item={item} key={item.id} />
      ))}
    </Flexbox>
  );
}, isEqual);

MessageWorks.displayName = 'MessageWorks';

export default MessageWorks;
