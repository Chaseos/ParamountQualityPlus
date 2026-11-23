import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { restorePlaybackPosition, savePlaybackPosition } from '../injected/position-handoff.js';

const KEY = 'pqiIndexedResume';
const path = '/movies/video/example/';

function addVideo(state) {
  const video = document.createElement('video');
  const values = { videoHeight: 540, currentTime: 0, duration: 3000, paused: false, readyState: 2, ...state };
  for (const [name, value] of Object.entries(values)) Object.defineProperty(video, name, { value, writable: true, configurable: true });
  video.play = jest.fn(() => Promise.resolve());
  video.pause = jest.fn();
  document.body.appendChild(video);
  return video;
}
const emit = (video, type) => video.dispatchEvent(new Event(type));
const stage = saved => window.sessionStorage.setItem(KEY, JSON.stringify({ path, time: 71, duration: 3000, paused: false, savedAt: Date.now(), ...saved }));

beforeEach(() => {
  window.history.replaceState({}, '', path);
  window.sessionStorage.clear();
  document.body.replaceChildren();
});
afterEach(() => { jest.useRealTimers(); });

test('saves the program video and never an ad the page player reports', () => {
  addVideo({ currentTime: 12, duration: 30, player: { isAd: true } });
  expect(savePlaybackPosition()).toBe(false);
  expect(window.sessionStorage.getItem(KEY)).toBeNull();
  addVideo({ currentTime: 71, paused: true, player: { isAd: false } });
  expect(savePlaybackPosition()).toBe(true);
  expect(JSON.parse(window.sessionStorage.getItem(KEY))).toMatchObject({ path, time: 71, duration: 3000, paused: true });
});

test('a video without a frame or duration, or blocked storage, saves nothing', () => {
  addVideo({ videoHeight: 0 });
  addVideo({ duration: NaN });
  expect(savePlaybackPosition()).toBe(false);
  addVideo({ currentTime: 5 });
  const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(savePlaybackPosition()).toBe(false);
  setItem.mockRestore();
});

test.each([true, false])('restores the playhead once on the matching program with paused=%s', paused => {
  stage({ paused });
  restorePlaybackPosition();
  expect(window.sessionStorage.getItem(KEY)).toBeNull();
  const ad = addVideo({ duration: 30, player: { isAd: true } });
  emit(ad, 'loadedmetadata');
  expect(ad.currentTime).toBe(0);
  const video = addVideo({ player: { isAd: false } });
  emit(video, 'loadedmetadata');
  expect(video.currentTime).toBe(71);
  expect(paused ? video.pause : video.play).toHaveBeenCalledTimes(1);
  video.currentTime = 80; emit(video, 'canplay');
  expect(video.currentTime).toBe(80);
});

test('a stream that opens with an ad is restored when its program starts playing', () => {
  stage();
  restorePlaybackPosition();
  const video = addVideo({ player: { isAd: true } });
  emit(video, 'loadedmetadata'); emit(video, 'canplay'); emit(video, 'timeupdate');
  expect(video.currentTime).toBe(0);
  video.player.isAd = false;
  emit(video, 'timeupdate');
  expect(video.currentTime).toBe(71);
});

test('another episode, stale data and a video of another duration are ignored', () => {
  const video = addVideo();
  stage({ path: '/different/episode/' });
  restorePlaybackPosition();
  emit(video, 'loadedmetadata');
  expect(video.currentTime).toBe(0);

  stage({ savedAt: Date.now() - 121000 });
  restorePlaybackPosition();
  emit(video, 'loadedmetadata');
  expect(video.currentTime).toBe(0);

  stage();
  restorePlaybackPosition();
  const other = addVideo({ duration: 2400 });
  emit(other, 'loadedmetadata');
  expect(other.currentTime).toBe(0);
  emit(video, 'loadedmetadata');
  expect(video.currentTime).toBe(71);
});

test('the restore stops listening once its window has passed', () => {
  jest.useFakeTimers();
  stage();
  restorePlaybackPosition();
  const video = addVideo({ player: { isAd: true } });
  emit(video, 'timeupdate');
  jest.setSystemTime(Date.now() + 121000);
  video.player.isAd = false;
  emit(video, 'timeupdate');
  expect(video.currentTime).toBe(0);
});
