import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { createQualityWatch, resolveRetrievedQuality, sampleProgramVideo } from '../injected/quality-watch.js';
const root = 'https://vod.pplus.paramount.tech/title/package_cenc_precon_dash/';
const url = n => `${root}TITLE_c24_540p_asset_2000/seg_${n}.m4s`;
const target = n => `${root}TITLE_c20_1080p_asset_5400/seg_${n}.m4s`;
let watch, config, reps, discovery, record, video, clock, sample, seq;
const normal = { action: 'authoritative-rewrite', strategy: 'dash' };
const advance = async (count = 17, retrieved = 540, planned = n => url(n)) => {
  for (let i = 0; i < count; i++) {
    await jest.advanceTimersByTimeAsync(2000);
    const n = ++seq;
    const token = watch.capture(url(n), n);
    watch.success(token, retrieved === 1080 ? target(n) : url(n), { plannedUrl: planned(n), strategy: 'dash' });
  }
};
beforeEach(() => {
  jest.useFakeTimers(); clock = () => Date.now(); seq = 0;
  config = { forcedHeight: 1080 }; reps = [{ id: 'chosen', height: 1080 }]; record = jest.fn(); video = {};
  const start = clock();
  sample = jest.fn(() => ({ eligible: true, video, currentTime: (clock() - start) / 1000,
    bufferedEnd: (clock() - start) / 1000 + 4, decodedHeight: 540 }));
  discovery = { capture: jest.fn(() => 1), observe: jest.fn(), status: jest.fn(() => 'validated'),
    plan: jest.fn((value) => ({ ...normal, url: value.replace('c24_540p_asset_2000', 'c20_1080p_asset_5400'), strategy: 'package-manifest' })) };
  watch = createQualityWatch({ discovery, getConfig: () => config, getRepresentations: () => reps, record, now: clock, samplePlayback: sample });
  watch.capture(url(0), 0);
});
afterEach(() => { watch.reset(); jest.useRealTimers(); });

