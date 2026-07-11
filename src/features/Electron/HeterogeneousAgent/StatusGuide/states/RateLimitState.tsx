import { Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { CalendarClock, Play, RotateCcw } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import GuideActions from '../GuideActions';
import GuideShell from '../GuideShell';
import type { HeterogeneousAgentGuideStateProps } from '../types';

const styles = createStaticStyles(({ css }) => ({
  actions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
  `,
  details: css`
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 8px 12px;
    align-items: baseline;
  `,
  label: css`
    font-size: 12px;
    white-space: nowrap;
  `,
  value: css`
    min-width: 0;
  `,
}));

const extractTimezoneLabel = (value?: string) => {
  if (!value) return;

  const match = value.match(/\(([^()]+)\)\s*$/);
  return match?.[1];
};

const RateLimitState = ({
  config,
  error,
  onRetry,
  schedule,
  variant,
}: HeterogeneousAgentGuideStateProps) => {
  const { t, i18n } = useTranslation('chat');
  const rawErrorDetails = error?.stderr || error?.message;
  // Prefer the persisted scheduled reset time so the "scheduled" copy stays
  // stable even if the live error payload is missing it on reload.
  const resetsAt = schedule?.resetsAt ?? error?.rateLimitInfo?.resetsAt;
  const canRetry = !resetsAt || resetsAt * 1000 <= Date.now();
  const dateLocale = i18n.resolvedLanguage || i18n.language || undefined;
  const timezoneLabel = useMemo(
    () => extractTimezoneLabel(rawErrorDetails) || Intl.DateTimeFormat().resolvedOptions().timeZone,
    [rawErrorDetails],
  );
  const formattedResetAt = useMemo(() => {
    if (!resetsAt) return;

    try {
      return new Intl.DateTimeFormat(dateLocale, {
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        month: 'short',
        ...(timezoneLabel ? { timeZone: timezoneLabel } : {}),
        weekday: 'short',
      }).format(new Date(resetsAt * 1000));
    } catch {
      try {
        return new Intl.DateTimeFormat(dateLocale, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(resetsAt * 1000));
      } catch {
        return;
      }
    }
  }, [dateLocale, resetsAt, timezoneLabel]);
  const rateLimitTypeLabel = useMemo(() => {
    const rateLimitType = error?.rateLimitInfo?.rateLimitType;
    if (!rateLimitType) return;

    if (rateLimitType === 'seven_day') {
      return t('cliRateLimitGuide.limitTypes.weekCycle');
    }

    return rateLimitType.replaceAll('_', ' ');
  }, [error?.rateLimitInfo?.rateLimitType, t]);
  // The "~X h Y m" duration string, reused for the header hint and the
  // scheduling action/label copy.
  const relativeDuration = useMemo(() => {
    if (!resetsAt) return;

    const diffMs = Math.max(0, resetsAt * 1000 - Date.now());
    const totalMinutes = Math.floor(diffMs / 60_000);
    if (totalMinutes <= 0) return;

    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const minutes = totalMinutes % 60;
    const parts: string[] = [];

    if (days > 0) parts.push(t('cliRateLimitGuide.relative.day', { count: days }));
    if (hours > 0) parts.push(t('cliRateLimitGuide.relative.hour', { count: hours }));
    if (minutes > 0 && parts.length < 2) {
      parts.push(t('cliRateLimitGuide.relative.minute', { count: minutes }));
    }

    return parts.length > 0 ? parts.slice(0, 2).join(' ') : undefined;
  }, [resetsAt, t]);
  const relativeResetText = useMemo(() => {
    if (!resetsAt) return;
    if (!relativeDuration) return t('cliRateLimitGuide.relative.resetComplete');
    return t('cliRateLimitGuide.resetInApprox', { duration: relativeDuration });
  }, [resetsAt, relativeDuration, t]);

  const isScheduled = Boolean(schedule?.isScheduled);

  const actions = useMemo(() => {
    if (!schedule) {
      return (
        <GuideActions
          retryLabel={t('cliRateLimitGuide.actions.retry')}
          retryPrimary={canRetry}
          onRetry={onRetry}
        />
      );
    }

    if (schedule.isScheduled) {
      return (
        <div className={styles.actions}>
          <Button size="small" onClick={schedule.onCancel}>
            {t('cliRateLimitGuide.schedule.cancel')}
          </Button>
          <Button icon={<Play size={14} />} size="small" type="primary" onClick={schedule.onRunNow}>
            {t('cliRateLimitGuide.schedule.runNow')}
          </Button>
        </div>
      );
    }

    return (
      <div className={styles.actions}>
        {onRetry && (
          <Button icon={<RotateCcw size={14} />} size="small" onClick={onRetry}>
            {t('cliRateLimitGuide.schedule.retryNow')}
          </Button>
        )}
        <Button
          icon={<CalendarClock size={14} />}
          size="small"
          type="primary"
          onClick={schedule.onSchedule}
        >
          {relativeDuration
            ? t('cliRateLimitGuide.schedule.continueAfter', { duration: relativeDuration })
            : t('cliRateLimitGuide.schedule.continueAfterReset')}
        </Button>
      </div>
    );
  }, [canRetry, onRetry, relativeDuration, schedule, t]);

  return (
    <GuideShell
      actions={actions}
      icon={<config.icon size={24} />}
      title={t('cliRateLimitGuide.title', { name: config.title })}
      variant={variant}
      headerDescription={
        <Text type="secondary">
          {isScheduled
            ? relativeDuration
              ? t('cliRateLimitGuide.schedule.scheduledForApprox', { duration: relativeDuration })
              : t('cliRateLimitGuide.schedule.scheduledAfterReset')
            : t('cliRateLimitGuide.afterReset', {
                resetAt: formattedResetAt
                  ? `${formattedResetAt}${timezoneLabel ? ` (${timezoneLabel})` : ''}`
                  : t('cliRateLimitGuide.resetUnknown'),
              })}
        </Text>
      }
    >
      <div className={styles.details}>
        {formattedResetAt && (
          <>
            <Text strong className={styles.label}>
              {t('cliRateLimitGuide.resetAt')}
            </Text>
            <div className={styles.value}>
              <Text>{`${formattedResetAt}${timezoneLabel ? ` (${timezoneLabel})` : ''}`}</Text>
            </div>
          </>
        )}

        {relativeResetText && (
          <>
            <Text strong className={styles.label}>
              {t('cliRateLimitGuide.resetIn')}
            </Text>
            <Text className={styles.value}>{relativeResetText}</Text>
          </>
        )}

        {rateLimitTypeLabel && (
          <>
            <Text strong className={styles.label}>
              {t('cliRateLimitGuide.limitType')}
            </Text>
            <Text className={styles.value}>{rateLimitTypeLabel}</Text>
          </>
        )}
      </div>
    </GuideShell>
  );
};

export default RateLimitState;
