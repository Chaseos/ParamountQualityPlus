import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { initNetworkHooks } from '../injected/network-hooks.js';
import { resetInferredFallbackState } from '../injected/rewriter.js';
import { setConfig, setRepresentations } from '../injected/state.js';

const SEGMENT_URL = 'https://vod.pplus.paramount.tech/path/asset_cenc_precon_dash/PPUSA_MOVIE_UHD_V1_c24_540p_4309720_2000/seg_56.m4s?CMCD=br%3D1802%2Cot%3Dv%2Ctb%3D5812';
const LEGACY_CBS_SEGMENT_URL = 'https://vod-gcs-cedexis.cbsaavideo.com/path/asset_cenc_precon_dash/WOLF_OF_WALL_STREET_c24_540p_3054956_2000/seg_5.m4s?CMCD=br%3D1969%2Cot%3Dv%2Ctb%3D5583';
const LEGACY_CBS_PLAIN_TIER_URL = 'https://vod-gcs-cedexis.cbsaavideo.com/path/asset_cenc_precon_dash/Sleepy_Hollow_FTR_VMASTER_2725014_2100/seg_6.m4s?CMCD=br%3D2738%2Cot%3Dv%2Ctb%3D5880';
const PARAMOUNT_PLAIN_TIER_URL = 'https://vod.pplus.paramount.tech/path/asset_cenc_precon_dash/NICKELODEON_SPONGEBOBSQUAREPANTSHD_001_V1_917732_2100/seg_4.m4s?CMCD=br%3D2729%2Cot%3Dv%2Ctb%3D5698';
const successResponse = () => ({ ok: true, status: 200, headers: { get: () => 'video/mp4' } });

let originalFetch;

beforeAll(() => {
  if (typeof globalThis.Request === 'undefined') {
    globalThis.Request = class MockRequest {
      constructor(resource) {
        this.url = typeof resource === 'string' ? resource : resource.url;
      }
    };
  }
  originalFetch = jest.fn();
  window.fetch = originalFetch;
  initNetworkHooks({
    analyzeUrl: jest.fn(),
    maybeRewriteUrl: url => url,
    parseManifest: jest.fn()
  });
});

beforeEach(() => {
  originalFetch.mockReset();
  setRepresentations([]);
  setConfig({
    forceMax: true,
    forcedId: null,
    enableRetries: false,
    enablePrefetch: false
  });
  resetInferredFallbackState();
});

describe('Inferred fallback network validation', () => {
  test('validates once and then reuses the inferred path', async () => {
    originalFetch.mockResolvedValue(successResponse());

    await window.fetch(SEGMENT_URL);
    await window.fetch(SEGMENT_URL.replace('seg_56', 'seg_57'));

    expect(originalFetch).toHaveBeenCalledTimes(2);
    expect(originalFetch.mock.calls[0][0]).toContain('_c20_1080p_4309720_5400/seg_56.m4s');
    expect(originalFetch.mock.calls[1][0]).toContain('_c20_1080p_4309720_5400/seg_57.m4s');
  });

  test('validates and reuses the legacy CBS c23 path', async () => {
    originalFetch.mockResolvedValue(successResponse());

    await window.fetch(LEGACY_CBS_SEGMENT_URL);
    await window.fetch(LEGACY_CBS_SEGMENT_URL.replace('seg_5', 'seg_6'));

    expect(originalFetch).toHaveBeenCalledTimes(2);
    expect(originalFetch.mock.calls[0][0]).toContain('_c23_1080p_3054956_5400/seg_5.m4s');
    expect(originalFetch.mock.calls[1][0]).toContain('_c23_1080p_3054956_5400/seg_6.m4s');
  });

  test('validates and reuses the legacy CBS plain 4500 tier', async () => {
    originalFetch.mockResolvedValue(successResponse());

    await window.fetch(LEGACY_CBS_PLAIN_TIER_URL);
    await window.fetch(LEGACY_CBS_PLAIN_TIER_URL.replace('seg_6', 'seg_7'));

    expect(originalFetch).toHaveBeenCalledTimes(2);
    expect(originalFetch.mock.calls[0][0]).toContain('_2725014_4500/seg_6.m4s');
    expect(originalFetch.mock.calls[1][0]).toContain('_2725014_4500/seg_7.m4s');
  });

  test('validates the plain 4500 tier on the Paramount CDN', async () => {
    originalFetch.mockResolvedValue(successResponse());

    await window.fetch(PARAMOUNT_PLAIN_TIER_URL);

    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(originalFetch.mock.calls[0][0]).toContain('_917732_4500/seg_4.m4s');
  });

  test('falls back immediately and suppresses later guesses after rejection', async () => {
    originalFetch
      .mockResolvedValueOnce({ ok: false, status: 404, headers: { get: () => 'video/mp4' } })
      .mockResolvedValue(successResponse());

    await window.fetch(SEGMENT_URL);
    await window.fetch(SEGMENT_URL.replace('seg_56', 'seg_57'));

    expect(originalFetch).toHaveBeenCalledTimes(3);
    expect(originalFetch.mock.calls[0][0]).toContain('_c20_1080p_4309720_5400/seg_56.m4s');
    expect(originalFetch.mock.calls[1][0]).toBe(SEGMENT_URL);
    expect(originalFetch.mock.calls[2][0]).toContain('_c24_540p_4309720_2000/seg_57.m4s');
  });

  test('normalizes URL and Request fetch inputs when rewriting', async () => {
    originalFetch.mockResolvedValue(successResponse());

    await window.fetch(new URL(SEGMENT_URL));
    await window.fetch(new Request(SEGMENT_URL.replace('seg_56', 'seg_57')));

    expect(originalFetch.mock.calls[0][0]).toBeInstanceOf(URL);
    expect(originalFetch.mock.calls[0][0].toString()).toContain('_c20_1080p_4309720_5400/seg_56.m4s');
    expect(originalFetch.mock.calls[1][0]).toBeInstanceOf(Request);
    expect(originalFetch.mock.calls[1][0].url).toContain('_c20_1080p_4309720_5400/seg_57.m4s');
  });
});
