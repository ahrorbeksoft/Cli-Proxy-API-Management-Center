import { useEffect, useMemo } from 'react';
import { factoryAccountLabel } from '@/services/api/factoryAccount';
import { useFactoryAccountStore } from '@/stores/useFactoryAccountStore';
import type { ProviderKeyConfig } from '@/types';
import { normalizeAuthIndex } from '@/utils/authIndex';

/** Resolve display labels for configured Factory keys, keyed by auth index. */
export function useFactoryAccountLabels(
  configs: readonly ProviderKeyConfig[] | undefined,
  enabled = true
): Record<string, string> {
  const accounts = useFactoryAccountStore((state) => state.accounts);
  const ensureAccounts = useFactoryAccountStore((state) => state.ensureAccounts);

  const targets = useMemo(
    () =>
      (configs ?? []).flatMap((config) => {
        const authIndex = normalizeAuthIndex(config.authIndex);
        return authIndex ? [{ authIndex, baseUrl: config.baseUrl }] : [];
      }),
    [configs]
  );

  useEffect(() => {
    if (enabled && targets.length) ensureAccounts(targets);
  }, [enabled, ensureAccounts, targets]);

  return useMemo(() => {
    const labels: Record<string, string> = {};
    for (const [authIndex, entry] of Object.entries(accounts)) {
      const label = entry.status === 'success' ? factoryAccountLabel(entry.account) : null;
      if (label) labels[authIndex] = label;
    }
    return labels;
  }, [accounts]);
}
