import { expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const contentSource = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const backgroundSource = readFileSync(new URL('../background.js', import.meta.url), 'utf8');

function loadContent({ background = { service_worker: 'background.js' } } = {}) {
  const listeners = [];
  const videos = [];
  let tick = null;
  const clearInterval = jest.fn();
  const sendMessage = jest.fn();
  const window = {
    location: { pathname: '/movies/video/avatar/' },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener: (type, listener) => listeners.push(listener),
    postMessage() {}
  };
  const chrome = {
    runtime: {
      id: 'extension', getManifest: () => ({ background }), getURL: value => value, sendMessage,
      onMessage: { addListener() {} }
    },
    storage: { sync: { get: (_keys, callback) => callback({}) }, onChanged: { addListener() {} } }
  };
  vm.runInContext(contentSource, vm.createContext({
    window, chrome, console: { info() {}, warn() {} }, clearInterval,
    setInterval: callback => { tick = callback; return 7; },
    document: {
      addEventListener() {}, createElement: () => ({ remove() {} }), head: { appendChild() {} },
      querySelector: () => null, querySelectorAll: () => videos
    }
  }));
  const startStream = () => listeners.forEach(listener => listener({
    source: window, data: { type: 'PARAMOUNT_QUALITY_DATA', payload: { bitrate: 5800 } }
  }));
  return { window, chrome, videos, sendMessage, clearInterval, startStream, tick: () => tick?.(), started: () => Boolean(tick) };
}

const playing = height => ({ videoHeight: height, videoWidth: height * 2, readyState: 4, paused: false });

test('reports the playing height once per change and clears it when the video goes away', () => {
  const page = loadContent();
  page.startStream();
  page.tick();
  expect(page.sendMessage).not.toHaveBeenCalled();

  page.videos.push(playing(1080));
  page.tick();
  page.tick();
  page.videos[0] = playing(2160);
  page.tick();
  page.videos.length = 0;
  page.tick();

  expect(page.sendMessage.mock.calls.map(([message]) => message.text)).toEqual(['1080', '2160', '']);
  expect(page.sendMessage.mock.calls[0][0].type).toBe('SET_RESOLUTION_BADGE');
});

test('reports again after navigating to another title at the same height', () => {
  const page = loadContent();
  page.startStream();
  page.videos.push(playing(1080));
  page.tick();
  page.window.location.pathname = '/shows/video/episode/';
  page.tick();

  expect(page.sendMessage).toHaveBeenCalledTimes(2);
});

test('stops reporting once the extension context is gone', () => {
  const page = loadContent();
  page.startStream();
  page.videos.push(playing(1080));
  delete page.chrome.runtime.id;
  page.tick();

  expect(page.sendMessage).not.toHaveBeenCalled();
  expect(page.clearInterval).toHaveBeenCalledWith(7);
});

test('does not run in packages without a background script', () => {
  expect(loadContent({ background: null }).started()).toBe(false);
});

test('sets a tab-scoped native badge without changing its colors', () => {
  let onMessage;
  const action = { setBadgeText: jest.fn(), setBadgeBackgroundColor: jest.fn(), setBadgeTextColor: jest.fn() };
  vm.runInNewContext(backgroundSource, {
    chrome: { action, runtime: { onMessage: { addListener: listener => { onMessage = listener; } } } }
  });

  onMessage({ type: 'SET_RESOLUTION_BADGE', text: '1080' }, { tab: { id: 12 } });
  onMessage({ type: 'SET_RESOLUTION_BADGE', text: '' }, { tab: { id: 12 } });
  onMessage({ type: 'SET_RESOLUTION_BADGE', text: '720' }, {});
  onMessage({ type: 'OTHER', text: '720' }, { tab: { id: 12 } });

  expect(action.setBadgeText.mock.calls.map(([details]) => details)).toEqual([
    { tabId: 12, text: '1080' }, { tabId: 12, text: '' }
  ]);
  expect(action.setBadgeBackgroundColor).not.toHaveBeenCalled();
  expect(action.setBadgeTextColor).not.toHaveBeenCalled();
});
