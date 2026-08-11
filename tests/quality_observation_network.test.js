import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { initNetworkHooks } from '../injected/network-hooks.js';
import { resetInferredFallbackState } from '../injected/rewriter.js';
import { setConfig, setRepresentations } from '../injected/state.js';

const AVATAR_540 = 'https://vod.pplus.paramount.tech/path/title_cenc_precon_dash/PPUSA_AVATAR_UHD_V1_c24_540p_4309720_2000/seg_10.m4s?CMCD=br%3D1716%2Cot%3Dv%2Ctb%3D5812';

const originalFetch = jest.fn();
const analyzeUrl = jest.fn();

beforeAll(() => {
  window.fetch = originalFetch;
  initNetworkHooks({ analyzeUrl, parseManifest: jest.fn() });
});

beforeEach(() => {
  originalFetch.mockReset();
  analyzeUrl.mockReset();
  resetInferredFallbackState();
  setRepresentations([
    {
      id: 'avatar-1080', pathId: 'PPUSA_AVATAR_UHD_V1_c20_1080p_4309720_5400',
      height: 1080, bandwidth: 5812183, family: 'dash', source: 'manifest'
    },
    {
      id: 'avatar-540', pathId: 'PPUSA_AVATAR_UHD_V1_c24_540p_4309720_2000',
      height: 540, bandwidth: 1716061, family: 'dash', source: 'manifest'
    },
    {
      id: 'avatar-234', pathId: 'PPUSA_AVATAR_UHD_V1_c28_234p_4309720_130',
      height: 234, bandwidth: 145361, family: 'dash', source: 'manifest'
    }
  ]);
  setConfig({
    forceMax: false,
    forcedId: 'avatar-234',
    forcedHeight: 234,
    enableRetries: false,
    enablePrefetch: false
  });
});

describe('Successful-response quality observations', () => {
  test('honors a height-only manual selection after a manifest ID changes', async () => {
    originalFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => 'video/mp4' } });
    setConfig({
      forceMax: false,
      forcedId: null,
      forcedHeight: 234,
      enableRetries: false,
      enablePrefetch: false
    });

    await window.fetch(AVATAR_540);

    expect(originalFetch.mock.calls[0][0]).toContain('_c28_234p_4309720_130/seg_10.m4s');
    expect(analyzeUrl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      rewritten: true,
      targetHeight: 234
    }));
  });

  test('reports Avatar 234p only after the rewritten response succeeds', async () => {
    let finishRequest;
    originalFetch.mockReturnValue(new Promise(resolve => { finishRequest = resolve; }));

    const request = window.fetch(AVATAR_540);
    expect(analyzeUrl).not.toHaveBeenCalled();

    finishRequest({ ok: true, status: 200, headers: { get: () => 'video/mp4' } });
    await request;

    expect(originalFetch.mock.calls[0][0]).toContain('_c28_234p_4309720_130/seg_10.m4s');
    expect(analyzeUrl).toHaveBeenCalledTimes(1);
    expect(analyzeUrl).toHaveBeenCalledWith(
      expect.stringContaining('_c28_234p_4309720_130/seg_10.m4s'),
      expect.objectContaining({
        rewritten: true,
        targetHeight: 234,
        targetBitrateKbps: 145,
        observationSequence: expect.any(Number)
      })
    );
  });

  test('reports the later 1080p selection with a newer observation sequence', async () => {
    originalFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => 'video/mp4' } });

    await window.fetch(AVATAR_540);
    const firstSequence = analyzeUrl.mock.calls[0][1].observationSequence;

    setConfig({
      forceMax: false,
      forcedId: 'avatar-1080',
      forcedHeight: 1080,
      enableRetries: false,
      enablePrefetch: false
    });
    await window.fetch(AVATAR_540.replace('seg_10', 'seg_11'));

    expect(analyzeUrl.mock.calls[1]).toEqual([
      expect.stringContaining('_c20_1080p_4309720_5400/seg_11.m4s'),
      expect.objectContaining({ targetHeight: 1080 })
    ]);
    expect(analyzeUrl.mock.calls[1][1].observationSequence).toBeGreaterThan(firstSequence);
  });
});
