'use client';

import type {
  AssistantContentBlock,
  TaskWorkSummaryItem,
  TaskWorkSummaryMap,
  UIChatMessage,
} from '@lobechat/types';
import { Flexbox } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import isEqual from 'fast-deep-equal';
import { memo, useMemo } from 'react';

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

const getOperationFinalRootId = (metadata?: { work?: { rootOperationId?: unknown } } | null) =>
  typeof metadata?.work?.rootOperationId === 'string' ? metadata.work.rootOperationId : undefined;

const addRootId = (rootOperationIds: Set<string>, rootOperationId?: string) => {
  if (rootOperationId) rootOperationIds.add(rootOperationId);
};

const collectBlockWorkRootIds = (block: AssistantContentBlock, rootOperationIds: Set<string>) => {
  addRootId(rootOperationIds, getOperationFinalRootId(block.metadata));

  for (const message of block.council ?? []) {
    collectMessageWorkRootIds(message, rootOperationIds);
  }
};

const collectMessageWorkRootIds = (message: UIChatMessage, rootOperationIds: Set<string>) => {
  addRootId(rootOperationIds, getOperationFinalRootId(message.metadata));

  for (const block of message.children ?? []) {
    collectBlockWorkRootIds(block, rootOperationIds);
  }

  for (const block of message.taskCompletions ?? []) {
    collectBlockWorkRootIds(block, rootOperationIds);
  }

  for (const child of message.compressedMessages ?? []) {
    collectMessageWorkRootIds(child, rootOperationIds);
  }

  for (const member of message.members ?? []) {
    collectMessageWorkRootIds(member, rootOperationIds);
  }

  for (const task of message.tasks ?? []) {
    collectMessageWorkRootIds(task, rootOperationIds);
  }
};

const collectWorkRootOperationIds = (messages: UIChatMessage[]) => {
  const rootOperationIds = new Set<string>();
  for (const message of messages) {
    collectMessageWorkRootIds(message, rootOperationIds);
  }
  return Array.from(rootOperationIds).sort();
};

interface MessageWorksProps {
  rootOperationId?: string | null;
}

const MessageWorks = memo<MessageWorksProps>(({ rootOperationId }) => {
  const displayMessages = useConversationStore(dataSelectors.displayMessages, isEqual);
  const rootOperationIds = useMemo(
    () => collectWorkRootOperationIds(displayMessages),
    [displayMessages],
  );

  const { data: workSummaryMap = {} } = useClientDataSWR<TaskWorkSummaryMap>(
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
  const data: TaskWorkSummaryItem[] = rootOperationId
    ? (workSummaryMap[rootOperationId] ?? [])
    : [];

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
