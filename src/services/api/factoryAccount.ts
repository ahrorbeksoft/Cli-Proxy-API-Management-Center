import { apiCallApi, getApiCallErrorMessage } from './apiCall';
import { FACTORY_DEFAULT_BASE_URL, FACTORY_REQUEST_HEADERS } from './factoryQuota';

export const FACTORY_WHOAMI_PATH = '/api/cli/whoami';
export const FACTORY_MEMBERS_PATH = '/api/organization/members';
export const FACTORY_ORGANIZATION_PATH = '/api/organization';
// Large organizations page their member list; the caller is usually found on the first page.
const MAX_MEMBER_PAGES = 5;

export interface FactoryAccount {
  email: string | null;
  orgName: string | null;
}

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

export function resolveFactoryAccountUrl(baseUrl: unknown, path: string): string {
  const base =
    typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim() : FACTORY_DEFAULT_BASE_URL;
  return `${base.replace(/\/+$/, '')}${path}`;
}

/** GET /api/cli/whoami identifies the key's user but carries no email. */
export const readFactoryUserId = (payload: unknown): string | null =>
  readString(asRecord(payload).userId);

/** Find the key owner's email in one page of GET /api/organization/members. */
export function readFactoryMemberPage(
  payload: unknown,
  userId: string
): { email: string | null; nextCursor: string | null } {
  const root = asRecord(payload);
  const members = Array.isArray(root.members) ? root.members : [];
  const member = members.map(asRecord).find((entry) => readString(entry.id) === userId);
  const pagination = asRecord(root.pagination);
  return {
    email: member ? readString(member.email) : null,
    nextCursor: pagination.hasMore === true ? readString(pagination.nextCursor) : null,
  };
}

export const readFactoryOrganizationName = (payload: unknown): string | null => {
  const organization = asRecord(asRecord(payload).organization);
  return readString(organization.name) ?? readString(organization.fullName);
};

export const factoryAccountLabel = (account: FactoryAccount | null | undefined): string | null =>
  account?.email ?? account?.orgName ?? null;

const getFactoryJson = async (authIndex: string, url: string): Promise<unknown> => {
  const result = await apiCallApi.request({
    authIndex,
    method: 'GET',
    url,
    header: { ...FACTORY_REQUEST_HEADERS },
  });
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(getApiCallErrorMessage(result));
  }
  return result.body ?? result.bodyText;
};

/**
 * Resolve the account behind a configured Factory key through the management api-call proxy,
 * so the raw key never reaches the browser. Member listing may be restricted to admins, in
 * which case the organization name is the best available label.
 */
export async function fetchFactoryAccount(
  authIndex: string,
  baseUrl?: string | null
): Promise<FactoryAccount> {
  const userId = readFactoryUserId(
    await getFactoryJson(authIndex, resolveFactoryAccountUrl(baseUrl, FACTORY_WHOAMI_PATH))
  );
  if (userId) {
    try {
      let cursor: string | null = null;
      for (let page = 0; page < MAX_MEMBER_PAGES; page += 1) {
        const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
        const result = readFactoryMemberPage(
          await getFactoryJson(
            authIndex,
            resolveFactoryAccountUrl(baseUrl, FACTORY_MEMBERS_PATH) + query
          ),
          userId
        );
        if (result.email) return { email: result.email, orgName: null };
        if (!result.nextCursor || result.nextCursor === cursor) break;
        cursor = result.nextCursor;
      }
    } catch {
      // Fall through to the organization name.
    }
  }
  const orgName = readFactoryOrganizationName(
    await getFactoryJson(authIndex, resolveFactoryAccountUrl(baseUrl, FACTORY_ORGANIZATION_PATH))
  );
  return { email: null, orgName };
}
