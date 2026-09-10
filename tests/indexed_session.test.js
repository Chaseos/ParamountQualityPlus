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
