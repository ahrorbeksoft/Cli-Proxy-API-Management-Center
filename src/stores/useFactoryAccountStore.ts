/**
 * Factory account labels (email, else organization name) keyed by auth index.
 * Auth indexes are stable hashes of the credential, so a label never moves to another key.
 */

import { create } from 'zustand';
import { fetchFactoryAccount, type FactoryAccount } from '@/services/api/factoryAccount';

export type FactoryAccountEntry = { baseUrl: string | null } & (
  | { status: 'loading' }
  | { status: 'success'; account: FactoryAccount }
  | { status: 'error'; failedAt: number }
);

export interface FactoryAccountTarget {
  authIndex: string;
  baseUrl?: string | null;
}

interface FactoryAccountState {
  accounts: Record<string, FactoryAccountEntry>;
  ensureAccounts: (targets: readonly FactoryAccountTarget[]) => void;
  clearCache: () => void;
}

// A transient upstream failure must not pin the fallback label for the whole session.
const ERROR_RETRY_MS = 60_000;

let accountGeneration = 0;
let requestSeq = 0;
// Latest request per auth index; an older answer (e.g. before a base URL edit) is dropped.
const latestRequest = new Map<string, number>();

const needsFetch = (
  entry: FactoryAccountEntry | undefined,
  baseUrl: string | null,
  now: number
): boolean =>
  !entry ||
  entry.baseUrl !== baseUrl ||
  (entry.status === 'error' && now - entry.failedAt >= ERROR_RETRY_MS);

export const useFactoryAccountStore = create<FactoryAccountState>((set, get) => ({
  accounts: {},

  ensureAccounts: (targets) => {
    const generation = accountGeneration;
    const now = Date.now();
    const pending = new Map<string, string | null>();
    for (const { authIndex, baseUrl } of targets) {
      const normalizedBaseUrl = baseUrl?.trim() || null;
      if (authIndex && needsFetch(get().accounts[authIndex], normalizedBaseUrl, now)) {
        pending.set(authIndex, normalizedBaseUrl);
      }
    }
    if (!pending.size) return;
    set((state) => ({
      accounts: {
        ...state.accounts,
        ...Object.fromEntries(
          [...pending].map(([authIndex, baseUrl]) => [authIndex, { status: 'loading', baseUrl }])
        ),
      },
    }));
    for (const [authIndex, baseUrl] of pending) {
      const requestId = ++requestSeq;
      latestRequest.set(authIndex, requestId);
      fetchFactoryAccount(authIndex, baseUrl)
        .then((account): FactoryAccountEntry => ({ status: 'success', account, baseUrl }))
        .catch((): FactoryAccountEntry => ({ status: 'error', failedAt: Date.now(), baseUrl }))
        .then((entry) => {
          // A logout or connection switch bumps the generation; stale answers are dropped.
          if (generation !== accountGeneration || latestRequest.get(authIndex) !== requestId) {
            return;
          }
          set((state) => ({ accounts: { ...state.accounts, [authIndex]: entry } }));
        });
    }
  },

  clearCache: () => {
    accountGeneration += 1;
    latestRequest.clear();
    set({ accounts: {} });
  },
}));
