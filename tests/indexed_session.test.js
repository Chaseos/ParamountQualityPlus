import { beforeEach, afterEach, expect, jest, test } from '@jest/globals';
import { createIndexedSession } from '../injected/indexed-session.js';
import { parseDashManifest } from '../injected/manifest-parser.js';
import { setConfig, clearRepresentations } from '../injected/state.js';
import { manifest, manifestUrl } from './fixtures/indexed-dash.js';
let listener;
let session;
let add;
let addDocument;
let videoError;
beforeEach(() => {
  document.body.replaceChildren();
  window.sessionStorage.clear();
  clearRepresentations(); setConfig({}); window.postMessage = jest.fn();
  add = jest.spyOn(window, 'addEventListener').mockImplementation((type, handler) => { if (type === 'message') listener = handler; });
  addDocument = jest.spyOn(document, 'addEventListener').mockImplementation((type, handler) => { if (type === 'error') videoError = handler; });
  session = createIndexedSession();
});
afterEach(() => { add.mockRestore(); addDocument.mockRestore(); });
const prepare = () => { const text = manifest(); parseDashManifest(text, manifestUrl); const prepared = session.prepare(text, manifestUrl); session.commit(prepared); return prepared; };
const change = config => { setConfig(config); listener({ source: window, data: { type: 'PQI_CONFIG', payload: config } }); };
const reloads = () => window.postMessage.mock.calls.filter(([data]) => data.type === 'PQI_INDEXED_RELOAD');

test('Auto -> manual requests exactly one reload, including duplicate configuration messages', () => {
  prepare(); change({ forcedHeight: 1080 }); change({ forcedHeight: 1080 });
  expect(reloads()).toHaveLength(1);
});
test('same effective quality, reconciled IDs and network preferences do not reload', () => {
  setConfig({ forcedHeight: 1080 }); prepare();
  change({ forceMax: true }); change({ forcedHeight: 1080, forcedId: 's0-1080', enablePrefetch: false });
  expect(reloads()).toHaveLength(0);
});
test('manual -> Auto reloads; title reset disables the indexed strategy', () => {
  setConfig({ forcedHeight: 1080 }); prepare(); change({});
  expect(reloads()).toHaveLength(1);
  window.postMessage.mockClear(); session.reset(); change({ forcedHeight: 540 });
  expect(reloads()).toHaveLength(0);
});
test('only failures of selected files trigger bounded recovery, not cancellations or other media', () => {
  setConfig({ forcedHeight: 1080 }); const prepared = prepare(); const url = prepared.mediaUrls[0];
  const recovered = () => window.postMessage.mock.calls.filter(([data]) => data.type === 'PQI_ORIGINAL_STREAM_RECOVERY');
  session.observe(url, false, 'AbortError', true);
  session.observe('https://other.test/ad.mp4', false, 404);
  session.observe(url, false, 404); expect(recovered()).toHaveLength(0);
  session.observe(url, true, 206);
  session.observe(url, false, 404); expect(recovered()).toHaveLength(0);
  session.observe(url, false, 404); expect(recovered()).toHaveLength(1);
  session.observe(url, false, 404); expect(recovered()).toHaveLength(1);
});


test('a terminal video error recovers only after selected media was received', () => {
  setConfig({ forcedHeight: 1080 }); const prepared = prepare();
  const failedVideo = { tagName: 'VIDEO', player: { isAd: false }, error: { code: 3 } };
  const recovered = () => window.postMessage.mock.calls.filter(([data]) => data.type === 'PQI_ORIGINAL_STREAM_RECOVERY');
  videoError({ target: failedVideo }); expect(recovered()).toHaveLength(0);
  session.observe(prepared.mediaUrls[0], true, 206);
  videoError({ target: { ...failedVideo, player: { isAd: true } } }); expect(recovered()).toHaveLength(0);
  videoError({ target: failedVideo }); expect(recovered()).toHaveLength(1);
  videoError({ target: failedVideo }); expect(recovered()).toHaveLength(1);
});

const recoveryMessages = () => window.postMessage.mock.calls.filter(([data]) => data.type === 'PQI_ORIGINAL_STREAM_RECOVERY');
function attachPlayer(url = manifestUrl) {
  const video = document.createElement('video');
  const handlers = new Set();
  const player = { isAd: false, resource: { location: { mediaUrl: url } },
    on: jest.fn((type, handler) => { if (type === 'error') handlers.add(handler); }),
    off: jest.fn((type, handler) => handlers.delete(handler)) };
  video.player = player; document.body.append(video);
  return { video, player, emit: error => { for (const handler of handlers) handler({ detail: { error } }); } };
}
const manifestFailure = { code: '2103', fatal: true, cause: { category: 4, code: 4012, data: [{ hasAppRestrictions: false, missingKeys: ['private-key-id'], restrictedKeyStatuses: ['output-restricted'] }] } };

test('player manifest failure before media or native video error recovers once', () => {
  const { emit, video } = attachPlayer(); setConfig({ forcedHeight: 1080 }); prepare();
  emit(manifestFailure); emit(manifestFailure);
  expect(recoveryMessages()).toHaveLength(1);
  expect(video.error).toBeFalsy();
  expect(JSON.parse(window.sessionStorage.getItem('pqiFailureReport'))).toMatchObject({
    failure: { shakaCode: 4012 }, manifest: { selectedHeight: 1080 }
  });
  expect(JSON.parse(window.sessionStorage.getItem('pqiIndexedFailure'))).toMatchObject({
    playerCode: '2103', shakaCode: 4012, selectedHeight: 1080,
    missingKeyCount: 1, restrictedKeyStatuses: ['output-restricted']
  });
  expect(window.sessionStorage.getItem('pqiIndexedFailure')).not.toContain('private-key-id');
  session.reset(); video.remove();
});

test('player recovery ignores Auto, ads, stale resources, unrelated errors and old bindings', () => {
  const { emit, player, video } = attachPlayer(); prepare(); emit(manifestFailure);
  expect(recoveryMessages()).toHaveLength(0);
  setConfig({ forcedHeight: 1080 }); prepare();
  emit({ ...manifestFailure, fatal: false });
  emit({ ...manifestFailure, code: '3005' });
  player.isAd = true; emit(manifestFailure); player.isAd = false;
  player.resource.location.mediaUrl = 'https://example.test/other/manifest.mpd'; emit(manifestFailure);
  expect(recoveryMessages()).toHaveLength(0);
  player.resource.location.mediaUrl = manifestUrl;
  session.reset(); emit(manifestFailure);
  expect(recoveryMessages()).toHaveLength(0); video.remove();
});

test('unavailable diagnostic storage does not prevent player recovery', () => {
  const { emit } = attachPlayer(); setConfig({ forcedHeight: 1080 }); prepare();
  const storage = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
  try {
    expect(() => emit(manifestFailure)).not.toThrow();
    expect(recoveryMessages()).toHaveLength(1);
  } finally { storage.mockRestore(); }
});

test('unavailable or disposed player observers cannot interrupt manifest commit or reset', () => {
  const { player } = attachPlayer(); setConfig({ forcedHeight: 1080 });
  player.on.mockImplementationOnce(() => { throw new Error('unavailable'); });
  expect(() => prepare()).not.toThrow();
  expect(session.handlesManifest()).toBe(true);
  prepare();
  player.off.mockImplementationOnce(() => { throw new Error('disposed'); });
  expect(() => session.reset()).not.toThrow();
});
