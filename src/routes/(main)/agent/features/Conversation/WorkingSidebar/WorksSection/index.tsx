import type { TaskStatus, TaskWorkListItem, WorkVersionListItem } from '@lobechat/types';
import { Center, Empty, Flexbox, Text } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { ChevronDownIcon, ChevronRightIcon, ClipboardListIcon } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import NeuralNetworkLoading from '@/components/NeuralNetworkLoading';
import { formatTaskItemDate } from '@/features/AgentTasks/features/formatTaskItemDate';
import TaskPriorityTag from '@/features/AgentTasks/features/TaskPriorityTag';
import TaskStatusTag from '@/features/AgentTasks/features/TaskStatusTag';
import { useNavigateToTaskDetail } from '@/features/AgentTasks/shared/taskDetailPath';
import { useClientDataSWR } from '@/libs/swr';
import { workKeys } from '@/libs/swr/keys';
import { workService } from '@/services/work';
import { useChatStore } from '@/store/chat';
import { formatWorkVersionCost, getWorkVersionCostRefreshInterval } from '@/utils/workVersionCost';

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
  title: css`
    min-width: 0;
    font-size: 14px;
    font-weight: 500;
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
  versionCost: css`
    color: ${cssVar.colorTextTertiary};
  `,
  workCard: css`
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    background: ${cssVar.colorBgElevated};
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

const WorkCard = memo<{ work: TaskWorkListItem }>(({ work }) => {
  const [expanded, setExpanded] = useState(false);
  const navigateToTask = useNavigateToTaskDetail();
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
            navigateToTask(taskIdentifier);
          }}
        >
          {work.title}
        </Text>
      </Flexbox>
      {expanded && <VersionList workId={work.id} />}
    </Flexbox>
  );
});

WorkCard.displayName = 'WorkCard';

const WorksSection = memo(() => {
  const { t } = useTranslation('chat');
  const topicId = useChatStore((s) => s.activeTopicId);
  const threadId = useChatStore((s) => s.activeThreadId);
  const {
    data = [],
    error,
    isLoading,
  } = useClientDataSWR<TaskWorkListItem[]>(
    topicId ? workKeys.conversation(topicId, threadId ?? null) : null,
    () => workService.listByConversation({ threadId, topicId }),
    {
      fallbackData: [],
      revalidateOnFocus: false,
    },
  );

  if (isLoading) {
    return (
      <Center height={'100%'}>
        <NeuralNetworkLoading size={24} />
      </Center>
    );
  }

  if (error) {
    return (
      <Center height={'100%'}>
        <Empty description={t('workingPanel.works.error')} icon={ClipboardListIcon} />
      </Center>
    );
  }

  if (data.length === 0) {
    return (
      <Center height={'100%'}>
        <Empty description={t('workingPanel.works.empty')} icon={ClipboardListIcon} />
      </Center>
    );
  }

  return (
    <Flexbox className={styles.container} flex={1} gap={12}>
      {data.map((work) => (
        <WorkCard key={work.id} work={work} />
      ))}
    </Flexbox>
  );
});

WorksSection.displayName = 'WorksSection';

export default WorksSection;
