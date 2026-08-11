import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { initNetworkHooks } from '../injected/network-hooks.js';
import { resetInferredFallbackState } from '../injected/rewriter.js';
import { setConfig, setRepresentations } from '../injected/state.js';

const SEGMENT_URL = 'https://vod.pplus.paramount.tech/path/asset_cenc_precon_dash/PPUSA_MOVIE_UHD_V1_c24_540p_4309720_2000/seg_56.m4s?CMCD=br%3D1802%2Cot%3Dv%2Ctb%3D5812';
const LEGACY_CBS_SEGMENT_URL = 'https://vod-gcs-cedexis.cbsaavideo.com/path/asset_cenc_precon_dash/WOLF_OF_WALL_STREET_c24_540p_3054956_2000/seg_5.m4s?CMCD=br%3D1969%2Cot%3Dv%2Ctb%3D5583';
const LEGACY_CBS_PLAIN_TIER_URL = 'https://vod-gcs-cedexis.cbsaavideo.com/path/asset_cenc_precon_dash/Sleepy_Hollow_FTR_VMASTER_2725014_2100/seg_6.m4s?CMCD=br%3D2738%2Cot%3Dv%2Ctb%3D5880';
const LEGACY_CBS_PLAIN_INIT_URL = 'https://vod-gcs-cedexis.cbsaavideo.com/path/asset_cenc_precon_dash/Sleepy_Hollow_FTR_VMASTER_2725014_2100/init.m4v?CMCD=br%3D2738%2Cot%3Di';
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

  test('validates the legacy initialization tier before rewriting its media', async () => {
    originalFetch.mockResolvedValue(successResponse());

    await window.fetch(LEGACY_CBS_PLAIN_INIT_URL);
    await window.fetch(LEGACY_CBS_PLAIN_TIER_URL);

    expect(originalFetch).toHaveBeenCalledTimes(3);
    expect(originalFetch.mock.calls[0][0]).toContain('_2725014_4500/init.m4v');
    expect(originalFetch.mock.calls[1][0]).toContain('_2725014_4500/seg_1.m4s');
    expect(originalFetch.mock.calls[1][1]).toEqual({ headers: { Range: 'bytes=0-1' } });
    expect(originalFetch.mock.calls[2][0]).toContain('_2725014_4500/seg_6.m4s');
  });

  test('validates initialization and companion media on the same alternate ladder', async () => {
    const avatarInit = LEGACY_CBS_SEGMENT_URL.replace('seg_5.m4s', 'init.m4v');
    const controller = new AbortController();
    originalFetch
      .mockResolvedValueOnce(successResponse())
      .mockResolvedValueOnce({ ok: false, status: 404, headers: { get: () => 'video/mp4' } })
      .mockResolvedValueOnce(successResponse())
      .mockResolvedValueOnce(successResponse())
      .mockResolvedValue(successResponse());

    await window.fetch(avatarInit, { signal: controller.signal });
    await window.fetch(LEGACY_CBS_SEGMENT_URL);

    expect(originalFetch.mock.calls[0][0]).toContain('_c23_1080p_3054956_5400/init.m4v');
    expect(originalFetch.mock.calls[1][0]).toContain('_c23_1080p_3054956_5400/seg_1.m4s');
    expect(originalFetch.mock.calls[1][1].signal).toBe(controller.signal);
    expect(originalFetch.mock.calls[2][0]).toContain('_c20_1080p_3054956_5400/init.m4v');
    expect(originalFetch.mock.calls[3][0]).toContain('_c20_1080p_3054956_5400/seg_1.m4s');
    expect(originalFetch.mock.calls[4][0]).toContain('_c20_1080p_3054956_5400/seg_5.m4s');
  });

  test('does not mix original media after a rewritten initialization is committed', async () => {
    const failedSegment = { ok: false, status: 404, headers: { get: () => 'video/mp4' } };
    originalFetch
      .mockResolvedValueOnce(successResponse())
      .mockResolvedValueOnce(successResponse())
      .mockResolvedValueOnce(failedSegment)
      .mockResolvedValueOnce(successResponse());

    await window.fetch(LEGACY_CBS_PLAIN_INIT_URL);
    const response = await window.fetch(LEGACY_CBS_PLAIN_TIER_URL);

    expect(response).toBe(failedSegment);
    expect(originalFetch).toHaveBeenCalledTimes(3);
    expect(originalFetch.mock.calls[1][0]).toContain('_2725014_4500/seg_1.m4s');
    expect(originalFetch.mock.calls[2][0]).toContain('_2725014_4500/seg_6.m4s');

    await window.fetch(LEGACY_CBS_PLAIN_TIER_URL.replace('seg_6', 'seg_7'));
    expect(originalFetch.mock.calls[3][0]).toContain('_2725014_4500/seg_7.m4s');
  });

  test('does not splice original media after a rewritten segment is delivered', async () => {
    const successfulRewrite = successResponse();
    const failedRewrite = { ok: false, status: 404, headers: { get: () => 'video/mp4' } };
    originalFetch
      .mockResolvedValueOnce(successfulRewrite)
      .mockResolvedValueOnce(failedRewrite);

    await expect(window.fetch(SEGMENT_URL)).resolves.toBe(successfulRewrite);
    const response = await window.fetch(SEGMENT_URL.replace('seg_56', 'seg_57'));

    expect(response).toBe(failedRewrite);
    expect(originalFetch).toHaveBeenCalledTimes(2);
    expect(originalFetch.mock.calls[0][0]).toContain('_c20_1080p_4309720_5400/seg_56.m4s');
    expect(originalFetch.mock.calls[1][0]).toContain('_c20_1080p_4309720_5400/seg_57.m4s');
  });

  test('falls back to the original rendition from a bad manifest descriptor', async () => {
    setRepresentations([
      {
        id: 'bad-1080',
        rawId: 'bad-1080',
        pathId: 'BAD_MANIFEST_DIRECTORY',
        height: 1080,
        bandwidth: 5880000,
        family: 'dash',
        source: 'manifest'
      },
      {
        id: '576p',
        pathId: 'Sleepy_Hollow_FTR_VMASTER_2725014_2100',
        height: 576,
        bandwidth: 2738000,
        family: 'dash',
        source: 'manifest'
      }
    ]);
    const rejectedManifestPath = { ok: false, status: 404, headers: { get: () => 'video/mp4' } };
    const originalResponse = successResponse();
    originalFetch
      .mockResolvedValueOnce(rejectedManifestPath)
      .mockResolvedValueOnce(originalResponse);

    const response = await window.fetch(LEGACY_CBS_PLAIN_INIT_URL);

    expect(response).toBe(originalResponse);
    expect(originalFetch).toHaveBeenCalledTimes(2);
    expect(originalFetch.mock.calls[0][0]).toContain('/BAD_MANIFEST_DIRECTORY/init.m4v');
    expect(originalFetch.mock.calls[1][0]).toBe(LEGACY_CBS_PLAIN_INIT_URL);
  });

  test('validates the plain 4500 tier on the Paramount CDN', async () => {
    originalFetch.mockResolvedValue(successResponse());

    await window.fetch(PARAMOUNT_PLAIN_TIER_URL);

    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(originalFetch.mock.calls[0][0]).toContain('_917732_4500/seg_4.m4s');
  });

  test('tries the alternate ladder before falling back and then reuses it', async () => {
    originalFetch
      .mockResolvedValueOnce({ ok: false, status: 404, headers: { get: () => 'video/mp4' } })
      .mockResolvedValue(successResponse());

    await window.fetch(SEGMENT_URL);
    await window.fetch(SEGMENT_URL.replace('seg_56', 'seg_57'));

    expect(originalFetch).toHaveBeenCalledTimes(3);
    expect(originalFetch.mock.calls[0][0]).toContain('_c20_1080p_4309720_5400/seg_56.m4s');
    expect(originalFetch.mock.calls[1][0]).toContain('_c23_1080p_4309720_5400/seg_56.m4s');
    expect(originalFetch.mock.calls[2][0]).toContain('_c23_1080p_4309720_5400/seg_57.m4s');
  });

  test('uses the original rendition only after every inferred ladder is rejected', async () => {
    originalFetch
      .mockResolvedValueOnce({ ok: false, status: 404, headers: { get: () => 'video/mp4' } })
      .mockResolvedValueOnce({ ok: false, status: 404, headers: { get: () => 'video/mp4' } })
      .mockResolvedValue(successResponse());

    await window.fetch(SEGMENT_URL);
    await window.fetch(SEGMENT_URL.replace('seg_56', 'seg_57'));

    expect(originalFetch).toHaveBeenCalledTimes(4);
    expect(originalFetch.mock.calls[0][0]).toContain('_c20_1080p_4309720_5400/seg_56.m4s');
    expect(originalFetch.mock.calls[1][0]).toContain('_c23_1080p_4309720_5400/seg_56.m4s');
    expect(originalFetch.mock.calls[2][0]).toBe(SEGMENT_URL);
    expect(originalFetch.mock.calls[3][0]).toContain('_c24_540p_4309720_2000/seg_57.m4s');
  });

  test('does not turn a cancelled inferred request into a fallback request', async () => {
    const controller = new AbortController();
    const cancelled = Object.assign(new Error('request cancelled'), { name: 'AbortError' });
    originalFetch.mockRejectedValue(cancelled);

    const request = window.fetch(SEGMENT_URL, { signal: controller.signal });
    controller.abort();

    await expect(request).rejects.toBe(cancelled);
    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(originalFetch.mock.calls[0][0]).toContain('_c20_1080p_4309720_5400/seg_56.m4s');
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
