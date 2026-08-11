import { expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const contentSource = readFileSync(new URL('../content.js', import.meta.url), 'utf8');

function loadContentScript() {
  const windowListeners = new Map();
  let runtimeListener = null;
  const windowObject = {
    location: { pathname: '/movies/video/avatar/', reload: jest.fn() },
    sessionStorage: { getItem: jest.fn(() => null), setItem: jest.fn(), removeItem: jest.fn() },
    addEventListener: jest.fn((type, listener) => {
      const listeners = windowListeners.get(type) || [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    }),
    removeEventListener: jest.fn(),
    postMessage: jest.fn()
  };
  windowObject.window = windowObject;

  const context = {
    window: windowObject,
    document: {
      head: { appendChild: jest.fn() },
      documentElement: { appendChild: jest.fn() },
      createElement: jest.fn(() => ({ remove: jest.fn() })),
      querySelector: jest.fn(() => null)
    },
    chrome: {
      runtime: {
        getURL: jest.fn(value => value),
        onMessage: { addListener: jest.fn(listener => { runtimeListener = listener; }) }
      },
      storage: {
        sync: {
          get: jest.fn((keys, callback) => callback({})),
          set: jest.fn()
        },
        onChanged: { addListener: jest.fn() }
      }
    },
    console,
    Date,
    JSON,
    Number,
    setTimeout,
    clearTimeout
  };

  vm.createContext(context);
  vm.runInContext(contentSource, context);

  return {
    sendWindowMessage(data) {
      for (const listener of windowListeners.get('message') || []) {
        listener({ source: windowObject, data });
      }
    },
    getState() {
      let state;
      runtimeListener({ type: 'GET_STREAM_STATE' }, {}, value => { state = value; });
      return state;
    }
  };
}

test('accepts a successful manual downgrade and ignores an older late response', () => {
  const page = loadContentScript();

  page.sendWindowMessage({
    type: 'PARAMOUNT_QUALITY_DATA',
    payload: {
      resolution: '540p', bitrate: 1716, maxBitrate: 5812, source: 'manifest',
      streamKey: 'avatar', observationSequence: 10, timestamp: 10
    }
  });
  page.sendWindowMessage({
    type: 'PARAMOUNT_QUALITY_DATA',
    payload: {
      resolution: '234p', bitrate: 145, maxBitrate: 5812, source: 'manifest',
      streamKey: 'avatar', observationSequence: 11, timestamp: 11
    }
  });
  page.sendWindowMessage({
    type: 'PARAMOUNT_QUALITY_DATA',
    payload: {
      resolution: '540p', bitrate: 1716, maxBitrate: 5812, source: 'manifest',
      streamKey: 'previous-title', observationSequence: 9, timestamp: 12
    }
  });

  expect(page.getState()).toEqual(expect.objectContaining({
    resolution: '234p',
    bitrate: 145,
    maxBitrate: 5812,
    lastObservationSequence: 11
  }));
});
