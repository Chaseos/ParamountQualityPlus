/** @jest-environment node */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { initNetworkHooks } from '../injected/network-hooks.js';
import { parseManifest } from '../injected/manifest-parser.js';
import { clearRepresentations, getRepresentations, setConfig } from '../injected/state.js';
import { resetInferredFallbackState } from '../injected/inferred-vod.js';
const text = readFileSync(new URL('./fixtures/lioness-segmented-captured.mpd', import.meta.url), 'utf8');
const root = 'https://vod.pplus.paramount.tech/intl_vms/2026/06/10/ALVE01KTSC0QNME2JAKFQW7D3XQN8X/4388933_cenc_precon_dash/';
const url = root + 'PARPUS_LIONESS_302_V1_c24_540p_4342061_2000/seg_140.m4s';
const target = url.replace('c24_540p_4342061_2000', 'c20_1080p_4342061_5400');
let dom, originalFetch, complete;
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const response = (body, url, status = 200) => {
  const result = new Response(body, { status }); Object.defineProperty(result, 'url', { value: url }); return result;
};
beforeEach(() => {
  dom = new JSDOM('', { url: 'https://www.paramountplus.com/shows/video/episode/' });
  for (const key of ['window', 'document', 'DOMParser', 'XMLSerializer']) globalThis[key] = key === 'window' ? dom.window : dom.window[key];
  class XHR extends dom.window.EventTarget {
    constructor() { super(); this.readyState = 0; this.status = 0; this.openCalls = []; this.headers = []; }
    open(...args) { this.openCalls.push(args); this.readyState = 1; this.headers = []; }
    setRequestHeader(...args) { this.headers.push(args); }
    getResponseHeader() { return null; }
    send() { complete(this); }
  }
  globalThis.XMLHttpRequest = window.XMLHttpRequest = XHR;
  complete = xhr => { xhr.status = 200; xhr.responseURL = xhr.openCalls.at(-1)[1]; xhr.readyState = 4; xhr.dispatchEvent(new dom.window.Event('readystatechange')); };
  originalFetch = jest.fn(async resource => {
    const path = typeof resource === 'string' ? resource : resource.url;
    return response(path.endsWith('.mpd') ? text : 'media', path);
  });
  window.fetch = originalFetch; window.postMessage = jest.fn();
  clearRepresentations(); resetInferredFallbackState();
  setConfig({ forcedHeight: 1080, enableRetries: false, enablePrefetch: false });
  initNetworkHooks({ parseManifest, analyzeUrl: jest.fn() });
});
afterEach(() => { window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close(); });

test('fetch keeps first response immediate, discovers without publishing, then uses declared target', async () => {
  const first = await window.fetch(url);
  expect(first.url).toBe(url); await flush();
  expect(originalFetch.mock.calls.map(call => call[0])).toEqual([url, root + 'stream.mpd']);
  expect(getRepresentations()).toEqual([]);
  expect(window.postMessage).not.toHaveBeenCalled();
  expect((await window.fetch(url)).url).toBe(target);
  expect(window.postMessage).not.toHaveBeenCalled();
});

test('fetch Request byte ranges bypass discovered target and preserve cancellation', async () => {
  await window.fetch(url); await flush();
  const controller = new AbortController();
  const request = new Request(url, { headers: { Range: 'bytes=1-20' }, signal: controller.signal });
  await window.fetch(request);
  expect(originalFetch.mock.calls.at(-1)[0]).toBe(request);
  originalFetch.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));
  await expect(window.fetch(request)).rejects.toMatchObject({ name: 'AbortError' });
  expect(window.postMessage).not.toHaveBeenCalled();
});

test('Auto does not probe and immediately stops using discovered targets', async () => {
  setConfig({ enablePrefetch: false });
  await window.fetch(url); await flush(); expect(originalFetch).toHaveBeenCalledTimes(1);
  setConfig({ forcedHeight: 1080, enableRetries: false, enablePrefetch: false });
  await window.fetch(url); await flush(); expect((await window.fetch(url)).url).toBe(target);
  setConfig({ enablePrefetch: false }); expect((await window.fetch(url)).url).toBe(url);
});

test('working player manifest takes precedence and does not trigger discovery', async () => {
  await window.fetch(root + 'stream.mpd');
  const ladder = getRepresentations();
  await window.fetch(url); await flush();
  expect(originalFetch.mock.calls.filter(call => String(call[0]).endsWith('stream.mpd'))).toHaveLength(1);
  expect(getRepresentations()).toBe(ladder);
});

test('fetch and XHR share one probe and XHR uses later discovered mapping', async () => {
  await window.fetch(url);
  const first = new XMLHttpRequest(); first.open('GET', url); first.send(); await flush();
  expect(originalFetch.mock.calls.filter(call => String(call[0]).endsWith('stream.mpd'))).toHaveLength(1);
  const next = new XMLHttpRequest(); next.open('GET', url);
  expect(next.openCalls.at(-1)[1]).toBe(target);
  next.send(); expect(getRepresentations()).toEqual([]);
});

test('XHR alone observes successful media without blocking its response', async () => {
  const first = new XMLHttpRequest(); first.open('GET', url); first.send();
  expect(first.status).toBe(200); expect(first.openCalls[0][1]).toBe(url);
  await flush();
  const second = new XMLHttpRequest(); second.open('GET', url); expect(second.openCalls[0][1]).toBe(target);
});

