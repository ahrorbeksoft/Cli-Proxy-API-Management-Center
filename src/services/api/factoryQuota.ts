import type { FactoryQuotaData, FactoryQuotaWindow } from '@/types';

export const FACTORY_DEFAULT_BASE_URL = 'https://api.factory.ai';
export const FACTORY_BILLING_LIMITS_PATH = '/api/billing/limits';
// Keep aligned with FactoryCLIVersion in the backend Factory transport.
export const FACTORY_CLI_VERSION = '0.245.1';

export const FACTORY_REQUEST_HEADERS = {
  Authorization: 'Bearer $TOKEN$',
  Accept: 'application/json',
  'User-Agent': `factory-cli/${FACTORY_CLI_VERSION}`,
  'X-Factory-Client': 'cli',
  'X-Client-Version': FACTORY_CLI_VERSION,
};

const FACTORY_WINDOWS = [
  { id: 'fiveHour', periodHours: 5 },
  { id: 'weekly', periodHours: 168 },
  { id: 'monthly', periodHours: 720 },
] as const;

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function resolveFactoryBillingLimitsUrl(baseUrl: unknown): string {
  const base =
    typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim() : FACTORY_DEFAULT_BASE_URL;
  return `${base.replace(/\/+$/, '')}${FACTORY_BILLING_LIMITS_PATH}`;
}

const readWindow = (
  value: unknown,
  id: FactoryQuotaWindow['id'],
  periodHours: number,
  observedAtMs: number
): FactoryQuotaWindow => {
  const record = asRecord(value);
  const used = asFiniteNumber(record.usedPercent);
  const remainingPercent =
    used === null ? null : Math.round(Math.min(100, Math.max(0, 100 - used)));
  // windowEnd is absolute; secondsRemaining is only a fallback relative to this observation.
  const windowEnd = typeof record.windowEnd === 'string' ? Date.parse(record.windowEnd) : NaN;
  const secondsRemaining = asFiniteNumber(record.secondsRemaining);
  const resetAtMs = Number.isFinite(windowEnd)
    ? windowEnd
    : secondsRemaining !== null && secondsRemaining > 0
      ? observedAtMs + secondsRemaining * 1000
      : null;
  return { id, remainingPercent, resetAtMs, periodHours };
};

/** Normalize GET /api/billing/limits. Only the standard pool serves Claude and GPT models. */
export function readFactoryQuotaResponse(
  payload: unknown,
  observedAtMs = Date.now()
): FactoryQuotaData {
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = null;
    }
  }
  const root = asRecord(payload);
  const standard = asRecord(asRecord(root.limits).standard);
  return {
    windows: FACTORY_WINDOWS.map(({ id, periodHours }) =>
      readWindow(standard[id], id, periodHours, observedAtMs)
    ),
    extraUsageAllowed: root.extraUsageAllowed === true,
    extraUsageBalanceCents: asFiniteNumber(root.extraUsageBalanceCents),
    overagePreference:
      typeof root.overagePreference === 'string' && root.overagePreference.trim()
        ? root.overagePreference.trim()
        : null,
  };
}

export const hasFactoryQuotaObservation = (quota: FactoryQuotaData): boolean =>
  quota.windows.some((window) => window.remainingPercent !== null);
