import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import type { AuthFileItem, FactoryQuotaState } from '@/types';
import { apiClient } from '@/services/api/client';
import { normalizeConfigResponse } from '@/services/api/transformers';
import {
  readFactoryQuotaResponse,
  resolveFactoryBillingLimitsUrl,
} from '@/services/api/factoryQuota';
import { FACTORY_CONFIG, buildFactoryQuotaFiles } from '@/features/quota/providers/factory/data';
import { FactoryQuotaBody } from '@/features/quota/providers/factory/FactoryQuotaBody';
import { QUOTA_ADAPTERS } from '@/features/quota/providers';
import { QUOTA_CLASS_KEYS, bindQuotaClasses } from '@/features/quota/types';
import { buildTabCounts, classifyQuotaFiles } from '@/features/quota/logic';
import { buildTimelineLane } from '@/features/quota/quotaTimelineModel';
import { nextRecoveryMs } from '@/features/quota/resetSchedule';
import { getAuthFileIcon } from '@/features/authFiles/constants';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { useQuotaStore } from '@/stores/useQuotaStore';

const observedAtMs = Date.parse('2099-01-01T00:00:00Z');
const limitsPayload = {
  limits: {
    standard: {
      fiveHour: { usedPercent: 100, windowEnd: '2099-01-01T03:00:00Z', secondsRemaining: 10800 },
      weekly: { usedPercent: 42, windowEnd: null, secondsRemaining: 86400 },
      monthly: { usedPercent: 0, windowEnd: null, secondsRemaining: null },
    },
    core: {
      fiveHour: { usedPercent: 5, windowEnd: null, secondsRemaining: null },
    },
  },
  overagePreference: 'block',
  extraUsageBalanceCents: 1250,
  extraUsageAllowed: true,
};
const classes = bindQuotaClasses(
  Object.fromEntries(QUOTA_CLASS_KEYS.map((key) => [key, key])),
  'test'
);
const rawConfig = {
  'api-keys': {
    factory: [
      {
        name: 'team',
        'base-url': 'https://factory.example.test/',
        keys: [
          { 'api-key': 'fk-secret-one-abcdef', auth_index: 'idx-1' },
          { 'api-key': 'fk-secret-two-abcdef', auth_index: 'idx-2', 'excluded-models': ['*'] },
          { 'api-key': 'fk-secret-three-abcdef' },
        ],
      },
    ],
  },
};

afterEach(() => useQuotaStore.getState().clearQuotaCache());

describe('Factory billing limits parsing', () => {
  test('reads the standard pool as remaining percent with absolute or relative resets', () => {
    const quota = readFactoryQuotaResponse(JSON.stringify(limitsPayload), observedAtMs);
    expect(quota.windows).toEqual([
      {
        id: 'fiveHour',
        remainingPercent: 0,
        resetAtMs: Date.parse('2099-01-01T03:00:00Z'),
        periodHours: 5,
      },
      { id: 'weekly', remainingPercent: 58, resetAtMs: observedAtMs + 86400_000, periodHours: 168 },
      { id: 'monthly', remainingPercent: 100, resetAtMs: null, periodHours: 720 },
    ]);
    expect(quota.extraUsageAllowed).toBe(true);
    expect(quota.extraUsageBalanceCents).toBe(1250);
    expect(quota.overagePreference).toBe('block');
  });

  test('treats malformed payloads as unobserved', () => {
    const quota = readFactoryQuotaResponse('not json', observedAtMs);
    expect(quota.windows.every((window) => window.remainingPercent === null)).toBe(true);
    expect(quota.extraUsageAllowed).toBe(false);
  });

  test('resolves the limits URL from the configured base URL', () => {
    expect(resolveFactoryBillingLimitsUrl(undefined)).toBe(
      'https://api.factory.ai/api/billing/limits'
    );
    expect(resolveFactoryBillingLimitsUrl('https://factory.example.test//')).toBe(
      'https://factory.example.test/api/billing/limits'
    );
  });
});

