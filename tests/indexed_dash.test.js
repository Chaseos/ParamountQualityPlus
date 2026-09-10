import { beforeEach, expect, jest, test } from '@jest/globals';
import { parseDashManifest } from '../injected/manifest-parser.js';
import { getRepresentations, setConfig, clearRepresentations } from '../injected/state.js';
import { filterIndexedDash, getIndexedAddressing } from '../injected/indexed-dash.js';
import { getParamountPackaging } from '../injected/stream-model.js';
import { planRequest } from '../injected/rewriter.js';
import { maybePrefetchSegments, clearPrefetchQueue } from '../injected/prefetch.js';
import { manifest, rendition, root, manifestUrl } from './fixtures/indexed-dash.js';

beforeEach(() => { clearRepresentations(); clearPrefetchQueue(); setConfig({}); window.postMessage = jest.fn(); });
const filter = (text, config = { forcedHeight: 1080 }) => {
  parseDashManifest(text, manifestUrl);
  return filterIndexedDash(text, manifestUrl, getRepresentations(), config);
};
const xml = text => new DOMParser().parseFromString(text, 'application/xml');

test.each(['PARPUS_LIONESS_302_V1', 'DIFFERENT_MOVIE'])('does not invent prefetch URLs for %s', name => {
  const fetch = jest.fn();
  const url = `${root}${name}_c24_540p_4342061_2000.mp4`;
  maybePrefetchSegments(url, fetch);
  expect(fetch).not.toHaveBeenCalled();
  expect(getParamountPackaging(url)).toBe('single-file');
  setConfig({ forceMax: true });
  expect(planRequest(url)).toMatchObject({ action: 'pass-through', reason: 'single-file-manifest-selection' });
});

test('other MP4 numbering and init handling are preserved', () => {
  const fetch = jest.fn(() => Promise.resolve({ ok: true }));
  maybePrefetchSegments('https://host/hls/manifest_7_10.mp4', fetch);
  expect(fetch).toHaveBeenCalledWith('https://host/hls/manifest_7_11.mp4', { priority: 'low' });
  fetch.mockClear();
  maybePrefetchSegments('https://host/hls/init.mp4', fetch);
  expect(fetch).not.toHaveBeenCalled();
  expect(getParamountPackaging('https://other.example/asset_cenc_fmp4_dash/a.mp4')).toBeNull();
});

test('filters only program video and retains original full ladder, ranges and DRM', () => {
  const original = manifest();
  const result = filter(original);
  expect(result).toMatchObject({ supported: true, selectedHeight: 1080 });
  expect(getRepresentations().map(rep => rep.height)).toEqual([1080, 540]);
  const doc = xml(result.text);
  expect(Array.from(doc.querySelectorAll('Representation')).map(rep => rep.id)).toEqual(['1080', 'audio', 'captions']);
  expect(doc.querySelector('SegmentBase').getAttribute('indexRange')).toBe('1000-1499');
  expect(doc.querySelector('Initialization').getAttribute('range')).toBe('0-999');
  expect(doc.querySelector('ContentProtection').getAttribute('cenc:default_KID')).toBe('original-key');
  expect(getRepresentations()[0].addressing.protection[0].defaultKID).toBe('original-key');
});

test('resolves inherited BaseURLs and SegmentBase attributes without rewriting them', () => {
  const doc = xml(`<MPD><BaseURL>${root}</BaseURL><Period><AdaptationSet><SegmentBase indexRange="100-200" timescale="1000"><Initialization range="0-99"/></SegmentBase><Representation><BaseURL>movie.mp4</BaseURL><SegmentBase presentationTimeOffset="17"/></Representation></AdaptationSet></Period></MPD>`);
  expect(getIndexedAddressing(doc.querySelector('Representation'), manifestUrl)).toMatchObject({
    mediaUrl: `${root}movie.mp4`, indexRange: '100-200', initializationRange: '0-99', timescale: '1000', presentationTimeOffset: '17'
  });
});

test.each([{}, { forcedHeight: 2160 }])('Auto or unavailable target preserves response bytes', config => {
  const original = manifest();
  expect(filter(original, config).text).toBe(original);
});

test('manual ID and Force Highest reuse the existing selection rules', () => {
  expect(filter(manifest(), { forcedId: 's0-540' }).selectedHeight).toBe(540);
  expect(filter(manifest(), { forceMax: true }).selectedHeight).toBe(1080);
});

test('preserves ads and codec variants, and selects the target in every program period', () => {
  const extra = `<Period id="pre-roll-ad"><AdaptationSet contentType="video">${rendition(540, { base: 'https://ads.example/ads/' })}</AdaptationSet></Period>
    <Period id="1"><AdaptationSet contentType="video">${rendition(540)}${rendition(1080)}</AdaptationSet></Period>`;
  const original = manifest({ representations: rendition(540) + rendition(1080) + rendition(1080, { codec: 'hvc1', id: 'hevc' }), extra });
  const result = filter(original);
  expect(result.selectedHeight).toBe(1080);
  expect(xml(result.text).querySelector('[id="hevc"]')).not.toBeNull();
  expect(xml(result.text).querySelector('[id="pre-roll-ad"] [height="540"]')).not.toBeNull();
  expect(xml(result.text).querySelector('[id="1"] [height="540"]')).toBeNull();
});

test.each([
  manifest({ type: 'dynamic' }),
  manifest().replace('1000-1499', '2000-1000'),
  manifest().replace('<BaseURL>', '<BaseURL>https://alternative.example/a.mp4</BaseURL><BaseURL>'),
  manifest({ representations: rendition(1080) + '<Representation id="540" height="540"><SegmentTemplate media="seg_$Number$.m4s"/></Representation>' }),
  manifest({ extra: `<Period id="1"><AdaptationSet contentType="video">${rendition(540)}</AdaptationSet></Period>` }),
  '<MPD><broken></MPD>'
])('unsupported or incomplete manifest is never partially filtered', original => {
  expect(filter(original).text).toBe(original);
});
