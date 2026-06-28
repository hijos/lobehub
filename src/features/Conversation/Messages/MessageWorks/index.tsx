'use client';

import type { TaskWorkContextVersionItem } from '@lobechat/types';
import { Flexbox, Text } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import isEqual from 'fast-deep-equal';
import { ClipboardListIcon } from 'lucide-react';
import { memo, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useNavigateToTaskDetail } from '@/features/AgentTasks/shared/taskDetailPath';
import { useClientDataSWR } from '@/libs/swr';
import { workKeys } from '@/libs/swr/keys';
import { workService } from '@/services/work';
import { useChatStore } from '@/store/chat';
import type { Operation } from '@/store/chat/slices/operation/types';
import { AI_RUNTIME_OPERATION_TYPES } from '@/store/chat/slices/operation/types';

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
}));

interface OperationState {
  operations: Record<string, Operation>;
  operationsByMessage: Record<string, string[]>;
}

const findRootRuntimeOperationId = (
  operationId: string | undefined,
  operations: Record<string, Operation>,
): string | undefined => {
  let current = operationId ? operations[operationId] : undefined;
  const visited = new Set<string>();

  while (current && !visited.has(current.id)) {
    if (AI_RUNTIME_OPERATION_TYPES.includes(current.type)) return current.id;

    visited.add(current.id);
    current = current.parentOperationId ? operations[current.parentOperationId] : undefined;
  }

  return undefined;
};

const isTerminal = (operation?: Operation) =>
  operation?.status === 'cancelled' ||
  operation?.status === 'completed' ||
  operation?.status === 'failed';

interface MessageWorksProps {
  displayAnchorAssistantMessageIds?: string[];
  messageId: string;
}

const MessageWorks = memo<MessageWorksProps>(({ displayAnchorAssistantMessageIds, messageId }) => {
  const { t } = useTranslation('chat');
  const navigateToTask = useNavigateToTaskDetail();
  const refreshedTerminalOperationRef = useRef<string | undefined>(undefined);
  const operationState = useChatStore(
    (s) => ({
      operations: s.operations,
      operationsByMessage: s.operationsByMessage,
    }),
    isEqual,
  );

  const resolvedDisplayAnchorAssistantMessageIds = useMemo(
    () =>
      Array.from(
        new Set(
          displayAnchorAssistantMessageIds?.length ? displayAnchorAssistantMessageIds : [messageId],
        ),
      ),
    [displayAnchorAssistantMessageIds, messageId],
  );

  const rootOperationId = useMemo(() => {
    const operationIds = resolvedDisplayAnchorAssistantMessageIds.flatMap(
      (id) => operationState.operationsByMessage[id] ?? [],
    );

    for (let index = operationIds.length - 1; index >= 0; index -= 1) {
      const rootId = findRootRuntimeOperationId(operationIds[index], operationState.operations);
      if (rootId) return rootId;
    }

    return undefined;
  }, [operationState, resolvedDisplayAnchorAssistantMessageIds]);

  const { data = [] } = useClientDataSWR<TaskWorkContextVersionItem[]>(
    workKeys.displayAnchorAssistantMessage(resolvedDisplayAnchorAssistantMessageIds),
    () =>
      workService.listByDisplayAnchorAssistantMessage({
        displayAnchorAssistantMessageIds: resolvedDisplayAnchorAssistantMessageIds,
      }),
    {
      fallbackData: [],
      revalidateOnFocus: false,
    },
  );

  useEffect(() => {
    if (!rootOperationId || !isTerminal(operationState.operations[rootOperationId])) return;
    if (refreshedTerminalOperationRef.current === rootOperationId) return;

    refreshedTerminalOperationRef.current = rootOperationId;
    void workService.refreshDisplayAnchorAssistantMessages(
      resolvedDisplayAnchorAssistantMessageIds,
    );
  }, [operationState.operations, resolvedDisplayAnchorAssistantMessageIds, rootOperationId]);

  if (data.length === 0) return null;

  return (
    <Flexbox className={styles.container}>
      <Flexbox horizontal align={'center'} className={styles.header} gap={8}>
        <ClipboardListIcon size={14} />
        <Text type={'secondary'}>{t('workingPanel.works.title')}</Text>
      </Flexbox>
      {data.map((item) => {
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
            <Text ellipsis className={styles.title}>
              {item.version.title || item.title}
            </Text>
          </Flexbox>
        );
      })}
    </Flexbox>
  );
}, isEqual);

MessageWorks.displayName = 'MessageWorks';

export default MessageWorks;
