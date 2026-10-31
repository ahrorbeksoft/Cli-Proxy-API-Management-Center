import { describe, expect, test } from 'bun:test';
import { factoryToResource } from '../src/features/providers/adapters';
import { PROVIDER_LOGOS } from '../src/features/providers/brandLogos';
import { PROVIDER_BRAND_ORDER, PROVIDER_DESCRIPTORS } from '../src/features/providers/descriptors';
import { MODEL_DISCOVERY_BRANDS } from '../src/features/providers/sheets/forms/useModelDiscovery';
import { buildProviderGroups } from '../src/features/providers/useProviderWorkbench';
import { getProviderKeyCounts } from '../src/features/dashboard/hooks/useDashboardOverview';
import { normalizeConfigResponse } from '../src/services/api/transformers';
import { readProviderGroups } from '../src/services/api/providers';
import { ROUTING_KEY_FAMILIES } from '../src/types/routing';

describe('Factory Droid API key provider', () => {
  test('normalizes the backend contract and exposes a dedicated workbench resource', () => {
    const raw = {
      'api-keys': {
        factory: [
          {
            name: 'factory-1',
            'base-url': 'https://api.factory.ai',
            keys: [
              {
                'api-key': 'fk-secret',
                priority: 5,
                weight: 2,
                prefix: 'droid',
                'proxy-url': 'socks5://proxy.example:1080',
                headers: { 'X-Custom': 'value' },
                models: [{ name: 'claude-opus-4-8', alias: 'opus' }],
                'excluded-models': ['gpt-5'],
                'disable-cooling': true,
                'auth-index': 'factory:apikey:1',
              },
            ],
          },
        ],
      },
    };
    const config = normalizeConfigResponse(raw);

    expect(config.factoryApiKeys).toMatchObject([
      {
        apiKey: 'fk-secret',
        priority: 5,
        weight: 2,
        prefix: 'droid',
        baseUrl: 'https://api.factory.ai',
        proxyUrl: 'socks5://proxy.example:1080',
        headers: { 'X-Custom': 'value' },
        models: [{ name: 'claude-opus-4-8', alias: 'opus' }],
        excludedModels: ['gpt-5'],
        disableCooling: true,
        authIndex: 'factory:apikey:1',
      },
    ]);
    expect(readProviderGroups(raw, 'factory')).toHaveLength(1);

    const resource = factoryToResource(config.factoryApiKeys![0], 0);
    expect(resource.brand).toBe('factory');
    expect(resource.baseUrl).toBe('https://api.factory.ai');
    expect(resource.models).toEqual(['claude-opus-4-8']);
    expect(resource.selector).toEqual({
      brand: 'factory',
      apiKey: 'fk-secret',
      baseUrl: 'https://api.factory.ai',
      index: 0,
    });
    expect(
      buildProviderGroups(config).find((group) => group.id === 'factory')?.resources
    ).toHaveLength(1);
    expect(getProviderKeyCounts(config).factory).toBe(1);
  });

  test('declares API-key-only capabilities without discovery or connectivity tests', () => {
    const descriptor = PROVIDER_DESCRIPTORS.factory;
    expect(descriptor.supportsApiKey).toBe(true);
    expect(descriptor.baseUrlRequired).toBe(false);
    expect(descriptor.supportsWebsockets).toBe(false);
    expect(descriptor.supportsCloak).toBe(false);
    expect(descriptor.supportsTestModel).toBe(false);
    expect(MODEL_DISCOVERY_BRANDS).not.toContain('factory');
    expect(PROVIDER_BRAND_ORDER.indexOf('factory')).toBe(PROVIDER_BRAND_ORDER.indexOf('meta') + 1);
    expect(PROVIDER_LOGOS.factory.src).toBeTruthy();
    expect(ROUTING_KEY_FAMILIES).toContain('factory');
  });
});
