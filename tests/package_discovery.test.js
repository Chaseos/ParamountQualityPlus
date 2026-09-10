/** @jest-environment node */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { createPackageDiscovery, needsPackageDiscovery } from '../injected/package-discovery.js';
import { recordAuthoritativeRewriteResult, resetInferredFallbackState } from '../injected/inferred-vod.js';
const text = readFileSync(new URL('./fixtures/lioness-segmented-captured.mpd', import.meta.url), 'utf8');
const root = 'https://vod.pplus.paramount.tech/intl_vms/2026/06/10/ALVE01KTSC0QNME2JAKFQW7D3XQN8X/4388933_cenc_precon_dash/';
const url = root + 'PARPUS_LIONESS_302_V1_c24_540p_4342061_2000/seg_140.m4s';
let dom, discovery, fetch, record, page;
const response = (body = text, options = {}) => {
  const value = new Response(body, options);
  Object.defineProperty(value, 'url', { value: root + 'stream.mpd' });
  return value;
};
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
beforeEach(() => {
  dom = new JSDOM('', { url: 'https://www.paramountplus.com/shows/video/episode/' });
  globalThis.window = dom.window; globalThis.DOMParser = dom.window.DOMParser;
  page = '/episode'; fetch = jest.fn(async () => response()); record = jest.fn();
  resetInferredFallbackState();
  discovery = createPackageDiscovery({ fetch, record, getPage: () => page });
});
afterEach(() => { discovery.reset(); dom.window.close(); jest.useRealTimers(); });

test('one background request per package with no source credentials or query', async () => {
  const token = discovery.capture();
  discovery.observe(url + '?token=secret', token); discovery.observe(url, token);
  await flush();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(root + 'stream.mpd', { credentials: 'omit', redirect: 'error', signal: expect.any(AbortSignal) });
  expect(discovery.plan(url, { forcedHeight: 1080 }, [])).toMatchObject({ strategy: 'package-manifest', targetHeight: 1080 });
  expect(JSON.stringify(record.mock.calls)).not.toContain('secret');
});

test.each([404, 403, 500])('negative caches HTTP %i', async status => {
  fetch.mockResolvedValue(response('', { status }));
  discovery.observe(url, discovery.capture()); await flush();
  discovery.observe(url, discovery.capture()); await flush();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(discovery.plan(url, { forceMax: true }, [])).toBeNull();
});

test('timeout aborts pending work without retries', async () => {
  jest.useFakeTimers(); fetch.mockImplementation(() => new Promise(() => {}));
  discovery.observe(url, discovery.capture());
  await jest.advanceTimersByTimeAsync(5000);
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(record).toHaveBeenLastCalledWith('package_manifest_discovery', expect.objectContaining({ reason: 'timeout' }));
  discovery.observe(url, discovery.capture()); expect(fetch).toHaveBeenCalledTimes(1);
});

test.each(['header', 'body'])('enforces two-MiB %s limit', async kind => {
  fetch.mockResolvedValue(kind === 'header' ? response('', { headers: { 'content-length': String(2097153) } }) : response('x'.repeat(2097153)));
  discovery.observe(url, discovery.capture()); await flush();
  expect(record).toHaveBeenLastCalledWith('package_manifest_discovery', expect.objectContaining({ reason: 'manifest-too-large' }));
  expect(discovery.plan(url, { forceMax: true }, [])).toBeNull();
});

test('redirected or mismatched response URL is rejected', async () => {
  const res = new Response(text); Object.defineProperty(res, 'url', { value: 'https://other.example/stream.mpd' });
  fetch.mockResolvedValue(res); discovery.observe(url, discovery.capture()); await flush();
  expect(discovery.plan(url, { forceMax: true }, [])).toBeNull();
});

test.each(['page', 'authoritative', 'reset'])('%s change aborts and discards late response', async change => {
  let resolve; fetch.mockImplementation(() => new Promise(done => { resolve = done; }));
  const token = discovery.capture(); discovery.observe(url, token);
  if (change === 'page') { page = '/another-episode'; discovery.capture(); }
  else if (change === 'authoritative') discovery.authoritativeReceived();
  else discovery.reset();
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  resolve(response()); await flush();
  expect(discovery.plan(url, { forceMax: true }, [])).toBeNull();
  discovery.observe(url, token); expect(fetch).toHaveBeenCalledTimes(1);
});

test('later authoritative manifest removes cached supplemental mapping', async () => {
  discovery.observe(url, discovery.capture()); await flush();
  expect(discovery.plan(url, { forceMax: true }, [])).not.toBeNull();
  discovery.authoritativeReceived();
  expect(discovery.plan(url, { forceMax: true }, [])).toBeNull();
  discovery.observe(url, discovery.capture()); expect(fetch).toHaveBeenCalledTimes(1);
});

test('rejected targets use existing session recovery state', async () => {
  discovery.observe(url, discovery.capture()); await flush();
  const plan = discovery.plan(url, { forcedHeight: 1080 }, []);
  recordAuthoritativeRewriteResult(plan, false);
  expect(discovery.plan(url, { forcedHeight: 1080 }, [])).toBeNull();
});

test('Auto, working mappings and already-target plans do not qualify', () => {
  expect(needsPackageDiscovery({ action: 'pass-through', reason: 'no-representation' }, {})).toBe(false);
  expect(needsPackageDiscovery({ action: 'authoritative-rewrite' }, { forceMax: true })).toBe(false);
  expect(needsPackageDiscovery({ action: 'pass-through', reason: 'already-target' }, { forcedHeight: 1080 })).toBe(false);
  expect(needsPackageDiscovery({ action: 'pass-through', reason: 'no-compatible-representation' }, { forcedHeight: 1080 })).toBe(true);
});
