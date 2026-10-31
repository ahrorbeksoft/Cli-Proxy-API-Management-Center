import { useTranslation } from 'react-i18next';
import type { FactoryQuotaState } from '@/types';
import { useNow } from '@/hooks/useNow';
import { buildResetDisplay } from '@/utils/quota';
import { QuotaMeter } from '../../components/QuotaMeter';
import { QuotaResetLabel } from '../../components/QuotaResetLabel';
import { collectQuotaRowInstants, pickUrgentRowId } from '../../resetSchedule';
import type { QuotaBodyProps } from '../../types';

const formatCents = (cents: number, locale?: string): string => {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(
      cents / 100
    );
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
};

export function FactoryQuotaBody({ quota, classes }: QuotaBodyProps<FactoryQuotaState>) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const locale = i18n.resolvedLanguage;
  const urgentRow = pickUrgentRowId(collectQuotaRowInstants('factory', quota), now);
  const balance = quota.extraUsageBalanceCents;

  return (
    <>
      <div className={classes.codexPlan}>
        <span className={classes.codexPlanItem}>
          <span className={classes.codexPlanLabel}>{t('factory_quota.extra_usage')}</span>
          <span className={classes.codexPlanValue}>
            {quota.extraUsageAllowed ? t('factory_quota.extra_on') : t('factory_quota.extra_off')}
          </span>
        </span>
        {balance !== null && (quota.extraUsageAllowed || balance > 0) && (
          <span className={classes.codexPlanItem}>
            <span className={classes.codexPlanLabel}>{t('factory_quota.extra_balance')}</span>
            <span className={classes.codexPlanValue}>{formatCents(balance, locale)}</span>
          </span>
        )}
      </div>
      {quota.windows.map((window, index) => {
        const reset = buildResetDisplay(null, window.resetAtMs, now, locale);
        const soon = window.id === urgentRow;
        const label = t(`factory_quota.${window.id}`);
        return (
          <div key={window.id} className={classes.quotaRow}>
            <div className={classes.quotaRowHeader}>
              <span className={classes.quotaModel}>{label}</span>
              <div className={classes.quotaMeta}>
                <span className={classes.quotaPercent}>
                  {window.remainingPercent === null
                    ? t('factory_quota.unavailable')
                    : `${window.remainingPercent}%`}
                </span>
                {reset ? (
                  <QuotaResetLabel display={reset} classes={classes} soon={soon} />
                ) : (
                  <span className={classes.quotaReset}>
                    {window.remainingPercent === 100
                      ? t('factory_quota.not_started')
                      : t('factory_quota.reset_unknown')}
                  </span>
                )}
              </div>
            </div>
            <div
              role={window.remainingPercent === null ? undefined : 'meter'}
              aria-label={window.remainingPercent === null ? undefined : label}
              aria-valuemin={window.remainingPercent === null ? undefined : 0}
              aria-valuemax={window.remainingPercent === null ? undefined : 100}
              aria-valuenow={window.remainingPercent ?? undefined}
            >
              <QuotaMeter percent={window.remainingPercent} classes={classes} index={index} />
            </div>
          </div>
        );
      })}
    </>
  );
}
