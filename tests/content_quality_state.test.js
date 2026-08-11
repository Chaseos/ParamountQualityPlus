import { expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const contentSource = readFileSync(new URL('../content.js', import.meta.url), 'utf8');

function loadContentScript({ storageState = {}, recoveryMarker = null } = {}) {
  const windowListeners = new Map();
  let runtimeListener = null;
  let injectedScript = null;
  const storageSet = jest.fn();
  const windowObject = {
    location: { pathname: '/movies/video/avatar/', reload: jest.fn() },
    sessionStorage: {
      getItem: jest.fn(() => recoveryMarker),
      setItem: jest.fn(),
      removeItem: jest.fn()
    },
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
      head: { appendChild: jest.fn(script => { injectedScript = script; }) },
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
          get: jest.fn((keys, callback) => callback(storageState)),
          set: storageSet
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
    sendRuntimeMessage(data) {
      runtimeListener(data, {}, jest.fn());
    },
    runInjection() {
      injectedScript.onload.call(injectedScript);
    },
    getState() {
      let state;
      runtimeListener({ type: 'GET_STREAM_STATE' }, {}, value => { state = value; });
      return state;
    },
    storageSet,
    windowObject
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

test('stages saved Force Max before the injected network hooks start', () => {
  const page = loadContentScript({
    storageState: { forceMax: true, forcedId: null, forcedHeight: null }
  });

  expect(page.windowObject.sessionStorage.setItem).toHaveBeenCalledWith(
    'pqiPendingQualityConfig',
    expect.any(String)
  );
  const staged = JSON.parse(page.windowObject.sessionStorage.setItem.mock.calls[0][1]);
  expect(staged).toEqual(expect.objectContaining({
    forceMax: true,
    forcedId: null,
    forcedHeight: null
  }));

  page.runInjection();
  expect(page.windowObject.postMessage).toHaveBeenCalledWith({
    type: 'PQI_CONFIG',
    payload: expect.objectContaining({ forceMax: true })
  }, '*');
});

test('reports Auto as the applied mode during original-stream recovery', () => {
  const page = loadContentScript({
    storageState: { forceMax: true, forcedId: null, forcedHeight: null },
    recoveryMarker: '1'
  });

  page.runInjection();

  expect(page.windowObject.postMessage).toHaveBeenCalledWith({
    type: 'PQI_CONFIG',
    payload: expect.objectContaining({ forceMax: false, forcedId: null, forcedHeight: null })
  }, '*');
  expect(page.getState()).toEqual(expect.objectContaining({
    recoveryActive: true,
    appliedConfig: expect.objectContaining({ forceMax: false, forcedId: null, forcedHeight: null })
  }));

  page.sendRuntimeMessage({
    type: 'APPLY_QUALITY_CHANGE',
    payload: { forceMax: true, forcedId: null, forcedHeight: null }
  });
  expect(page.getState()).toEqual(expect.objectContaining({
    recoveryActive: false,
    appliedConfig: expect.objectContaining({ forceMax: true })
  }));
});

test('keeps a manual height preference when a partial ladder lacks that height', () => {
  const page = loadContentScript({
    storageState: { forceMax: false, forcedId: 'old-234', forcedHeight: 234 }
  });

  page.sendWindowMessage({
    type: 'PQI_MANIFEST_DATA',
    payload: [{ id: 'new-1080', height: 1080, bandwidth: 5800000 }]
  });

  expect(page.storageSet).toHaveBeenCalledWith({ forcedId: null });
  expect(page.storageSet).not.toHaveBeenCalledWith(expect.objectContaining({ forcedHeight: null }));
});
