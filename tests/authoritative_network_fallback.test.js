/** @jest-environment node */
import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { initNetworkHooks } from '../injected/network-hooks.js';
import { resetInferredFallbackState } from '../injected/rewriter.js';
import { setConfig, setRepresentations } from '../injected/state.js';

const LOW = 'https://dai.google.com/linear/hls/pa/event/UFC/stream/LIVE/variant/0219929b8f4989b82a0b9a8f58f7352a/bandwidth/635781.m3u8?CMCD=br%3D635%2Cot%3Dv%2Ctb%3D8941';
const HIGH = 'https://dai.google.com/linear/hls/pa/event/UFC/stream/LIVE/variant/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bandwidth/8940798.m3u8?token=signed';
const OTHER_CDN = HIGH.replace('dai.google.com', 'alternate.example.test');

class RecordingXHR extends EventTarget {
  open(method, url) {
    this.url = url;
    this.headers = new Headers();
    this.sentUrl = null;
  }
  setRequestHeader(name, value) {
    if (this.sentUrl) throw new DOMException('Request already sent', 'InvalidStateError');
    this.headers.append(name, value);
  }
  send() { this.sentUrl = this.url; }
}

const response = (ok, status) => ({
  ok,
  status,
  headers: { get: () => 'application/vnd.apple.mpegurl' },
  clone: () => ({ text: async () => '#EXTM3U' })
});

let originalFetch;
let analyzeUrl;

beforeAll(() => {
  const location = new URL('https://player.example.test/');
  globalThis.navigator ??= { userAgent: 'test' };
  globalThis.window = Object.assign(new EventTarget(), { location, postMessage: jest.fn() });
  globalThis.document = Object.assign(new EventTarget(), { baseURI: location.href, querySelectorAll: () => [] });
  globalThis.XMLHttpRequest = RecordingXHR;
  originalFetch = jest.fn();
  analyzeUrl = jest.fn();
  window.fetch = originalFetch;
  window.XMLHttpRequest = RecordingXHR;
  initNetworkHooks({ analyzeUrl, parseManifest: jest.fn() });
});

afterAll(() => window.dispatchEvent(new Event('pagehide')));

beforeEach(() => {
  originalFetch.mockReset();
  analyzeUrl.mockReset();
  resetInferredFallbackState();
  setConfig({ forceMax: true, forcedId: null, enableRetries: false, enablePrefetch: false });
  setVariants(HIGH);
});

function setVariants(highUrl) {
  setRepresentations([
    {
      id: 'hls_1',
      height: 1080,
      bandwidth: 8940798,
      family: 'google-dai-hls',
      streamKey: 'https://dai.google.com/event/UFC/stream/LIVE',
      variantUrl: highUrl,
      daiId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
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
}

describe('Authoritative rewrite network fallback', () => {
  test('uses the complete target DAI URL and preserves its signature plus CMCD', async () => {
    originalFetch.mockResolvedValue(response(true, 200));

    const options = { headers: { Authorization: 'fixture' } };
    await window.fetch(LOW, options);

    const requested = originalFetch.mock.calls[0][0];
    expect(originalFetch.mock.calls[0][1]).toBe(options);
    expect(requested).toContain('/variant/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bandwidth/8940798.m3u8');
    expect(requested).toContain('token=signed');
    expect(requested).toContain('CMCD=br%3D635%2Cot%3Dv%2Ctb%3D8941');
    expect(analyzeUrl.mock.calls.map(call => call[0])).toEqual([
      expect.stringContaining('/bandwidth/8940798.m3u8')
    ]);
  });

  test.each([
    ['player headers', { headers: { Authorization: 'fixture' } }],
    ['included credentials', { credentials: 'include' }],
    ['a request body', { method: 'POST', body: 'fixture' }]
  ])('keeps a Fetch request with %s on its original origin', async (_label, options) => {
    setVariants(OTHER_CDN);
    originalFetch.mockResolvedValue(response(true, 200));

    await window.fetch(LOW, options);

    expect(originalFetch.mock.calls).toEqual([[LOW, options]]);
  });

  test('keeps headers from a Request object on its original origin', async () => {
    setVariants(OTHER_CDN);
    originalFetch.mockResolvedValue(response(true, 200));
    const request = new Request(LOW, { headers: { 'X-Playback-Token': 'fixture' } });

    await window.fetch(request);

    expect(originalFetch.mock.calls[0][0]).toBe(request);
  });

  test('keeps XHR headers added after open on the original request', () => {
    setVariants(OTHER_CDN);
    const xhr = new XMLHttpRequest();
    xhr.open('GET', LOW);
    xhr.setRequestHeader('Authorization', 'fixture');
    xhr.setRequestHeader('Range', 'bytes=0-100');
    xhr.send();

    expect(xhr.sentUrl).toBe(LOW);
    expect(xhr.headers.get('authorization')).toBe('fixture');
    expect(xhr.headers.get('range')).toBe('bytes=0-100');
  });

  test('honours XHR credentials enabled just before send', () => {
    setVariants(OTHER_CDN);
    const xhr = new XMLHttpRequest();
    xhr.open('GET', LOW);
    xhr.withCredentials = true;
    xhr.send();

    expect(xhr.sentUrl).toBe(LOW);
    expect(xhr.withCredentials).toBe(true);
  });

  test('keeps credentials passed to XHR open on the original host', () => {
    setVariants(OTHER_CDN);
    const xhr = new XMLHttpRequest();
    xhr.open('GET', LOW, true, 'fixture-user', 'fixture-password');
    xhr.send();

    expect(xhr.sentUrl).toBe(LOW);
  });

  test('still switches plain Fetch and XHR playlist requests to another CDN', async () => {
    setVariants(OTHER_CDN);
    originalFetch.mockResolvedValue(response(true, 200));
    await window.fetch(LOW);
    const xhr = new XMLHttpRequest();
    xhr.open('GET', LOW);
    xhr.send();
    expect(() => xhr.setRequestHeader('X-Late', 'fixture')).toThrow('Request already sent');

    for (const url of [originalFetch.mock.calls[0][0], xhr.sentUrl]) {
      const variant = new URL(url);
      expect(variant.host).toBe('alternate.example.test');
      expect(variant.searchParams.get('token')).toBe('signed');
      expect(variant.searchParams.has('CMCD')).toBe(false);
    }
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
