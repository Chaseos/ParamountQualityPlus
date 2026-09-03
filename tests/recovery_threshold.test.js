import { beforeAll, beforeEach, expect, jest, test } from '@jest/globals';
import { initNetworkHooks } from '../injected/network-hooks.js';
import { resetInferredFallbackState } from '../injected/rewriter.js';
import { setConfig, setRepresentations } from '../injected/state.js';

const SOURCE = 'https://host/path/SHOW_c24_540p_asset_2000';
const TARGET = 'https://host/path/SHOW_c20_1080p_asset_5400';
const response = (ok, status) => ({ ok, status, headers: { get: () => 'video/mp4' } });

let originalFetch;

beforeAll(() => {
  originalFetch = jest.fn();
  window.fetch = originalFetch;
  initNetworkHooks({ analyzeUrl: jest.fn(), parseManifest: jest.fn() });
});

beforeEach(() => {
  originalFetch.mockReset();
  resetInferredFallbackState();
  setConfig({ forceMax: true, forcedId: null, forcedHeight: null, enableRetries: false, enablePrefetch: false });
  setRepresentations([
    {
      id: '1080p', pathId: 'SHOW_c20_1080p_asset_5400', height: 1080,
      family: 'dash', streamKey: 'show', compatibilityKey: 'dash:show:avc'
    },
    {
      id: '540p', pathId: 'SHOW_c24_540p_asset_2000', height: 540,
      family: 'dash', streamKey: 'show', compatibilityKey: 'dash:show:avc'
    }
  ]);
});

test('defers Auto recovery until a committed stream fails repeatedly', async () => {
  const postMessage = jest.spyOn(window, 'postMessage').mockImplementation(() => {});
  originalFetch
    .mockResolvedValueOnce(response(true, 200))
    .mockResolvedValueOnce(response(false, 503))
    .mockResolvedValueOnce(response(true, 200))
    .mockResolvedValueOnce(response(false, 503))
    .mockResolvedValueOnce(response(false, 503));

  try {
    await window.fetch(`${SOURCE}/init.m4v?CMCD=ot%3Di`);
    await window.fetch(`${SOURCE}/seg_1.m4s?CMCD=ot%3Dv`);
    expect(postMessage.mock.calls.some(([message]) => message?.type === 'PQI_ORIGINAL_STREAM_RECOVERY')).toBe(false);

    await window.fetch(`${SOURCE}/seg_2.m4s?CMCD=ot%3Dv`);
    await window.fetch(`${SOURCE}/seg_3.m4s?CMCD=ot%3Dv`);
    expect(postMessage.mock.calls.some(([message]) => message?.type === 'PQI_ORIGINAL_STREAM_RECOVERY')).toBe(false);

    await window.fetch(`${SOURCE}/seg_4.m4s?CMCD=ot%3Dv`);
    expect(postMessage.mock.calls.filter(([message]) => message?.type === 'PQI_ORIGINAL_STREAM_RECOVERY')).toHaveLength(1);
    expect(originalFetch.mock.calls).toHaveLength(5);
    expect(originalFetch.mock.calls.every(([url]) => url.includes(TARGET))).toBe(true);
  } finally {
    postMessage.mockRestore();
  }
});