describe('Factory quota entries from config', () => {
  test('reads v8 auth_index and builds masked, per-key entries', () => {
    const config = normalizeConfigResponse(rawConfig);
    expect(config.factoryApiKeys?.map((key) => key.authIndex)).toEqual([
      'idx-1',
      'idx-2',
      undefined,
    ]);
    const files = buildFactoryQuotaFiles(config.factoryApiKeys);
    expect(files.map((file) => file.authIndex)).toEqual(['idx-1', 'idx-2']);
    expect(JSON.stringify(files)).not.toContain('fk-secret');
    expect(files[0]).toMatchObject({
      type: 'factory',
      provider: 'factory',
      disabled: false,
      baseUrl: 'https://factory.example.test/',
    });
    expect(files[0].name.startsWith('team · ')).toBe(true);
    expect(files[1].disabled).toBe(true);
  });

  test('classifies enabled keys under the Factory tab with auth_index identities', () => {
    const files = buildFactoryQuotaFiles(normalizeConfigResponse(rawConfig).factoryApiKeys);
    const entries = classifyQuotaFiles(files);
    expect(entries.map((entry) => entry.type)).toEqual(['factory']);
    expect(buildTabCounts(entries).factory).toBe(1);
    expect(getQuotaCacheKey(files[0])).toBe(`${files[0].name}${String.fromCharCode(0)}idx-1`);
    expect(QUOTA_ADAPTERS.factory.i18nPrefix).toBe('factory_quota');
    expect(getAuthFileIcon('factory', 'dark')).toBeTruthy();
  });

  test('skips keys already listed as Factory credentials', () => {
    const configs = normalizeConfigResponse(rawConfig).factoryApiKeys;
    const listed: AuthFileItem[] = [
      { name: 'factory.json', provider: 'factory', authIndex: 'idx-1' },
    ];
    expect(buildFactoryQuotaFiles(configs, listed).map((file) => file.authIndex)).toEqual([
      'idx-2',
    ]);
  });
});

describe('Factory quota fetch and render', () => {
  test('queries billing limits through the management api-call with the key token', async () => {
    const post = spyOn(apiClient, 'post').mockResolvedValue({
      status_code: 200,
      body: JSON.stringify(limitsPayload),
    });
    try {
      const file: AuthFileItem = {
        name: 'team · fk****ef',
        provider: 'factory',
        authIndex: 'idx-1',
        baseUrl: 'https://factory.example.test',
      };
      const quota = await FACTORY_CONFIG.fetchQuota(file, i18n.t);
      expect(post).toHaveBeenCalledTimes(1);
      const [path, payload] = post.mock.calls[0] as [string, Record<string, unknown>];
      expect(path).toBe('/requests/api-call');
      expect(payload).toMatchObject({
        authIndex: 'idx-1',
        method: 'GET',
        url: 'https://factory.example.test/api/billing/limits',
      });
      expect((payload.header as Record<string, string>).Authorization).toBe('Bearer $TOKEN$');
      expect(quota.windows[0].label).toBe(i18n.t('factory_quota.fiveHour'));
    } finally {
      post.mockRestore();
    }
  });

  test('surfaces upstream failures with their status', async () => {
    const post = spyOn(apiClient, 'post').mockResolvedValue({
      status_code: 401,
      body: '{"error":"invalid key"}',
    });
    try {
      const file: AuthFileItem = { name: 'k', provider: 'factory', authIndex: 'idx-1' };
      await expect(FACTORY_CONFIG.fetchQuota(file, i18n.t)).rejects.toMatchObject({
        status: 401,
      });
    } finally {
      post.mockRestore();
    }
  });

  test('renders three meters, extra usage, and an unstarted window', () => {
    const quota: FactoryQuotaState = {
      status: 'success',
      ...readFactoryQuotaResponse(limitsPayload, observedAtMs),
    };
    const markup = renderToStaticMarkup(createElement(FactoryQuotaBody, { quota, classes }));
    expect(markup.match(/role="meter"/g)).toHaveLength(3);
    expect(markup).toContain('aria-valuenow="0"');
    expect(markup).toContain('aria-valuenow="58"');
    expect(markup).toContain(i18n.t('factory_quota.monthly'));
    expect(markup).toContain(i18n.t('factory_quota.not_started'));
    expect(markup).toContain(i18n.t('factory_quota.extra_on'));
    expect(markup).toContain('12.50');
  });

  test('participates in recovery sorting and the timeline', () => {
    const quota: FactoryQuotaState = {
      status: 'success',
      ...readFactoryQuotaResponse(limitsPayload, observedAtMs),
    };
    expect(nextRecoveryMs('factory', quota, observedAtMs)).toBe(Date.parse('2099-01-01T03:00:00Z'));
    const lane = buildTimelineLane({
      name: 'k',
      displayName: 'k',
      provider: 'factory',
      quota,
    });
    expect(lane.anchorMs).not.toBeNull();
    expect(lane.limits.length).toBe(3);
  });
});
