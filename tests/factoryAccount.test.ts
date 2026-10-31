import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { AuthFileItem } from '@/types';
import { apiClient } from '@/services/api/client';
import {
  factoryAccountLabel,
  fetchFactoryAccount,
  readFactoryMemberPage,
  readFactoryOrganizationName,
  readFactoryUserId,
} from '@/services/api/factoryAccount';
import { useFactoryAccountStore } from '@/stores/useFactoryAccountStore';
import { withAccountLabels } from '@/features/providers/adapters';
import type { ProviderGroup, ProviderResource } from '@/features/providers/types';
import { withFactoryAccountLabels } from '@/features/quota/providers/factory/data';
import { getQuotaCacheKey, getQuotaDisplayName } from '@/utils/quota/identity';

type ApiCallPayload = { authIndex: string; url: string; header: Record<string, string> };

const mockApiCall = (respond: (url: string) => { status_code: number; body: unknown }) =>
  spyOn(apiClient, 'post').mockImplementation((async (_path: string, payload: unknown) => {
    const { url } = payload as ApiCallPayload;
    const { status_code, body } = respond(url);
    return { status_code, body: JSON.stringify(body) };
  }) as never);

afterEach(() => useFactoryAccountStore.getState().clearCache());

describe('Factory account payload parsing', () => {
  test('reads the whoami user, member pages, and organization name', () => {
    expect(readFactoryUserId({ userId: ' user-1 ', orgId: 'org-1' })).toBe('user-1');
    expect(readFactoryUserId('{"orgId":"org-1"}')).toBeNull();

    const page = {
      members: [
        { id: 'user-0', email: 'other@example.test' },
        { id: 'user-1', email: 'owner@example.test' },
      ],
      pagination: { nextCursor: 'c2', hasMore: true, total: 3 },
    };
    expect(readFactoryMemberPage(page, 'user-1')).toEqual({
      email: 'owner@example.test',
      nextCursor: 'c2',
    });
    expect(readFactoryMemberPage({ ...page, pagination: { hasMore: false } }, 'nobody')).toEqual({
      email: null,
      nextCursor: null,
    });

    expect(readFactoryOrganizationName({ organization: { name: 'Acme' } })).toBe('Acme');
    expect(readFactoryOrganizationName({ organization: { fullName: 'Acme Inc' } })).toBe(
      'Acme Inc'
    );
    expect(factoryAccountLabel({ email: 'a@example.test', orgName: 'Acme' })).toBe(
      'a@example.test'
    );
    expect(factoryAccountLabel({ email: null, orgName: 'Acme' })).toBe('Acme');
    expect(factoryAccountLabel(null)).toBeNull();
  });
});