test('XHR range header restores original URL and preserves prior headers and response settings', async () => {
  await window.fetch(url); await flush();
  const xhr = new XMLHttpRequest(); xhr.open('GET', url, true); xhr.responseType = 'arraybuffer'; xhr.withCredentials = true; xhr.timeout = 7000;
  xhr.setRequestHeader('X-Test', 'preserved'); xhr.setRequestHeader('Range', 'bytes=1-20');
  expect(xhr.openCalls.at(-1)).toEqual(['GET', url, true]);
  expect(xhr.headers).toEqual([['X-Test', 'preserved'], ['Range', 'bytes=1-20']]);
  expect(xhr.responseType).toBe('arraybuffer'); expect(xhr.withCredentials).toBe(true); expect(xhr.timeout).toBe(7000);
  xhr.send(); expect(xhr._pqi_rewritePlan).toBeNull();
});

test('uncommitted target failure returns original and rejects that target', async () => {
  await window.fetch(url); await flush();
  originalFetch.mockImplementation(async path => response('', path, path === target ? 404 : 200));
  expect((await window.fetch(url)).url).toBe(url);
  originalFetch.mockClear(); expect((await window.fetch(url)).url).toBe(url);
  expect(originalFetch).toHaveBeenCalledTimes(1);
});

test('committed target failures use existing once-only original-stream recovery', async () => {
  await window.fetch(url); await flush(); await window.fetch(url);
  originalFetch.mockImplementation(async path => response('', path, path === target ? 500 : 200));
  await window.fetch(url); await window.fetch(url); await window.fetch(url);
  expect(window.postMessage.mock.calls.filter(call => call[0].type === 'PQI_ORIGINAL_STREAM_RECOVERY')).toHaveLength(1);
});

test('aborted and failed XHR observations do not probe', async () => {
  complete = xhr => { xhr.status = 0; xhr.readyState = 4; xhr.dispatchEvent(new dom.window.Event('readystatechange')); };
  const xhr = new XMLHttpRequest(); xhr.open('GET', url); xhr.send(); await flush();
  expect(originalFetch).not.toHaveBeenCalled();
});


test('single-file discovery never publishes a ladder, rewrites a range, or requests reload', async () => {
  const indexedText = readFileSync(new URL('./fixtures/lioness-single-file-captured.mpd', import.meta.url), 'utf8');
  const indexedUrl = url.replace('4388933_cenc_precon_dash', '4389134_cenc_fmp4_dash').replace('/seg_140.m4s', '.mp4');
  originalFetch.mockImplementation(async resource => {
    const path = typeof resource === 'string' ? resource : resource.url;
    return response(path.endsWith('.mpd') ? indexedText : 'bytes', path);
  });
  const request = new Request(indexedUrl, { headers: { Range: 'bytes=0-1638' } });
  await window.fetch(request); await flush(); await window.fetch(request);
  expect(originalFetch.mock.calls.at(-1)[0]).toBe(request);
  expect(originalFetch.mock.calls.filter(call => String(call[0]).endsWith('stream.mpd'))).toHaveLength(1);
  expect(getRepresentations()).toEqual([]); expect(window.postMessage).not.toHaveBeenCalled();
});

test.each(['ad', 'malformed'].flatMap(kind => ['fetch', 'xhr'].map(transport => [kind, transport])))('%s %s manifest does not discard a validated fallback', async (kind, transport) => {
  await window.fetch(url); await flush();
  const manifestUrl = kind === 'ad' ? 'https://pubads.g.doubleclick.net/ad/stream.mpd' : root + 'invalid.mpd';
  originalFetch.mockImplementation(async path => response(path === manifestUrl ? (kind === 'ad' ? '<MPD><Period id="ad"/></MPD>' : '<MPD><broken>') : 'media', path));
  if (transport === 'fetch') await window.fetch(manifestUrl);
  else {
    complete = xhr => {
      xhr.status = 200; xhr.responseURL = manifestUrl;
      xhr.responseText = kind === 'ad' ? '<MPD><Period id="ad"/></MPD>' : '<MPD><broken>';
      xhr.readyState = 4; xhr.dispatchEvent(new dom.window.Event('readystatechange'));
    };
    const xhr = new XMLHttpRequest(); xhr.open('GET', manifestUrl); xhr.send();
  }
  expect((await window.fetch(url)).url).toBe(target);
 });
 test.each(['fetch', 'xhr'])('%s redirected media cannot authorize source-package discovery', async transport => {
  const finalUrl = url.replace('4388933', '9999999');
  if (transport === 'fetch') {
    originalFetch.mockImplementation(async path => response(path.endsWith('.mpd') ? text : 'media', path === url ? finalUrl : path));
    await window.fetch(url);
  } else {
    complete = xhr => { xhr.status = 200; xhr.responseURL = finalUrl; xhr.readyState = 4; xhr.dispatchEvent(new dom.window.Event('readystatechange')); };
    const xhr = new XMLHttpRequest(); xhr.open('GET', url); xhr.send();
  }
  await flush();
  expect(originalFetch.mock.calls.filter(call => String(call[0]).endsWith('stream.mpd'))).toHaveLength(0);
 });
