import { readFileSync } from 'node:fs';
import { beforeEach, expect, jest, test } from '@jest/globals';
import { parseDashManifest } from '../injected/manifest-parser.js';
import { clearRepresentations, getRepresentations, setConfig } from '../injected/state.js';
import { filterIndexedDash } from '../injected/indexed-dash.js';

// Real public package MPD retrieved 2026-09-10, not the reporter's session MPD.
const url = 'https://vod.pplus.paramount.tech/intl_vms/2026/06/10/ALVE01KTSC0QNME2JAKFQW7D3XQN8X/4389134_cenc_fmp4_dash/stream.mpd';
const original = readFileSync(new URL('./fixtures/lioness-single-file-captured.mpd', import.meta.url), 'utf8');
const parse = text => new DOMParser().parseFromString(text, 'application/xml');
const videoNodes = doc => Array.from(doc.querySelectorAll('AdaptationSet[contentType="video"] Representation'));

beforeEach(() => {
  clearRepresentations();
  setConfig({});
  window.postMessage = jest.fn();
  parseDashManifest(original, url);
});

test.each([1080, 540])('real indexed package selects %ip and preserves original media metadata', height => {
  const ladder = getRepresentations();
  const before = parse(original);
  const result = filterIndexedDash(original, url, ladder, { forcedHeight: height });
  expect(result).toMatchObject({ supported: true, reason: 'selected', selectedHeight: height });
  const after = parse(result.text);
  const retained = videoNodes(after);
  expect(retained.length).toBe(height === 1080 ? 3 : 1);
  for (const rep of retained) {
    expect(Number(rep.getAttribute('height'))).toBe(height);
    const source = videoNodes(before).find(node => node.id === rep.id);
    expect(rep.isEqualNode(source)).toBe(true);
    expect(Array.from(rep.parentElement.querySelectorAll('ContentProtection')).map(node => node.outerHTML))
      .toEqual(Array.from(source.parentElement.querySelectorAll('ContentProtection')).map(node => node.outerHTML));
  }
  const nonVideo = doc => Array.from(doc.querySelectorAll('AdaptationSet')).filter(node => node.getAttribute('contentType') !== 'video').map(node => node.outerHTML);
  expect(nonVideo(after)).toEqual(nonVideo(before));
  expect(getRepresentations()).toBe(ladder);
  expect(ladder.map(rep => rep.height)).toEqual([2160, 1440, 1080, 720, 544, 540, 432, 360, 240, 234]);
  const suffix = height === 1080 ? 'c20_1080p_4342061_5400.mp4' : 'c24_540p_4342061_2000.mp4';
  expect(result.mediaUrls.some(value => value.endsWith(suffix))).toBe(true);
  if (height === 1080) {
    const avc = retained.find(node => node.querySelector('BaseURL').textContent.endsWith(suffix));
    expect(avc.querySelector('SegmentBase').getAttribute('indexRange')).toBe('1639-7994');
    expect(avc.querySelector('Initialization').getAttribute('range')).toBe('0-1638');
  }
});

test('real indexed package leaves Auto unchanged and identifies HDR-only maximum', () => {
  const ladder = getRepresentations();
  expect(filterIndexedDash(original, url, ladder, {}).text).toBe(original);
  const result = filterIndexedDash(original, url, ladder, { forceMax: true });
  expect(result).toMatchObject({ supported: true, selectedHeight: 2160 });
  expect(videoNodes(parse(result.text)).map(node => node.getAttribute('height'))).toEqual(['2160', '2160']);
});
