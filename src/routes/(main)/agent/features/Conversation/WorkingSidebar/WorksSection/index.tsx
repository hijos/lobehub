import type {
  TaskStatus,
  TaskWorkListItem,
  WorkListItem,
  WorkSummaryItem,
  WorkVersionListItem,
} from '@lobechat/types';
import { ActionIcon, Center, Empty, Flexbox, Text } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDotIcon,
  ClipboardListIcon,
  FileTextIcon,
  HistoryIcon,
  ListIcon,
  MessageSquareTextIcon,
} from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import NeuralNetworkLoading from '@/components/NeuralNetworkLoading';
import { formatTaskItemDate } from '@/features/AgentTasks/features/formatTaskItemDate';
import TaskPriorityTag from '@/features/AgentTasks/features/TaskPriorityTag';
import TaskStatusTag from '@/features/AgentTasks/features/TaskStatusTag';
import WorkSummaryCard from '@/features/AgentTasks/features/WorkSummaryCard';
import { useLocalStorageState } from '@/hooks/useLocalStorageState';
import { useClientDataSWR } from '@/libs/swr';
import { workKeys } from '@/libs/swr/keys';
import { workService } from '@/services/work';
import { useChatStore } from '@/store/chat';
import {
  formatWorkVersionCost,
  getWorkSummaryCostRefreshInterval,
  getWorkVersionCostRefreshInterval,
} from '@/utils/workVersionCost';

const TASK_STATUS_SET = new Set<TaskStatus>([
  'backlog',
  'canceled',
  'completed',
  'failed',
  'paused',
  'running',
  'scheduled',
]);

const toTaskStatus = (status?: string | null): TaskStatus =>
  status && TASK_STATUS_SET.has(status as TaskStatus) ? (status as TaskStatus) : 'backlog';

type WorksViewMode = 'history' | 'summary';

const WORKS_VIEW_MODE_STORAGE_KEY = 'lobechat-working-panel-works-view-mode';