test('persistent mismatch authorizes one correction despite ordinary planner success', async () => {
  await advance(); expect(discovery.observe).toHaveBeenCalledTimes(1);
  expect(watch.override(url(20), normal, true)?.strategy).toBe('package-manifest');
  expect(watch.override(url(21), normal, true)?.strategy).toBe('package-manifest');
  expect(record.mock.calls.filter(call => call[1].outcome === 'fallback-activated')).toHaveLength(1);
  await advance(20); expect(discovery.observe).toHaveBeenCalledTimes(1);
  expect(record.mock.calls.some(call => call[1].reason === 'correction-already-attempted')).toBe(true);
});
test('does not retry an identical ineffective source/target mapping', async () => {
  await advance(17, 540, target); expect(discovery.observe).toHaveBeenCalledTimes(1);
  expect(watch.override(url(20), normal, true)).toBeNull();
  expect(record.mock.calls.some(call => call[1].reason === 'identical-ineffective-mapping')).toBe(true);
});
test('decode mismatch reports without triggering discovery', async () => {
  await advance(17, 1080, target);
  expect(discovery.observe).not.toHaveBeenCalled();
  expect(record.mock.calls.some(call => call[1].outcome === 'decode-mismatch')).toBe(true);
});
test('a failed or incompatible discovery produces unresolved diagnostics', async () => {
  await advance(); discovery.plan.mockReturnValue(null); discovery.status.mockReturnValue('rejected');
  expect(watch.override(url(20), normal, true)).toBeNull();
  expect(record.mock.calls.some(call => call[1].reason === 'no-compatible-correction')).toBe(true);
});
test('later authoritative manifest clears override but retains activation budget', async () => {
  await advance(); expect(watch.override(url(20), normal, true)).not.toBeNull();
  watch.authoritativeReceived(); expect(watch.override(url(21), normal, true)).toBeNull();
  await advance(); expect(discovery.observe).toHaveBeenCalledTimes(1);
});
test('same effective target reconciliation keeps evidence while Auto stops it', async () => {
  await advance(10); config = { forcedId: 'chosen', forcedHeight: 1080 }; await advance(7);
  expect(discovery.observe).toHaveBeenCalledTimes(1);
  config = {}; expect(watch.override(url(22), normal, true)).toBeNull();
  const count = sample.mock.calls.length; await jest.advanceTimersByTimeAsync(6000); expect(sample).toHaveBeenCalledTimes(count);
});
test('Force Highest uses the existing resolved target; unknown IDs suspend monitoring', async () => {
  config = { forceMax: true }; await advance(); expect(discovery.observe).toHaveBeenCalledTimes(1);
  watch.reset(); config = { forcedId: 'unknown' }; watch.capture(url(0), 0); await advance();
  expect(discovery.observe).toHaveBeenCalledTimes(1);
});
test('range-disallowed and unrelated packages cannot receive an override', async () => {
  await advance(); expect(watch.override(url(20), normal, false)).toBeNull();
  expect(watch.override(url(20).replace('package_', 'other_'), normal, true)).toBeNull();
});
test('final response evidence ignores target claims and rejects init/audio/live/unknown observations', () => {
  expect(resolveRetrievedQuality(url(1), reps)?.height).toBe(540);
  expect(resolveRetrievedQuality(target(1), reps)?.height).toBe(1080);
  for (const value of [undefined, url(1).replace('seg_1.m4s', 'init.m4v'), url(1) + '?CMCD=ot%3Da', url(1) + '?CMCD=st%3Dl', 'https://host/video.mp4']) {
    expect(resolveRetrievedQuality(value, reps)).toBeNull();
  }
  expect(resolveRetrievedQuality(url(1), reps, 'bytes=0-100')).toBeNull();
});
test('single-file init/index requests do not count as video evidence', () => {
  const single = url(1).replace('_cenc_precon_dash', '_cenc_fmp4_dash').replace('/seg_1.m4s', '.mp4');
  const ladder = [{ height: 540, addressing: { mediaUrl: single, indexRange: '100-199', initializationRange: '0-99' } }];
  expect(resolveRetrievedQuality(single, ladder, 'bytes=0-99')).toBeNull();
  expect(resolveRetrievedQuality(single, ladder, 'bytes=100-199')).toBeNull();
  expect(resolveRetrievedQuality(single, ladder, 'bytes=200-500')?.height).toBe(540);
});
test('sampler requires visible, unambiguous, positively non-ad advancing-capable video', () => {
  const element = document.createElement('video'); document.body.append(element);
  element.getBoundingClientRect = () => ({ width: 960, height: 540, top: 0, left: 0, bottom: 540, right: 960 });
  for (const [name, value] of Object.entries({ videoHeight: 540, readyState: 4, paused: false, duration: 100 })) Object.defineProperty(element, name, { configurable: true, value });
  const doc = { visibilityState: 'visible', querySelectorAll: () => [element] };
  expect(sampleProgramVideo(doc).eligible).toBe(false);
  element.player = { isAd: false }; expect(sampleProgramVideo(doc).eligible).toBe(true);
  element.player.isAd = true; expect(sampleProgramVideo(doc).eligible).toBe(false);
  element.player.isAd = false; doc.visibilityState = 'hidden'; expect(sampleProgramVideo(doc).eligible).toBe(false);
  doc.visibilityState = 'visible'; doc.querySelectorAll = () => [element, element]; expect(sampleProgramVideo(doc).eligible).toBe(false);
  element.remove();
});


test('failed corrective requests report unresolved once without reloading or retrying discovery', async () => {
  await advance(); const token = watch.capture(url(20), 20);
  watch.override(url(20), normal, true); watch.failure(token, 404); watch.failure(token, 404);
  expect(record.mock.calls.filter(call => call[1].reason === 'corrective-request-failed')).toHaveLength(1);
  expect(discovery.observe).toHaveBeenCalledTimes(1);
});
