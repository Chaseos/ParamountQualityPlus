/** @jest-environment-options {"url":"https://www.paramountplus.com/"} */
import { readFileSync } from 'node:fs';
import { beforeEach, expect, jest, test } from '@jest/globals';
import { getPackageManifestCandidate, readPackageManifest, selectPackageTarget } from '../injected/package-manifest.js';
import { readDashRepresentations } from '../injected/manifest-parser.js';
import { setRepresentations, getRepresentations } from '../injected/state.js';

const captured = readFileSync(new URL('./fixtures/lioness-segmented-captured.mpd', import.meta.url), 'utf8');
const root = 'https://vod.pplus.paramount.tech/intl_vms/2026/06/10/ALVE01KTSC0QNME2JAKFQW7D3XQN8X/4388933_cenc_precon_dash/';
const source = root + 'PARPUS_LIONESS_302_V1_c24_540p_4342061_2000/seg_140.m4s';
const candidate = getPackageManifestCandidate(source);
const read = text => readPackageManifest(text, candidate, source);
const target = (text, config = { forcedHeight: 1080 }, reps = []) => {
  const manifest = read(text);
  return manifest && selectPackageTarget(manifest, source, config, reps);
};
const mutate = change => {
  const doc = new DOMParser().parseFromString(captured, 'application/xml');
  change(doc);
  return new XMLSerializer().serializeToString(doc);
};
beforeEach(() => { setRepresentations([]); window.postMessage = jest.fn(); });

test.each(['vod.pplus.paramount.tech', 'vod-gcs-cedexis.cbsaavideo.com'])('derives one query-free candidate on %s without title knowledge', host => {
  const media = `https://${host}/path/abc_cenc_precon_dash/NEVER_SEEN_TITLE/seg_2.m4s?CMCD=ot%3Dv&token=private#fragment`;
  expect(getPackageManifestCandidate(media)?.manifestUrl).toBe(`https://${host}/path/abc_cenc_precon_dash/stream.mpd`);
  expect(getPackageManifestCandidate(media.replace('https:', ''))?.manifestUrl).toBe(`https://${host}/path/abc_cenc_precon_dash/stream.mpd`);
});

test.each([
  source.replace('https:', 'http:'), source.replace('vod.pplus.paramount.tech', 'example.com'),
  source.replace('seg_140.m4s', 'init.m4v'), source + '?CMCD=ot%3Da', source + '?CMCD=st%3Dl',
  source.replace('/intl_vms/', '/ads/'), source.replace('_cenc_precon_dash', '_hls'),
  source.replace('seg_140.m4s', 'stream.mpd'), source.replace('seg_140.m4s', 'seg_140.ts'),
  source.replace('PARPUS_LIONESS_302_V1_c24_540p_4342061_2000', 'OTHER_en-US_eac3_192')
])('does not probe excluded observation %s', url => expect(getPackageManifestCandidate(url)).toBeNull());

test('pure parsing never publishes or replaces authoritative state', () => {
  const active = [{ id: 'player', height: 540 }];
  setRepresentations(active);
  expect(readDashRepresentations(captured, candidate.manifestUrl).length).toBeGreaterThan(0);
  expect(read(captured)).not.toBeNull();
  expect(getRepresentations()).toBe(active);
  expect(window.postMessage).not.toHaveBeenCalled();
});

test.each([1, 124, 125, 307, 308, 435, 436, 520])('captured timeline selects the correct period for segment %i', number => {
  const manifest = read(captured);
  const url = source.replace('seg_140', `seg_${number}`);
  const selected = selectPackageTarget(manifest, url, { forcedHeight: 1080 }, []);
  expect(selected?.url).toBe(url.replace('c24_540p_4342061_2000', 'c20_1080p_4342061_5400'));
});

test('uses declared paths, not c20/c23 guesses', () => {
  const renamed = captured.replaceAll('PARPUS_LIONESS_302_V1_c20_1080p_4342061_5400', 'UNFAMILIAR_TARGET');
  expect(target(renamed)?.url).toBe(root + 'UNFAMILIAR_TARGET/seg_140.m4s');
});

test('manual IDs are resolved only through authoritative effective heights', () => {
  expect(target(captured, { forcedId: 's0-0' })).toBeNull();
  expect(target(captured, { forcedId: 'player-target' }, [{ id: 'player-target', height: 1080 }])?.target.height).toBe(1080);
  expect(target(captured, { forceMax: true })?.target.height).toBe(1080);
  expect(target(captured, {})).toBeNull();
  expect(target(captured, { forcedHeight: 2160 })).toBeNull();
});

const selectedNode = doc => Array.from(doc.querySelectorAll('Period'))[1].querySelector('Representation[height="1080"]');
test.each([
  doc => selectedNode(doc).setAttribute('codecs', 'hvc1.1.6.L120'),
  doc => selectedNode(doc).setAttribute('frameRate', '60'),
  doc => selectedNode(doc).querySelector('SegmentTemplate').setAttribute('startNumber', '124'),
  doc => selectedNode(doc).querySelector('SegmentTemplate').setAttribute('presentationTimeOffset', '0'),
  doc => selectedNode(doc).querySelector('S').setAttribute('d', '123'),
  doc => selectedNode(doc).querySelector('S').setAttribute('r', '-1'),
  doc => selectedNode(doc).querySelector('SegmentTemplate').setAttribute('initialization', 'different/init.mp4'),
  doc => selectedNode(doc).appendChild(doc.querySelector('ContentProtection').cloneNode(true)),
  doc => selectedNode(doc).appendChild(doc.createElementNS(doc.documentElement.namespaceURI, 'SegmentBase')),
  doc => selectedNode(doc).remove()
])('refuses incompatible or unsupported target %#', change => expect(target(mutate(change))).toBeNull());

test('requires protection evidence for encrypted packages', () => {
  expect(read(mutate(doc => doc.querySelectorAll('ContentProtection').forEach(node => node.remove())))).toBeNull();
});

test('resolves inherited BaseURLs without leaving the observed package', () => {
  const content = mutate(doc => {
    const base = doc.createElementNS(doc.documentElement.namespaceURI, 'BaseURL');
    base.textContent = root; doc.documentElement.prepend(base);
  });
  expect(target(content)?.target.height).toBe(1080);
  expect(read(content.replace(root, 'https://other.example/'))).toBeNull();
});

test('rejects ambiguous source periods and mismatched packages', () => {
  expect(read(mutate(doc => doc.documentElement.appendChild(doc.querySelectorAll('Period')[1].cloneNode(true))))).toBeNull();
  expect(read(captured.replaceAll('c24_540p_4342061_2000', 'different_source'))).toBeNull();
  expect(read(captured.replace('type="static"', 'type="dynamic"'))).toBeNull();
  expect(read('<MPD>')).toBeNull();
});

test('single-file package discovery is diagnostic-only', () => {
  const content = readFileSync(new URL('./fixtures/lioness-single-file-captured.mpd', import.meta.url), 'utf8');
  const url = source.replace('4388933_cenc_precon_dash', '4389134_cenc_fmp4_dash').replace('/seg_140.m4s', '.mp4');
  const candidate = getPackageManifestCandidate(url);
  const manifest = readPackageManifest(content, candidate, url);
  expect(manifest?.diagnosticOnly).toBe(true);
  expect(selectPackageTarget(manifest, url, { forcedHeight: 1080 }, [])).toBeNull();
});
