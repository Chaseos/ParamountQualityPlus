/** @jest-environment node */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { initNetworkHooks } from '../injected/network-hooks.js';
import { parseManifest, readDashRepresentations } from '../injected/manifest-parser.js';
import { clearRepresentations, setRepresentations, setConfig, getConfig } from '../injected/state.js';
import { resetInferredFallbackState } from '../injected/inferred-vod.js';
import { getDiagnosticSnapshot, resetDiagnostics } from '../injected/diagnostics.js';
const text = readFileSync(new URL('./fixtures/lioness-segmented-captured.mpd', import.meta.url), 'utf8');
const root = 'https://vod.pplus.paramount.tech/intl_vms/2026/06/10/ALVE01KTSC0QNME2JAKFQW7D3XQN8X/4388933_cenc_precon_dash/';
const source = n => root + `PARPUS_LIONESS_302_V1_c24_540p_4342061_2000/seg_${n}.m4s`;
const targetDirectory = 'PARPUS_LIONESS_302_V1_c20_1080p_4342061_5400';
const staleDirectory = 'PARPUS_LIONESS_302_V1_c21_1080p_4342061_5400';
let dom, fetch, decoded, startedAt;
const makeResponse = (body, url, status = 200) => {
  const response = new Response(body, { status }); Object.defineProperty(response, 'url', { value: url }); return response;
};
beforeEach(() => {
  jest.useFakeTimers(); startedAt = Date.now();
  dom = new JSDOM('', { url: 'https://www.paramountplus.com/shows/video/episode/' });
  for (const key of ['window', 'document', 'DOMParser', 'XMLSerializer']) globalThis[key] = key === 'window' ? dom.window : dom.window[key];
  Object.defineProperty(document, 'visibilityState', { value: 'visible' });
  const video = document.createElement('video'); document.body.append(video); video.player = { isAd: false };
  video.getBoundingClientRect = () => ({ width: 960, height: 540, top: 0, left: 0, bottom: 540, right: 960 }); decoded = 540;
  for (const [name, value] of Object.entries({ readyState: 4, paused: false, duration: 3600 })) Object.defineProperty(video, name, { value });
  Object.defineProperty(video, 'videoHeight', { get: () => decoded });
  Object.defineProperty(video, 'currentTime', { get: () => (Date.now() - startedAt) / 1000 });
  Object.defineProperty(video, 'buffered', { get: () => ({ length: 1, start: () => 0, end: () => video.currentTime + 4 }) });
  class XHR extends dom.window.EventTarget {
    constructor() { super(); this.status = 0; this.readyState = 0; this.responseURL = ''; }
    open(method, url) { this.url = url; this.readyState = 1; }
    setRequestHeader() {}
    getResponseHeader() { return null; }
    send() { this.status = 200; this.readyState = 4; this.responseURL = this.url.replace(staleDirectory, 'PARPUS_LIONESS_302_V1_c24_540p_4342061_2000'); this.dispatchEvent(new dom.window.Event('readystatechange')); }
  }
  globalThis.XMLHttpRequest = window.XMLHttpRequest = XHR;
  fetch = jest.fn(async resource => {
    const url = typeof resource === 'string' ? resource : resource.url;
    if (url.endsWith('/stream.mpd')) return makeResponse(text, url);
    return makeResponse('media', url.replace(staleDirectory, 'PARPUS_LIONESS_302_V1_c24_540p_4342061_2000'));
  });
  window.fetch = fetch; window.postMessage = jest.fn();
  clearRepresentations(); resetInferredFallbackState(); resetDiagnostics();
  const ladder = readDashRepresentations(text, root + 'stream.mpd');
  setRepresentations(JSON.parse(JSON.stringify(ladder).replaceAll(targetDirectory, staleDirectory)));
  setConfig({ forcedHeight: 1080, enableRetries: false, enablePrefetch: false });
  initNetworkHooks({ parseManifest, analyzeUrl: jest.fn() });
});
afterEach(() => { window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close(); jest.useRealTimers(); });
const run = async transport => {
  for (let n = 140; n <= 158; n++) {
    if (transport === 'fetch') await window.fetch(source(n));
    else { const xhr = new XMLHttpRequest(); xhr.open('GET', source(n)); xhr.send(); }
    await jest.advanceTimersByTimeAsync(2000);
  }
};
const events = () => getDiagnosticSnapshot().recentEvents.filter(event => event.type === 'quality_monitor').map(event => event.detail);

test.each(['fetch', 'xhr'])('%s detects final-URL mismatch and activates a different validated mapping once', async transport => {
  const before = getConfig(); await run(transport);
  expect(fetch.mock.calls.filter(call => String(call[0]).endsWith('/stream.mpd'))).toHaveLength(1);
  expect(events().some(event => event.outcome === 'retrieval-mismatch')).toBe(true);
  expect(events().filter(event => event.outcome === 'fallback-activated')).toHaveLength(1);
  const result = await window.fetch(source(160));
  expect(result.url).toContain(targetDirectory);
  decoded = 1080; await jest.advanceTimersByTimeAsync(8000);
  expect(events().some(event => event.outcome === 'matched')).toBe(true);
  expect(getConfig()).toEqual(before); expect(window.postMessage).not.toHaveBeenCalled();
});

test('seeking restarts the window and Auto stops corrective mapping', async () => {
  await run('fetch');
  document.querySelector('video').dispatchEvent(new dom.window.Event('seeking', { bubbles: true }));
  setConfig({ enablePrefetch: false });
  expect((await window.fetch(source(170))).url).toBe(source(170));
  expect(window.postMessage).not.toHaveBeenCalled();
});

test('cancellation and absent final URL never become evidence', async () => {
  fetch.mockImplementation(async () => { throw new DOMException('cancelled', 'AbortError'); });
  for (let n = 140; n < 160; n++) { await expect(window.fetch(source(n))).rejects.toMatchObject({ name: 'AbortError' }); await jest.advanceTimersByTimeAsync(2000); }
  expect(events().some(event => event.outcome === 'retrieval-mismatch')).toBe(false);
  expect(window.postMessage).not.toHaveBeenCalled();
});
