import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { initNetworkHooks } from '../injected/network-hooks.js';
import { resetInferredFallbackState } from '../injected/rewriter.js';
import { setConfig, setRepresentations } from '../injected/state.js';

const LOW = 'https://dai.google.com/linear/hls/pa/event/UFC/stream/LIVE/variant/0219929b8f4989b82a0b9a8f58f7352a/bandwidth/635781.m3u8?CMCD=br%3D635%2Cot%3Dv%2Ctb%3D8941';
const HIGH = 'https://dai.google.com/linear/hls/pa/event/UFC/stream/LIVE/variant/51dee42484fe2a2135500e11874015a5/bandwidth/8940798.m3u8?token=signed';

const response = (ok, status) => ({
  ok,
  status,
  headers: { get: () => 'application/vnd.apple.mpegurl' },
  clone: () => ({ text: async () => '#EXTM3U' })
});

let originalFetch;
let analyzeUrl;

beforeAll(() => {
  originalFetch = jest.fn();
  analyzeUrl = jest.fn();
  window.fetch = originalFetch;
  initNetworkHooks({ analyzeUrl, parseManifest: jest.fn() });
});

beforeEach(() => {
  originalFetch.mockReset();
  analyzeUrl.mockReset();
  resetInferredFallbackState();
  setConfig({ forceMax: true, forcedId: null, enableRetries: false, enablePrefetch: false });
  setRepresentations([
    {
      id: 'hls_1',
      height: 1080,
      bandwidth: 8940798,
      family: 'google-dai-hls',
      streamKey: 'https://dai.google.com/event/UFC/stream/LIVE',
      variantUrl: HIGH,
      daiId: '51dee42484fe2a2135500e11874015a5'
    },
    {
      id: 'hls_0',
      height: 270,
      bandwidth: 635781,
      family: 'google-dai-hls',
      streamKey: 'https://dai.google.com/event/UFC/stream/LIVE',
      variantUrl: LOW,
      daiId: '0219929b8f4989b82a0b9a8f58f7352a'
    }
  ]);
});

describe('Authoritative rewrite network fallback', () => {
  test('uses the complete target DAI URL and preserves its signature plus CMCD', async () => {
    originalFetch.mockResolvedValue(response(true, 200));

    await window.fetch(LOW);

    const requested = originalFetch.mock.calls[0][0];
    expect(requested).toContain('/variant/51dee42484fe2a2135500e11874015a5/bandwidth/8940798.m3u8');
    expect(requested).toContain('token=signed');
    expect(requested).toContain('CMCD=br%3D635%2Cot%3Dv%2Ctb%3D8941');
    expect(analyzeUrl.mock.calls.map(call => call[0])).toEqual([LOW, expect.stringContaining('/bandwidth/8940798.m3u8')]);
  });

  test('falls back immediately and suppresses the rejected DAI plan for the stream', async () => {
    originalFetch
      .mockResolvedValueOnce(response(false, 404))
      .mockResolvedValue(response(true, 200));

    await window.fetch(LOW);
    await window.fetch(LOW);

    expect(originalFetch).toHaveBeenCalledTimes(3);
    expect(originalFetch.mock.calls[0][0]).toContain('/bandwidth/8940798.m3u8');
    expect(originalFetch.mock.calls[1][0]).toBe(LOW);
    expect(originalFetch.mock.calls[2][0]).toBe(LOW);
    expect(analyzeUrl.mock.calls.every(call => call[0] === LOW)).toBe(true);
  });
});
