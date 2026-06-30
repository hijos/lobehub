'use client';

import type { TaskWorkSummaryItem } from '@lobechat/types';
import { Flexbox, Text } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { ClipboardListIcon } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { useChatStore } from '@/store/chat';
import { formatWorkVersionCost } from '@/utils/workVersionCost';

const styles = createStaticStyles(({ css, cssVar }) => ({
  card: css`
    cursor: pointer;

    overflow: hidden;

    width: 100%;
    padding-block: 12px;
    padding-inline: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;

    background: ${cssVar.colorBgElevated};

    &:hover {
      background: ${cssVar.colorFillQuaternary};
    }
  `,
  cost: css`
    flex-shrink: 0;
    color: ${cssVar.colorTextTertiary};
  `,
  icon: css`
    flex-shrink: 0;

    width: 36px;
    height: 36px;
    border-radius: 8px;

    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorFillTertiary};
  `,
  description: css`
    min-width: 0;
    color: ${cssVar.colorTextTertiary};
  `,
  title: css`
    min-width: 0;
    font-size: 14px;
    font-weight: 500;
  `,
}));

interface WorkSummaryCardProps {
  className?: string;
  item: TaskWorkSummaryItem;
}

const WorkSummaryCard = memo<WorkSummaryCardProps>(({ className, item }) => {
  const { t } = useTranslation('chat');
  const openTaskDetail = useChatStore((s) => s.openTaskDetail);
  const taskIdentifier = item.resourceIdentifier ?? item.resourceId;
  const cost = formatWorkVersionCost(item.totalCost);
  const title = item.version?.title || item.title;
  const description = item.task.description?.trim();

  return (
    <Flexbox
      horizontal
      align={'center'}
      className={[styles.card, className].filter(Boolean).join(' ')}
      gap={12}
      onClick={() => openTaskDetail(taskIdentifier)}
    >
      <Flexbox align={'center'} className={styles.icon} justify={'center'}>
        <ClipboardListIcon size={18} />
      </Flexbox>
      <Flexbox flex={1} gap={6} style={{ minWidth: 0 }}>
        <Flexbox horizontal align={'center'} gap={8} justify={'space-between'}>
          <Text ellipsis className={styles.title}>
            {title}
          </Text>
          {cost && (
            <Text
              code
              className={styles.cost}
              fontSize={12}
              title={t('workingPanel.works.cumulativeCost', { cost })}
            >
              {cost}
            </Text>
          )}
        </Flexbox>
        {description && (
          <Text ellipsis className={styles.description} fontSize={13}>
            {description}
          </Text>
        )}
      </Flexbox>
    </Flexbox>
  );
});

WorkSummaryCard.displayName = 'WorkSummaryCard';

export default WorkSummaryCard;
