import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { consumePendingConfig, PENDING_CONFIG_KEY } from '../injected/config.js';
import { DEFAULT_CONFIG, getConfig, normalizeConfig, setConfig } from '../injected/state.js';

describe('Quality configuration bootstrap', () => {
  beforeEach(() => {
    setConfig({ forceMax: false, forcedId: null, forcedHeight: null });
  });

  test('restores and consumes the selected quality before network hooks start', () => {
    const pending = {
      forceMax: false,
      forcedId: 's0-7',
      forcedHeight: 1080,
      enableRetries: true,
      maxRetries: 3,
      enablePrefetch: true,
      prefetchCount: 5
    };
    const storage = {
      getItem: jest.fn(() => JSON.stringify(pending)),
      removeItem: jest.fn()
    };

    expect(consumePendingConfig(storage)).toEqual(pending);
    expect(getConfig()).toEqual(pending);
    expect(storage.removeItem).toHaveBeenCalledWith(PENDING_CONFIG_KEY);
  });

  test('fails open for malformed staged configuration', () => {
    const storage = {
      getItem: jest.fn(() => '{bad json'),
      removeItem: jest.fn()
    };

    expect(consumePendingConfig(storage)).toBeNull();
    expect(getConfig()).toEqual(DEFAULT_CONFIG);
  });

  test('normalizes corrupt stored network limits before requests use them', () => {
    expect(normalizeConfig({
      forceMax: true,
      forcedId: 123,
      forcedHeight: 'invalid',
      maxRetries: 0,
      prefetchCount: 99
    })).toEqual(expect.objectContaining({
      forceMax: true,
      forcedId: null,
      forcedHeight: null,
      maxRetries: 1,
      prefetchCount: 20
    }));
  });
});
