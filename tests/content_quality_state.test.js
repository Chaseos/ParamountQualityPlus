import { expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const contentSource = readFileSync(new URL('../content.js', import.meta.url), 'utf8');

function loadContentScript({
  storageState = {}, recoveryMarker = null, deferStorage = false, videoElements = [], resume = null
} = {}) {
  const windowListeners = new Map();
  const documentListeners = new Map();
  let runtimeListener = null;
  let injectedScript = null;
  let storageCallback = null;
  const storageSet = jest.fn();
  const windowObject = {
    location: { pathname: '/movies/video/avatar/', reload: jest.fn() },
    sessionStorage: {
      getItem: jest.fn(key => key === 'pqiIndexedResume' ? resume : recoveryMarker),
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
      addEventListener: jest.fn((type, handler) => documentListeners.set(type, handler)),
      removeEventListener: jest.fn(type => documentListeners.delete(type)),
      head: { appendChild: jest.fn(script => { injectedScript = script; }) },
      documentElement: { appendChild: jest.fn() },
      createElement: jest.fn(() => ({ remove: jest.fn() })),
      querySelector: jest.fn(() => null),
      querySelectorAll: jest.fn(selector => selector === 'video' ? videoElements : [])
    },
    chrome: {
      runtime: {
        getURL: jest.fn(value => value),
        onMessage: { addListener: jest.fn(listener => { runtimeListener = listener; }) }
      },
      storage: {
        sync: {
          get: jest.fn((keys, callback) => {
            if (deferStorage) storageCallback = callback;
            else callback(storageState);
          }),
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
    emitVideo(type, video) { documentListeners.get(type)?.({ target: video }); },
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
    releaseStorage() {
      storageCallback?.(storageState);
    },
    hasInjectedScript() {
      return Boolean(injectedScript);
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

test('installs the main-world module before asynchronous storage returns', () => {
  const page = loadContentScript({
    storageState: { forceMax: true, forcedId: null, forcedHeight: null },
    deferStorage: true
  });

  expect(page.hasInjectedScript()).toBe(true);
  expect(page.windowObject.sessionStorage.setItem).not.toHaveBeenCalled();

  // Cover the slower-storage ordering: the module can finish loading first,
  // then receives the configuration as soon as storage responds.
  page.runInjection();
  page.releaseStorage();
  expect(page.windowObject.sessionStorage.setItem).toHaveBeenCalledWith(
    'pqiPendingQualityConfig',
    expect.any(String)
  );
  expect(page.windowObject.postMessage).toHaveBeenCalledWith({
    type: 'PQI_CONFIG',
    payload: expect.objectContaining({ forceMax: true })
  }, '*');
});

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

test('clears stale quality state when the main-world stream session resets', () => {
  const page = loadContentScript();
  page.sendWindowMessage({
    type: 'PQI_MANIFEST_DATA',
    payload: [{ id: 'old-1080', height: 1080, bandwidth: 5800000, streamKey: 'old-title' }]
  });
  page.sendWindowMessage({
    type: 'PARAMOUNT_QUALITY_DATA',
    payload: { resolution: '1080p', bitrate: 5800, streamKey: 'old-title', observationSequence: 1 }
  });

  page.sendWindowMessage({ type: 'PQI_STREAM_RESET', payload: { streamKey: 'new-title' } });

  expect(page.getState()).toEqual(expect.objectContaining({
    resolution: null,
    bitrate: null,
    manifestQualities: [],
    manifestStreamKey: 'new-title'
  }));
});

test('ignores malformed page messages instead of corrupting extension state', () => {
  const page = loadContentScript();

  expect(() => page.sendWindowMessage({ type: 'PARAMOUNT_QUALITY_DATA' })).not.toThrow();
  expect(() => page.sendWindowMessage({ type: 'PQI_MANIFEST_DATA', payload: 'not-a-ladder' })).not.toThrow();
  expect(page.getState().manifestQualities).toEqual([]);
});

test('does not let a stale live playlist overwrite the selected resolution', () => {
  const page = loadContentScript({
    storageState: { forceMax: false, forcedId: 'hls_2', forcedHeight: 540 }
  });
  page.sendWindowMessage({
    type: 'PQI_MANIFEST_DATA',
    payload: [{ id: 'hls_2', height: 540, bandwidth: 2000000 }]
  });
  page.sendWindowMessage({
    type: 'PARAMOUNT_QUALITY_DATA',
    payload: { resolution: '540p', bitrate: 2000, observationSequence: 1 }
  });
  page.sendWindowMessage({
    type: 'PQI_ACTIVE_QUALITY',
    payload: { resolution: '1080p', bitrate: 5800 }
  });

  expect(page.getState().resolution).toBe('540p');
});

test('reports the decoded video resolution instead of a stale live request', () => {
  const page = loadContentScript({
    videoElements: [{ videoHeight: 540, videoWidth: 960, paused: false, readyState: 4 }]
  });
  page.sendWindowMessage({
    type: 'PQI_MANIFEST_DATA',
    payload: [
      { id: 'live-1080', height: 1080, bandwidth: 5800000 },
      { id: 'live-540', height: 540, bandwidth: 2000000 }
    ]
  });
  page.sendWindowMessage({
    type: 'PARAMOUNT_QUALITY_DATA',
    payload: { resolution: '1080p', bitrate: 5800, observationSequence: 1 }
  });

  expect(page.getState()).toEqual(expect.objectContaining({
    resolution: '540p',
    bitrate: 2000,
    isEstimated: false,
    qualitySource: 'decoded'
  }));
});

function enableIndexed(page, streamKey = 'indexed-title') {
  page.sendWindowMessage({ type: 'PQI_MANIFEST_DATA', payload: [{ id: '1080', height: 1080, bandwidth: 5500000, streamKey }] });
  page.sendWindowMessage({ type: 'PQI_QUALITY_STRATEGY', payload: { streamKey, strategy: 'indexed-manifest' } });
}

test('indexed selection stages a single reload with episode position and paused state', () => {
  const page = loadContentScript({ videoElements: [{ videoHeight: 540, currentTime: 71, duration: 3000, paused: true }] });
  enableIndexed(page);
  const message = { type: 'PQI_INDEXED_RELOAD', payload: { streamKey: 'indexed-title', config: { forcedHeight: 1080 } } };
  page.sendWindowMessage(message); page.sendWindowMessage(message);
  expect(page.windowObject.location.reload).toHaveBeenCalledTimes(1);
  const resume = page.windowObject.sessionStorage.setItem.mock.calls.find(([key]) => key === 'pqiIndexedResume');
  expect(JSON.parse(resume[1])).toMatchObject({ path: '/movies/video/avatar/', time: 71, paused: true });
  expect(page.windowObject.sessionStorage.setItem).toHaveBeenCalledWith('pqiPendingQualityConfig', expect.stringContaining('1080'));
});

test('ordinary video and stale indexed title messages never add reloads', () => {
  const page = loadContentScript();
  const message = { type: 'PQI_INDEXED_RELOAD', payload: { streamKey: 'indexed-title', config: { forcedHeight: 1080 } } };
  page.sendWindowMessage(message);
  enableIndexed(page);
  page.sendWindowMessage({ type: 'PQI_STREAM_RESET', payload: { streamKey: 'next-title' } });
  page.sendWindowMessage(message);
  expect(page.getState().qualityStrategy).toBeNull();
  expect(page.windowObject.location.reload).not.toHaveBeenCalled();
});

test('indexed recovery stages Auto before the next bootstrap', () => {
  const page = loadContentScript(); enableIndexed(page);
  page.sendWindowMessage({ type: 'PQI_ORIGINAL_STREAM_RECOVERY', payload: { streamKey: 'indexed-title' } });
  const calls = page.windowObject.sessionStorage.setItem.mock.calls.filter(([key]) => key === 'pqiPendingQualityConfig');
  expect(JSON.parse(calls.at(-1)[1])).toMatchObject({ forceMax: false, forcedId: null, forcedHeight: null });
  expect(page.windowObject.location.reload).toHaveBeenCalledTimes(1);
});


test.each([true, false])('indexed reload restores the playhead and paused=%s on the matching episode', paused => {
  const page = loadContentScript({ resume: JSON.stringify({ path: '/movies/video/avatar/', time: 71,
    duration: 3000, paused, savedAt: Date.now() }) });
  const video = { tagName: 'VIDEO', currentTime: 0, duration: 3000, readyState: 2,
    play: jest.fn(() => Promise.resolve()), pause: jest.fn(), addEventListener: jest.fn(), removeEventListener: jest.fn() };
  page.emitVideo('loadedmetadata', { ...video, duration: 30, player: { isAd: true } });
  expect(video.play).not.toHaveBeenCalled(); expect(video.pause).not.toHaveBeenCalled();
  page.emitVideo('loadedmetadata', video);
  expect(video.currentTime).toBe(71);
  expect(paused ? video.pause : video.play).toHaveBeenCalledTimes(1);
  video.currentTime = 80; page.emitVideo('canplay', video); expect(video.currentTime).toBe(80);
});

test('resume data from another episode is ignored', () => {
  const page = loadContentScript({ resume: JSON.stringify({ path: '/different/episode/', time: 71,
    duration: 3000, paused: false, savedAt: Date.now() }) });
  const video = { tagName: 'VIDEO', currentTime: 0, duration: 3000, readyState: 2 };
  page.emitVideo('loadedmetadata', video); expect(video.currentTime).toBe(0);
});
