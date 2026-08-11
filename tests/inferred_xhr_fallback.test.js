import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { initNetworkHooks } from '../injected/network-hooks.js';
import { resetInferredFallbackState } from '../injected/rewriter.js';
import { setConfig, setRepresentations } from '../injected/state.js';

const SEGMENT_URL = 'https://vod.pplus.paramount.tech/path/asset_cenc_precon_dash/PPUSA_MOVIE_UHD_V1_c24_540p_4309720_2000/seg_56.m4s?CMCD=br%3D1802%2Cot%3Dv%2Ctb%3D5812';
const INIT_URL = 'https://vod-gcs-cedexis.cbsaavideo.com/path/asset_cenc_precon_dash/Sleepy_Hollow_FTR_VMASTER_2725014_2100/init.m4v?CMCD=br%3D2738%2Cot%3Di';
const SLEEPY_SEGMENT_URL = 'https://vod-gcs-cedexis.cbsaavideo.com/path/asset_cenc_precon_dash/Sleepy_Hollow_FTR_VMASTER_2725014_2100/seg_6.m4s?CMCD=br%3D2738%2Cot%3Dv%2Ctb%3D5880';

class MockXMLHttpRequest extends EventTarget {
  constructor() {
    super();
    this.openCalls = [];
    this.readyState = 0;
    this.responseText = '';
  }

  open(method, url, ...rest) {
    this.openCalls.push([method, url, ...rest]);
  }

  send() {}

  getResponseHeader() {
    return null;
  }
}

const probeFetch = jest.fn();
const parseManifest = jest.fn();
const analyzeUrl = jest.fn();

beforeAll(() => {
  window.fetch = probeFetch;
  window.XMLHttpRequest = MockXMLHttpRequest;
  globalThis.XMLHttpRequest = MockXMLHttpRequest;
  initNetworkHooks({
    analyzeUrl,
    maybeRewriteUrl: url => url,
    parseManifest
  });
});

beforeEach(() => {
  probeFetch.mockReset();
  parseManifest.mockReset();
  analyzeUrl.mockReset();
  setRepresentations([]);
  setConfig({ forceMax: true, forcedId: null, enablePrefetch: false });
  resetInferredFallbackState();
});

describe('Inferred XHR fallback validation', () => {
  test('keeps the current request original and rewrites later segments after validation', async () => {
    probeFetch.mockResolvedValue({ ok: true, status: 206 });

    const first = new XMLHttpRequest();
    first.open('GET', SEGMENT_URL);
    expect(first.openCalls[0][1]).toBe(SEGMENT_URL);

    await Promise.resolve();
    await Promise.resolve();

    const second = new XMLHttpRequest();
    second.open('GET', SEGMENT_URL.replace('seg_56', 'seg_57'));

    expect(probeFetch).toHaveBeenCalledTimes(1);
    expect(probeFetch.mock.calls[0][0]).toContain('_c20_1080p_4309720_5400/seg_56.m4s');
    expect(probeFetch.mock.calls[0][1]).toEqual({ headers: { Range: 'bytes=0-1' } });
    expect(second.openCalls[0][1]).toContain('_c20_1080p_4309720_5400/seg_57.m4s');

    const rewrittenUrl = second.openCalls[0][1];
    expect(analyzeUrl).not.toHaveBeenCalled();

    second.status = 206;
    second.readyState = 4;
    second.dispatchEvent(new Event('readystatechange'));
    expect(analyzeUrl).toHaveBeenLastCalledWith(rewrittenUrl, expect.objectContaining({
      rewritten: true,
      observationSequence: expect.any(Number)
    }));
  });

  test('probes only once and keeps later segments original after rejection', async () => {
    probeFetch.mockResolvedValue({ ok: false, status: 404 });

    const first = new XMLHttpRequest();
    first.open('GET', SEGMENT_URL);
    await Promise.resolve();
    await Promise.resolve();

    const secondUrl = SEGMENT_URL.replace('seg_56', 'seg_57');
    const second = new XMLHttpRequest();
    second.open('GET', secondUrl);

    expect(probeFetch).toHaveBeenCalledTimes(1);
    expect(second.openCalls[0][1]).toBe(secondUrl);
  });

  test('keeps initialization and media together when XHR cannot await an inferred probe', () => {
    const initialization = new XMLHttpRequest();
    initialization.open('GET', INIT_URL);

    const segment = new XMLHttpRequest();
    segment.open('GET', SLEEPY_SEGMENT_URL);

    expect(initialization.openCalls[0][1]).toBe(INIT_URL);
    expect(segment.openCalls[0][1]).toBe(SLEEPY_SEGMENT_URL);
    expect(probeFetch).not.toHaveBeenCalled();
  });

  test('parses XHR manifests before listeners registered after open', () => {
    const callOrder = [];
    parseManifest.mockImplementation(() => callOrder.push('parser'));

    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://host/manifest.mpd');
    xhr.addEventListener('readystatechange', () => {
      if (xhr.readyState === 4) callOrder.push('player');
    });

    xhr.responseText = '<MPD></MPD>';
    xhr.readyState = 4;
    xhr.dispatchEvent(new Event('readystatechange'));

    expect(parseManifest).toHaveBeenCalledWith('<MPD></MPD>', 'https://host/manifest.mpd');
    expect(callOrder).toEqual(['parser', 'player']);
  });
});
