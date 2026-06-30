'use client';

import type {
  AssistantContentBlock,
  TaskWorkContextVersionItem,
  TaskWorkContextVersionMap,
  UIChatMessage,
} from '@lobechat/types';
import { Flexbox, Text } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import isEqual from 'fast-deep-equal';
import { ClipboardListIcon } from 'lucide-react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useNavigateToTaskDetail } from '@/features/AgentTasks/shared/taskDetailPath';
import { useClientDataSWR } from '@/libs/swr';
import { workKeys } from '@/libs/swr/keys';
import { workService } from '@/services/work';
import { formatWorkVersionCost } from '@/utils/workVersionCost';

import { dataSelectors, useConversationStore } from '../../store';

const styles = createStaticStyles(({ css, cssVar }) => ({
  container: css`
    overflow: hidden;

    width: min(560px, 100%);
    margin-block-start: 8px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;

    background: ${cssVar.colorFillQuaternary};
  `,
  header: css`
    padding-block: 8px;
    padding-inline: 10px;

    font-size: 12px;
    font-weight: 500;
    color: ${cssVar.colorTextSecondary};
  `,
  row: css`
    cursor: pointer;
    padding-block: 8px;
    padding-inline: 10px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  title: css`
    min-width: 0;
    font-size: 13px;
    font-weight: 500;
  `,
  versionCost: css`
    flex-shrink: 0;
    color: ${cssVar.colorTextTertiary};
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
  const { t } = useTranslation('chat');
  const navigateToTask = useNavigateToTaskDetail();
  const displayMessages = useConversationStore(dataSelectors.displayMessages, isEqual);
  const rootOperationIds = useMemo(
    () => collectWorkRootOperationIds(displayMessages),
    [displayMessages],
  );

  const { data: workVersionMap = {} } = useClientDataSWR<TaskWorkContextVersionMap>(
    rootOperationId && rootOperationIds.length > 0
      ? workKeys.rootOperations(rootOperationIds)
      : null,
    () => workService.listByRootOperations({ rootOperationIds }),
    {
      fallbackData: {},
      revalidateOnFocus: false,
    },
  );
  const data: TaskWorkContextVersionItem[] = rootOperationId
    ? (workVersionMap[rootOperationId] ?? [])
    : [];

  if (data.length === 0) return null;

  return (
    <Flexbox className={styles.container}>
      <Flexbox horizontal align={'center'} className={styles.header} gap={8}>
        <ClipboardListIcon size={14} />
        <Text type={'secondary'}>{t('workingPanel.works.title')}</Text>
      </Flexbox>
      {data.map((item) => {
        const cost = formatWorkVersionCost(item.version.cumulativeCost);
        const taskIdentifier = item.resourceIdentifier ?? item.resourceId;

        return (
          <Flexbox
            horizontal
            align={'center'}
            className={styles.row}
            gap={8}
            key={item.context.id}
            onClick={() => navigateToTask(taskIdentifier)}
          >
            <Text code fontSize={12} style={{ flexShrink: 0 }}>
              v{item.version.version}
            </Text>
            <Text style={{ flexShrink: 0 }} type={'secondary'}>
              {t(`workingPanel.works.role.${item.context.role}` as never)}
            </Text>
            <Text code fontSize={12} style={{ flexShrink: 0 }}>
              {taskIdentifier}
            </Text>
            <Text ellipsis className={styles.title} style={{ flex: 1 }}>
              {item.version.title || item.title}
            </Text>
            {cost && (
              <Text
                code
                className={styles.versionCost}
                fontSize={12}
                title={t('workingPanel.works.cumulativeCost', { cost })}
              >
                {cost}
              </Text>
            )}
          </Flexbox>
        );
      })}
    </Flexbox>
  );
}, isEqual);

MessageWorks.displayName = 'MessageWorks';

export default MessageWorks;
