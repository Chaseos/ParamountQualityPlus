import { beforeEach, expect, test } from '@jest/globals';
import { createQualityMonitor } from '../injected/quality-monitor.js';
let monitor;
const sample = (seconds, extra = {}) => monitor.sample({ eligible: true, video: 'video', now: seconds * 1000,
  currentTime: seconds, bufferedEnd: 10, decodedHeight: 540, playbackRate: 1, ...extra });
const observe = (seconds, height = 540, extra = {}) => monitor.observe({ epoch: monitor.capture(), startedAt: seconds * 1000,
  completedAt: seconds * 1000, sequence: seconds, requestKey: `segment-${seconds}`, height, url: 'https://cdn/segment', ...extra });
const run = (end = 30, extra = {}, retrieved = 540) => {
  let result;
  for (let seconds = 2; seconds <= end; seconds += 2) { observe(seconds, retrieved); result = sample(seconds, extra); }
  return result;
};
beforeEach(() => { monitor = createQualityMonitor(); monitor.configure('episode|1080', 1080); sample(0); });

test('requires thirty seconds and three distinct successful requests', () => {
  expect(run(28).status).toBe('insufficient-evidence');
  observe(30); expect(sample(30).status).toBe('retrieval-mismatch');
});
test('buffer boundary is fixed despite newly buffered media', () => {
  monitor.interrupt(); sample(0, { bufferedEnd: 50 });
  expect(run(50, { bufferedEnd: 1000 }).status).toBe('insufficient-evidence');
  observe(52); expect(sample(52, { bufferedEnd: 2000 }).status).toBe('retrieval-mismatch');
});
test('selected retrieval with wrong decoding is a decode mismatch', () => expect(run(30, {}, 1080).status).toBe('decode-mismatch'));
test('mixed retrieval observations are inconclusive', () => {
  run(28); observe(30, 1080); expect(sample(30).status).toBe('insufficient-evidence');
});
test('stale network observations cannot confirm a mismatch', () => {
  observe(2); sample(2); observe(4); sample(4); observe(6); sample(6);
  for (let s = 8; s <= 30; s += 2) sample(s);
  expect(monitor.snapshot().status).toBe('insufficient-evidence');
});
test('retries of the same media identity do not count as three distinct media requests', () => {
  for (let s = 2; s <= 30; s += 2) { observe(s, 540, { requestKey: 'same-segment' }); sample(s); }
  expect(monitor.snapshot().observations).toHaveLength(1);
  expect(monitor.snapshot().status).toBe('insufficient-evidence');
});
test('drops out-of-order, pre-window and prior-selection completions', () => {
  observe(10); observe(8); observe(12, 540, { startedAt: -1 }); observe(14, 540, { epoch: -1 });
  expect(monitor.snapshot().observations).toHaveLength(1);
});
test.each([1064, 1072, 1088, 1096])('padding height %i is inconclusive', height => expect(run(30, { decodedHeight: height }).status).toBe('insufficient-evidence'));
test('manual downgrade mismatches are detected too', () => {
  monitor.configure('episode|540', 540); sample(0, { decodedHeight: 1080 });
  expect(run(30, { decodedHeight: 1080 }, 1080).status).toBe('retrieval-mismatch');
});
test('three eligible matching samples confirm recovery with one transition', () => {
  run(30); expect(sample(32, { decodedHeight: 1080 }).status).toBe('insufficient-evidence');
  sample(34, { decodedHeight: 1080 });
  expect(sample(36, { decodedHeight: 1080 })).toMatchObject({ status: 'matched', changed: true });
  expect(sample(38, { decodedHeight: 1080 })).toMatchObject({ status: 'matched', changed: false });
});
test('brief decoded mismatch after matching playback starts a new persistence interval', () => {
  run(28, { decodedHeight: 1080 }); observe(30); expect(sample(30).status).toBe('insufficient-evidence');
});
test.each(['pause', 'stall', 'seek', 'ad', 'unknown-ad', 'hidden'])('%s interrupts the evidence window', () => {
  run(28); sample(29, { eligible: false }); observe(30); sample(30, { bufferedEnd: 35 });
  expect(monitor.snapshot().observations).toHaveLength(0);
  expect(sample(32).status).toBe('insufficient-evidence');
});
test('video replacement, stalled playhead, scheduler gaps and seeks discard evidence', () => {
  run(28); sample(30, { video: 'replacement', bufferedEnd: 40 });
  expect(monitor.snapshot().observations).toHaveLength(0);
  sample(32, { video: 'replacement', currentTime: 30 }); expect(monitor.snapshot().bufferBoundary).toBeNull();
  sample(34, { bufferedEnd: 40 }); sample(44, { bufferedEnd: 50 }); expect(monitor.snapshot().bufferBoundary).toBeNull();
  sample(46, { bufferedEnd: 50 }); sample(48, { currentTime: 100 }); expect(monitor.snapshot().bufferBoundary).toBeNull();
});
test('duplicate effective selection does not reset time or ordering', () => {
  run(28); const epoch = monitor.capture(); expect(monitor.configure('episode|1080', 1080)).toBe(false);
  expect(monitor.capture()).toBe(epoch); observe(30); expect(sample(30).status).toBe('retrieval-mismatch');
});
test('Auto, unknown target, new episode and new selection clear prior evidence', () => {
  run(28); monitor.configure('auto', null); expect(run(30).status).toBe('insufficient-evidence');
  monitor.configure('new-episode|1080', 1080); expect(monitor.snapshot().observations).toHaveLength(0);
});


test('interruptions invalidate even completions with the same timestamp as the new window', () => {
  const epoch = monitor.capture(); monitor.interrupt(); sample(0);
  observe(2, 540, { epoch }); expect(monitor.snapshot().observations).toHaveLength(0);
});
