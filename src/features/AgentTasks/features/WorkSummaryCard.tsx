'use client';

import type { WorkSummaryItem } from '@lobechat/types';
import { Flexbox, Text } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { ClipboardListIcon, FileTextIcon } from 'lucide-react';
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
  item: WorkSummaryItem;
}

const WorkSummaryCard = memo<WorkSummaryCardProps>(({ className, item }) => {
  const { t } = useTranslation('chat');
  const [openDocument, openTaskDetail] = useChatStore((s) => [s.openDocument, s.openTaskDetail]);
  const cost = formatWorkVersionCost(item.totalCost);
  const title = item.version?.title || item.title;
  const isDocument = item.type === 'document';
  const description = isDocument
    ? item.document.description?.trim()
    : item.task.description?.trim();
  const Icon = isDocument ? FileTextIcon : ClipboardListIcon;
  const handleOpen = () => {
    if (isDocument) {
      openDocument(item.document.id, item.context.metadata?.agentDocumentId);
      return;
    }

    openTaskDetail(item.resourceIdentifier ?? item.resourceId);
  };

  return (
    <Flexbox
      horizontal
      align={'center'}
      className={[styles.card, className].filter(Boolean).join(' ')}
      gap={12}
      onClick={handleOpen}
    >
      <Flexbox align={'center'} className={styles.icon} justify={'center'}>
        <Icon size={18} />
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
