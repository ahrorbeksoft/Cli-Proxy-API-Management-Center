/**
 * Factory quota data layer. React-free / SCSS-free.
 *
 * Factory keys live in config (api-keys.factory) rather than auth files, so the
 * quota page synthesizes one credential entry per configured key.
 */

import type { TFunction } from 'i18next';
import type { AuthFileItem, FactoryQuotaData, FactoryQuotaState, ProviderKeyConfig } from '@/types';
import { apiCallApi, getApiCallErrorMessage } from '@/services/api/apiCall';
import {
  FACTORY_REQUEST_HEADERS,
  hasFactoryQuotaObservation,
  readFactoryQuotaResponse,
  resolveFactoryBillingLimitsUrl,
} from '@/services/api/factoryQuota';
import { hasDisableAllModelsRule } from '@/components/providers/utils';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { maskApiKey } from '@/utils/format';
import { createStatusError, isDisabledAuthFile, isFactoryFile } from '@/utils/quota';
import type { QuotaProviderData } from '../types';

/**
 * One quota entry per configured Factory key. The name carries only the group
 * name and a masked key; the raw key never leaves the config store.
 */
export function buildFactoryQuotaFiles(
  configs: readonly ProviderKeyConfig[] | undefined,
  listed: readonly AuthFileItem[] = []
): AuthFileItem[] {
  const listedIndexes = new Set(
    listed
      .filter(isFactoryFile)
      .map((file) => normalizeAuthIndex(file.authIndex ?? file['auth_index']))
      .filter(Boolean)
  );
  const files: AuthFileItem[] = [];
  for (const config of configs ?? []) {
    const authIndex = normalizeAuthIndex(config.authIndex);
    if (!authIndex || listedIndexes.has(authIndex)) continue;
    const groupName = config.source?.group?.name;
    const label = typeof groupName === 'string' && groupName.trim() ? groupName.trim() : 'Factory';
    files.push({
      name: `${label} · ${maskApiKey(config.apiKey)}`,
      type: 'factory',
      provider: 'factory',
      authIndex,
      disabled: hasDisableAllModelsRule(config.excludedModels),
      baseUrl: config.baseUrl,
    });
  }
  return files;
}

/**
 * Show the resolved account (email or organization) on Factory entries. Only `email`
 * changes, so cache keys (name + auth index) and auto-load attempts stay stable.
 */
export function withFactoryAccountLabels(
  files: AuthFileItem[],
  labels: Readonly<Record<string, string>>
): AuthFileItem[] {
  if (!Object.keys(labels).length) return files;
  let changed = false;
  const next = files.map((file) => {
    if (!isFactoryFile(file)) return file;
    const authIndex = normalizeAuthIndex(file.authIndex ?? file['auth_index']);
    const label = authIndex ? labels[authIndex] : undefined;
    if (!label || file.email === label) return file;
    changed = true;
    return { ...file, email: label };
  });
  return changed ? next : files;
}

const withLabels = (quota: FactoryQuotaData, t: TFunction): FactoryQuotaData => ({
  ...quota,
  windows: quota.windows.map((window) => ({
    ...window,
    label: t(`factory_quota.${window.id}`),
  })),
});

const emptyData = (): FactoryQuotaData => ({
  windows: [],
  extraUsageAllowed: false,
  extraUsageBalanceCents: null,
  overagePreference: null,
});

const fetchFactoryQuota = async (file: AuthFileItem, t: TFunction): Promise<FactoryQuotaData> => {
  const authIndex = normalizeAuthIndex(file.authIndex ?? file['auth_index']);
  if (!authIndex) {
    throw new Error(t('factory_quota.missing_auth_index'));
  }
  const result = await apiCallApi.request({
    authIndex,
    method: 'GET',
    url: resolveFactoryBillingLimitsUrl(file.baseUrl),
    header: { ...FACTORY_REQUEST_HEADERS },
  });
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw createStatusError(getApiCallErrorMessage(result), result.statusCode);
  }
  const quota = readFactoryQuotaResponse(result.body ?? result.bodyText);
  if (!hasFactoryQuotaObservation(quota)) {
    throw new Error(t('factory_quota.empty_data'));
  }
  return withLabels(quota, t);
};

export const FACTORY_CONFIG: QuotaProviderData<FactoryQuotaState, FactoryQuotaData> = {
  type: 'factory',
  i18nPrefix: 'factory_quota',
  filterFn: (file) => isFactoryFile(file) && !isDisabledAuthFile(file),
  fetchQuota: fetchFactoryQuota,
  storeSelector: (state) => state.factoryQuota,
  storeSetter: 'setFactoryQuota',
  buildLoadingState: () => ({ status: 'loading', ...emptyData() }),
  buildSuccessState: (data) => ({ status: 'success', ...data }),
  buildErrorState: (error, errorStatus) => ({
    status: 'error',
    ...emptyData(),
    error,
    errorStatus,
  }),
};