const styles = createStaticStyles(({ css, cssVar }) => ({
  container: css`
    min-height: 0;
    padding-block: 8px;
    padding-inline: 8px 12px;
  `,
  context: css`
    color: ${cssVar.colorTextTertiary};
  `,
  error: css`
    padding-block: 8px;
    padding-inline: 36px 8px;
    color: ${cssVar.colorError};
  `,
  header: css`
    cursor: pointer;
    user-select: none;
    padding-block: 10px;
    padding-inline: 8px;

    &:hover {
      background: ${cssVar.colorFillQuaternary};
    }
  `,
  modeToolbar: css`
    flex-shrink: 0;
    align-self: flex-end;
  `,
  title: css`
    min-width: 0;
    font-size: 14px;
    font-weight: 500;
  `,
  versionCost: css`
    color: ${cssVar.colorTextTertiary};
  `,
  versionList: css`
    margin-inline-start: 34px;
    padding-block: 6px 10px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  versionRow: css`
    padding-block: 6px;
    font-size: 12px;
  `,
  versionTitle: css`
    color: ${cssVar.colorTextSecondary};
  `,
  workCard: css`
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    background: ${cssVar.colorFillQuaternary};
  `,
}));

const VersionList = memo<{ workId: string }>(({ workId }) => {
  const { i18n, t } = useTranslation(['chat', 'common']);
  const {
    data = [],
    error,
    isLoading,
  } = useClientDataSWR<WorkVersionListItem[]>(
    workKeys.versions(workId),
    () => workService.listVersions(workId),
    {
      fallbackData: [],
      refreshInterval: getWorkVersionCostRefreshInterval,
      revalidateOnFocus: false,
    },
  );

  if (isLoading) {
    return (
      <Center height={56}>
        <NeuralNetworkLoading size={18} />
      </Center>
    );
  }

  if (error) {
    return <Text className={styles.error}>{t('workingPanel.works.versionError')}</Text>;
  }

  if (data.length === 0) {
    return (
      <Flexbox className={styles.versionList}>
        <Text type={'secondary'}>{t('workingPanel.works.emptyVersions')}</Text>
      </Flexbox>
    );
  }

  return (
    <Flexbox className={styles.versionList}>
      {data.map((version) => {
        const cost = formatWorkVersionCost(version.cumulativeCost);
        const time = formatTaskItemDate(version.createdAt, {
          formatOtherYear: t('time.formatOtherYear', { ns: 'common' }),
          formatThisYear: t('time.formatThisYear', { ns: 'common' }),
          locale: i18n.language,
        });

        return (
          <Flexbox className={styles.versionRow} gap={4} key={version.id}>
            <Flexbox horizontal align={'center'} gap={8} justify={'space-between'}>
              <Flexbox horizontal align={'center'} gap={8} style={{ minWidth: 0 }}>
                <Text code fontSize={12}>
                  v{version.version}
                </Text>
                <Text ellipsis className={styles.versionTitle}>
                  {t(`workingPanel.works.role.${version.context?.role ?? 'updated'}` as never)}
                </Text>
              </Flexbox>
              <Flexbox horizontal align={'center'} gap={8} style={{ flexShrink: 0 }}>
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
                {time && (
                  <Text className={styles.context} type={'secondary'}>
                    {time}
                  </Text>
                )}
              </Flexbox>
            </Flexbox>
            <Text ellipsis className={styles.context}>
              {version.title}
            </Text>
          </Flexbox>
        );
      })}
    </Flexbox>
  );
});

VersionList.displayName = 'VersionList';

const TaskWorkVersionHistoryCard = memo<{ work: TaskWorkListItem }>(({ work }) => {
  const [expanded, setExpanded] = useState(true);
  const openTaskDetail = useChatStore((s) => s.openTaskDetail);
  const status = toTaskStatus(work.task.status);
  const taskIdentifier = work.resourceIdentifier ?? work.resourceId;
  const ToggleIcon = expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <Flexbox className={styles.workCard}>
      <Flexbox
        horizontal
        align={'center'}
        className={styles.header}
        gap={8}
        onClick={() => setExpanded((value) => !value)}
      >
        <ToggleIcon size={16} />
        <TaskPriorityTag disableDropdown priority={work.task.priority} size={14} />
        <TaskStatusTag disableDropdown size={14} status={status} />
        <Text className={styles.context} style={{ flexShrink: 0 }}>
          {taskIdentifier}
        </Text>
        <Text
          ellipsis
          className={styles.title}
          onClick={(event) => {
            event.stopPropagation();
            openTaskDetail(taskIdentifier);
          }}
        >
          {work.title}
        </Text>
      </Flexbox>
      {expanded && <VersionList workId={work.id} />}
    </Flexbox>
  );
});

TaskWorkVersionHistoryCard.displayName = 'TaskWorkVersionHistoryCard';

const DocumentWorkVersionHistoryCard = memo<{ work: Extract<WorkListItem, { type: 'document' }> }>(
  ({ work }) => {
    const [expanded, setExpanded] = useState(true);
    const openDocument = useChatStore((s) => s.openDocument);
    const ToggleIcon = expanded ? ChevronDownIcon : ChevronRightIcon;
    const label = work.resourceIdentifier ?? work.resourceId;

    return (
      <Flexbox className={styles.workCard}>
        <Flexbox
          horizontal
          align={'center'}
          className={styles.header}
          gap={8}
          onClick={() => setExpanded((value) => !value)}
        >
          <ToggleIcon size={16} />
          <FileTextIcon className={styles.context} size={16} />
          <Text className={styles.context} style={{ flexShrink: 0 }}>
            {label}
          </Text>
          <Text
            ellipsis
            className={styles.title}
            onClick={(event) => {
              event.stopPropagation();
              openDocument(work.document.id);
            }}
          >
            {work.title}
          </Text>
        </Flexbox>
        {expanded && <VersionList workId={work.id} />}
      </Flexbox>
    );
  },
);

DocumentWorkVersionHistoryCard.displayName = 'DocumentWorkVersionHistoryCard';

const LinearWorkVersionHistoryCard = memo<{ work: Extract<WorkListItem, { type: 'linear' }> }>(
  ({ work }) => {
    const [expanded, setExpanded] = useState(true);
    const ToggleIcon = expanded ? ChevronDownIcon : ChevronRightIcon;
    const label = work.resourceIdentifier ?? work.resourceId;
    const Icon =
      work.linear.entityType === 'comment'
        ? MessageSquareTextIcon
        : work.linear.entityType === 'document'
          ? FileTextIcon
          : CircleDotIcon;

    return (
      <Flexbox className={styles.workCard}>
        <Flexbox
          horizontal
          align={'center'}
          className={styles.header}
          gap={8}
          onClick={() => setExpanded((value) => !value)}
        >
          <ToggleIcon size={16} />
          <Icon className={styles.context} size={16} />
          <Text className={styles.context} style={{ flexShrink: 0 }}>
            {label}
          </Text>
          <Text
            ellipsis
            className={styles.title}
            onClick={(event) => {
              event.stopPropagation();
              if (work.linear.url) window.open(work.linear.url, '_blank', 'noopener,noreferrer');
            }}
          >
            {work.title}
          </Text>
        </Flexbox>
        {expanded && <VersionList workId={work.id} />}
      </Flexbox>
    );
  },
);

LinearWorkVersionHistoryCard.displayName = 'LinearWorkVersionHistoryCard';

const WorkVersionHistoryCard = memo<{ work: WorkListItem }>(({ work }) =>
  work.type === 'document' ? (
    <DocumentWorkVersionHistoryCard work={work} />
  ) : work.type === 'linear' ? (
    <LinearWorkVersionHistoryCard work={work} />
  ) : (
    <TaskWorkVersionHistoryCard work={work} />
  ),
);

WorkVersionHistoryCard.displayName = 'WorkVersionHistoryCard';

const WorksModeToolbar = memo<{
  mode: WorksViewMode;
  setMode: (mode: WorksViewMode) => void;
}>(({ mode, setMode }) => {
  const { t } = useTranslation('chat');

  return (
    <Flexbox horizontal className={styles.modeToolbar} gap={4}>
      <ActionIcon
        active={mode === 'summary'}
        icon={ListIcon}
        size={'small'}
        title={t('workingPanel.works.viewMode.summary')}
        onClick={() => setMode('summary')}
      />
      <ActionIcon
        active={mode === 'history'}
        icon={HistoryIcon}
        size={'small'}
        title={t('workingPanel.works.viewMode.history')}
        onClick={() => setMode('history')}
      />
    </Flexbox>
  );
});

WorksModeToolbar.displayName = 'WorksModeToolbar';

const WorksSection = memo(() => {
  const { t } = useTranslation('chat');
  const [mode, setMode] = useLocalStorageState<WorksViewMode>(
    WORKS_VIEW_MODE_STORAGE_KEY,
    'summary',
  );
  const topicId = useChatStore((s) => s.activeTopicId);
  const threadId = useChatStore((s) => s.activeThreadId);
  const {
    data: summaryData = [],
    error: summaryError,
    isLoading: isSummaryLoading,
  } = useClientDataSWR<WorkSummaryItem[]>(
    mode === 'summary' && topicId
      ? workKeys.conversationSummaries(topicId, threadId ?? null)
      : null,
    () => workService.listSummariesByConversation({ threadId, topicId }),
    {
      fallbackData: [],
      refreshInterval: getWorkSummaryCostRefreshInterval,
      revalidateOnFocus: false,
    },
  );
  const {
    data: historyData = [],
    error: historyError,
    isLoading: isHistoryLoading,
  } = useClientDataSWR<WorkListItem[]>(
    mode === 'history' && topicId ? workKeys.conversation(topicId, threadId ?? null) : null,
    () => workService.listByConversation({ threadId, topicId }),
    {
      fallbackData: [],
      revalidateOnFocus: false,
    },
  );

  const isLoading = mode === 'summary' ? isSummaryLoading : isHistoryLoading;
  const error = mode === 'summary' ? summaryError : historyError;
  const data = mode === 'summary' ? summaryData : historyData;

  const content = (() => {
    if (isLoading) {
      return (
        <Center flex={1}>
          <NeuralNetworkLoading size={24} />
        </Center>
      );
    }

    if (error) {
      return (
        <Center flex={1}>
          <Empty description={t('workingPanel.works.error')} icon={ClipboardListIcon} />
        </Center>
      );
    }

    if (data.length === 0) {
      return (
        <Center flex={1}>
          <Empty description={t('workingPanel.works.empty')} icon={ClipboardListIcon} />
        </Center>
      );
    }

    return mode === 'summary'
      ? summaryData.map((work) => (
          <WorkSummaryCard className={styles.workCard} item={work} key={work.id} />
        ))
      : historyData.map((work) => <WorkVersionHistoryCard key={work.id} work={work} />);
  })();

  return (
    <Flexbox className={styles.container} flex={1} gap={12}>
      <WorksModeToolbar mode={mode} setMode={setMode} />
      {content}
    </Flexbox>
  );
});

WorksSection.displayName = 'WorksSection';

export default WorksSection;