describe('Factory account lookup', () => {
  test('matches the key owner across member pages through the api-call proxy', async () => {
    const post = mockApiCall((url) => {
      if (url.endsWith('/api/cli/whoami')) return { status_code: 200, body: { userId: 'user-2' } };
      if (url.endsWith('/api/organization/members')) {
        return {
          status_code: 200,
          body: {
            members: [{ id: 'user-1', email: 'first@example.test' }],
            pagination: { nextCursor: 'page 2', hasMore: true },
          },
        };
      }
      if (url.endsWith('/api/organization/members?cursor=page%202')) {
        return {
          status_code: 200,
          body: {
            members: [{ id: 'user-2', email: 'owner@example.test' }],
            pagination: { nextCursor: null, hasMore: false },
          },
        };
      }
      return { status_code: 404, body: {} };
    });
    try {
      const account = await fetchFactoryAccount('idx-1', 'https://factory.example.test/');
      expect(account).toEqual({ email: 'owner@example.test', orgName: null });
      const calls = post.mock.calls.map((call) => call[1] as ApiCallPayload);
      expect(calls.map((call) => call.url)).toEqual([
        'https://factory.example.test/api/cli/whoami',
        'https://factory.example.test/api/organization/members',
        'https://factory.example.test/api/organization/members?cursor=page%202',
      ]);
      expect(calls.every((call) => call.authIndex === 'idx-1')).toBe(true);
      expect(calls.every((call) => call.header.Authorization === 'Bearer $TOKEN$')).toBe(true);
    } finally {
      post.mockRestore();
    }
  });

  test('falls back to the organization name when members are not visible', async () => {
    const post = mockApiCall((url) => {
      if (url.endsWith('/api/cli/whoami')) return { status_code: 200, body: { userId: 'user-1' } };
      if (url.endsWith('/api/organization')) {
        return { status_code: 200, body: { organization: { name: 'Acme' } } };
      }
      return { status_code: 403, body: { error: 'forbidden' } };
    });
    try {
      expect(await fetchFactoryAccount('idx-1')).toEqual({ email: null, orgName: 'Acme' });
      expect((post.mock.calls[0][1] as ApiCallPayload).url).toBe(
        'https://api.factory.ai/api/cli/whoami'
      );
    } finally {
      post.mockRestore();
    }
  });

  test('drops answers that arrive after the session cache was cleared', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const post = spyOn(apiClient, 'post').mockImplementation((async () => {
      await gate;
      return { status_code: 200, body: JSON.stringify({ userId: 'user-1' }) };
    }) as never);
    try {
      const store = useFactoryAccountStore.getState();
      store.ensureAccounts([{ authIndex: 'idx-1' }, { authIndex: 'idx-1' }]);
      expect(useFactoryAccountStore.getState().accounts).toEqual({
        'idx-1': { status: 'loading', baseUrl: null },
      });
      store.clearCache();
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(useFactoryAccountStore.getState().accounts).toEqual({});
    } finally {
      post.mockRestore();
    }
  });

  test('refetches when the base URL changes and keeps only the latest answer', async () => {
    const post = mockApiCall((url) =>
      url.endsWith('/api/cli/whoami')
        ? { status_code: 200, body: { userId: 'user-1' } }
        : url.endsWith('/api/organization/members')
          ? {
              status_code: 200,
              body: { members: [{ id: 'user-1', email: `owner@${new URL(url).host}` }] },
            }
          : { status_code: 404, body: {} }
    );
    try {
      const store = useFactoryAccountStore.getState();
      store.ensureAccounts([{ authIndex: 'idx-1', baseUrl: 'https://old.example.test' }]);
      store.ensureAccounts([{ authIndex: 'idx-1', baseUrl: 'https://old.example.test' }]);
      store.ensureAccounts([{ authIndex: 'idx-1', baseUrl: 'https://new.example.test' }]);
      for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      expect(useFactoryAccountStore.getState().accounts['idx-1']).toEqual({
        status: 'success',
        baseUrl: 'https://new.example.test',
        account: { email: 'owner@new.example.test', orgName: null },
      });
      // Two lookups (old + new base URL), two calls each; the duplicate request was skipped.
      expect(post).toHaveBeenCalledTimes(4);
    } finally {
      post.mockRestore();
    }
  });
});

describe('Factory account labels in the UI models', () => {
  const resource = (brand: ProviderResource['brand'], authIndex: string | null) =>
    ({ id: `${brand}-${authIndex}`, brand, authIndex }) as ProviderResource;

  test('labels only the requested brand by auth index', () => {
    const groups: ProviderGroup[] = [
      { id: 'factory', resources: [resource('factory', ' idx-1 '), resource('factory', null)] },
      { id: 'codex', resources: [resource('codex', 'idx-1')] },
    ];
    const labeled = withAccountLabels(groups, 'factory', { 'idx-1': 'owner@example.test' });
    expect(labeled[0].resources.map((r) => r.accountLabel)).toEqual([
      'owner@example.test',
      undefined,
    ]);
    expect(labeled[1]).toBe(groups[1]);
    expect(withAccountLabels(groups, 'factory', {})).toBe(groups);
  });

  test('shows the email on Factory quota cards without changing their identity', () => {
    const files: AuthFileItem[] = [
      { name: 'factory-1 · fk-a...bcde', type: 'factory', provider: 'factory', authIndex: 'idx-1' },
      { name: 'codex.json', type: 'codex', authIndex: 'idx-1' },
    ];
    const labeled = withFactoryAccountLabels(files, { 'idx-1': 'owner@example.test' });
    expect(labeled[0].email).toBe('owner@example.test');
    expect(labeled[1]).toBe(files[1]);
    expect(getQuotaCacheKey(labeled[0])).toBe(getQuotaCacheKey(files[0]));
    expect(getQuotaDisplayName(labeled[0])).toBe('owner@example.test');
    expect(getQuotaDisplayName(files[0])).toBe('factory-1 · fk-a...bcde');
    expect(withFactoryAccountLabels(files, {})).toBe(files);
    expect(withFactoryAccountLabels(labeled, { 'idx-1': 'owner@example.test' })).toBe(labeled);
  });
});
