/** @jest-environment node */
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { JSDOM } from 'jsdom';
import { createServer } from 'node:http';
import { initNetworkHooks } from '../injected/network-hooks.js';
import { parseManifest } from '../injected/manifest-parser.js';
import { getRepresentations, clearRepresentations, setConfig } from '../injected/state.js';
import { manifest, manifestUrl } from './fixtures/indexed-dash.js';
let dom;
let originalFetch;
let server;
beforeEach(() => {
  dom = new JSDOM('', { url: 'http://127.0.0.1/' });
  for (const key of ['window', 'document', 'DOMParser', 'XMLSerializer', 'XMLHttpRequest']) globalThis[key] = key === 'window' ? dom.window : dom.window[key];
  clearRepresentations(); setConfig({ forcedHeight: 1080, enableRetries: false });
  originalFetch = jest.fn(async () => {
    const response = new Response(manifest(), { headers: { 'content-type': 'application/dash+xml', 'content-length': '9000' } });
    Object.defineProperty(response, 'url', { value: manifestUrl });
    return response;
  });
  window.fetch = originalFetch;
  initNetworkHooks({ parseManifest, analyzeUrl: jest.fn() });
});
afterEach(async () => { dom.window.close(); if (server) await new Promise(resolve => server.close(resolve)); server = null; });

test('fetch filters a cloned body, retains response metadata and original ladder', async () => {
  const response = await window.fetch(manifestUrl);
  const text = await response.clone().text();
  expect(text).toContain('id="1080"'); expect(text).not.toContain('id="540"');
  expect(response.url).toBe(manifestUrl); expect(response.clone().url).toBe(manifestUrl);
  expect(response.headers.get('content-length')).toBeNull();
  expect(getRepresentations().map(rep => rep.height)).toEqual([1080, 540]);
  expect(await response.text()).toBe(text);
});

test('selected media URLs, Request headers, byte ranges and cancellation remain player-owned', async () => {
  await window.fetch(manifestUrl);
  const url = getRepresentations()[0].addressing.mediaUrl;
  const controller = new AbortController();
  const request = new Request(url, { headers: { Range: 'bytes=1000-1499' }, signal: controller.signal });
  originalFetch.mockResolvedValueOnce(new Response('index', { status: 206 }));
  await window.fetch(request);
  expect(originalFetch.mock.calls.at(-1)[0]).toBe(request);
  expect(request.headers.get('Range')).toBe('bytes=1000-1499');
  originalFetch.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
  await expect(window.fetch(request)).rejects.toMatchObject({ name: 'AbortError' });
});

test('ordinary DASH and Auto responses are not replaced', async () => {
  setConfig({});
  const original = new Response(manifest(), { headers: { 'content-type': 'application/dash+xml' } });
  originalFetch.mockResolvedValueOnce(original);
  expect(await window.fetch(manifestUrl)).toBe(original);
  setConfig({ forcedHeight: 1080 });
  const segmented = new Response('<MPD><Period><AdaptationSet contentType="video"><Representation id="x" height="1080"><SegmentTemplate media="seg_$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>');
  originalFetch.mockResolvedValueOnce(segmented);
  expect(await window.fetch(manifestUrl)).toBe(segmented);
});

test.each(['', 'text', 'document'])('native XHR %s response is filtered even for a handler installed before open', async type => {
  server = createServer((req, res) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Content-Type', 'application/dash+xml'); res.end(manifest()); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const xhr = new XMLHttpRequest();
  const read = () => type === 'document' ? new XMLSerializer().serializeToString(xhr.responseXML) : xhr.responseText;
  let first;
  const done = new Promise((resolve, reject) => {
    xhr.onreadystatechange = () => { if (xhr.readyState === 4 && xhr.status === 200) first = read(); };
    xhr.onload = () => resolve(); xhr.onerror = reject;
  });
  xhr.open('GET', `http://127.0.0.1:${server.address().port}/manifest.mpd`);
  xhr.responseType = type; xhr.send(); await done;
  expect(first).toContain('id="1080"'); expect(first).not.toContain('id="540"');
  expect(read()).toBe(first);
  expect(xhr.getResponseHeader('content-length')).toBeNull();
  expect(getRepresentations().map(rep => rep.height)).toEqual([1080, 540]);
  // Reuse must discard the old filtered view and respect Auto.
  setConfig({});
  const reused = new Promise((resolve, reject) => { xhr.onload = resolve; xhr.onerror = reject; });
  xhr.open('GET', `http://127.0.0.1:${server.address().port}/manifest.mpd`); xhr.responseType = type; xhr.send(); await reused;
  expect(read()).toContain('id="540"');
});

test('native XHR HLS still publishes its original quality ladder', async () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\nhttps://host/high.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=960x540\nhttps://host/low.m3u8\n';
  server = createServer((req, res) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); res.end(master); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const xhr = new XMLHttpRequest();
  const done = new Promise((resolve, reject) => { xhr.onload = resolve; xhr.onerror = reject; });
  xhr.open('GET', `http://127.0.0.1:${server.address().port}/master.m3u8`); xhr.send(); await done;
  expect(xhr.responseText).toBe(master);
  expect(getRepresentations().map(rep => rep.height)).toEqual([1080, 540]);
});

test('unrelated native JSON XHR keeps its original response and headers', async () => {
  server = createServer((req, res) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Content-Type', 'application/json'); res.end('{"value":42}'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const xhr = new XMLHttpRequest();
  const done = new Promise((resolve, reject) => { xhr.onload = resolve; xhr.onerror = reject; });
  xhr.open('GET', `http://127.0.0.1:${server.address().port}/data`); xhr.responseType = 'json'; xhr.send(); await done;
  expect(xhr.response).toEqual({ value: 42 });
  expect(xhr.getResponseHeader('content-type')).toBe('application/json');
  expect(() => xhr.responseText).toThrow();
});
