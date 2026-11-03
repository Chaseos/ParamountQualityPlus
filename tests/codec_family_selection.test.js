import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseManifest } from '../injected/manifest-parser.js';
import { planRequest, resetInferredFallbackState } from '../injected/rewriter.js';
import { getRepresentations, setConfig, setRepresentations } from '../injected/state.js';

// Synthetic Paramount VOD paths: an AVC ladder up to 1080p plus HEVC UHD tiers
// in their own AdaptationSet, as exposed when the web player's codec exclusions
// are missing from a DAI stream request.
const MANIFEST_URL = 'https://pubads.g.doubleclick.net/ondemand/dash/content/100/vid/EXAMPLE_EPISODE_20/CHS/streams/session/manifest.mpd';
const CONTENT_ROOT = 'https://vod.pplus.paramount.tech/intl_vms/2000/01/01/EXAMPLE_EPISODE_20/1000020_cenc_precon_dash/';
const tierPath = (codecTier, height, bitrateTier) => `SAMPLE_SERIES_405_V1_c${codecTier}_${height}p_2000020_${bitrateTier}`;
const representation = (id, height, bandwidth, path) => `
  <Representation id="${id}" width="${Math.round(height * 16 / 9)}" height="${height}" bandwidth="${bandwidth}">
    <SegmentTemplate media="${path}/seg_$Number$.m4s" initialization="${path}/init.m4s" />
  </Representation>`;

const mixedCodecManifest = `
  <MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
    <BaseURL>${CONTENT_ROOT}</BaseURL>
    <Period id="0">
      <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.640028">
        ${representation('0', 540, 1900000, tierPath(24, 540, 2000))}
        ${representation('1', 720, 3600000, tierPath(20, 720, 3600))}
        ${representation('2', 1080, 5400000, tierPath(20, 1080, 5400))}
      </AdaptationSet>
      <AdaptationSet contentType="video" mimeType="video/mp4" codecs="hvc1.2.4.L150.B0">
        ${representation('3', 1440, 9000000, tierPath(50, 1440, 9000))}
        ${representation('4', 2160, 16000000, tierPath(50, 2160, 16000))}
      </AdaptationSet>
    </Period>
  </MPD>
`;

const avcSegment = `${CONTENT_ROOT}${tierPath(24, 540, 2000)}/seg_5.m4s`;
const representationAt = height => getRepresentations().find(rep => rep.height === height);

describe('codec-family request selection', () => {
  beforeEach(() => {
    window.postMessage = jest.fn();
    setRepresentations([]);
    setConfig({ forceMax: true, forcedId: null, forcedHeight: null });
    resetInferredFallbackState();
    parseManifest(mixedCodecManifest, MANIFEST_URL);
  });

  test('lists every advertised height, including UHD rows in another codec', () => {
    expect(getRepresentations().map(rep => rep.height)).toEqual([2160, 1440, 1080, 720, 540]);
  });

  test('Force Max keeps an AVC request on the highest AVC rendition', () => {
    expect(planRequest(avcSegment)).toEqual(expect.objectContaining({
      action: 'authoritative-rewrite',
      url: `${CONTENT_ROOT}${tierPath(20, 1080, 5400)}/seg_5.m4s`
    }));
  });

  test.each([2160, 1440])('a manual %ip HEVC selection falls back to AVC 1080p for an AVC request', height => {
    setConfig({ forceMax: false, forcedId: representationAt(height).id, forcedHeight: height });

    expect(planRequest(avcSegment)).toEqual(expect.objectContaining({
      action: 'authoritative-rewrite',
      url: `${CONTENT_ROOT}${tierPath(20, 1080, 5400)}/seg_5.m4s`
    }));
  });

  test('a manual AVC selection below the codec ceiling is unchanged', () => {
    setConfig({ forceMax: false, forcedId: representationAt(720).id, forcedHeight: 720 });

    expect(planRequest(avcSegment)).toEqual(expect.objectContaining({
      url: `${CONTENT_ROOT}${tierPath(20, 720, 3600)}/seg_5.m4s`
    }));
  });

  test('Force Max still reaches UHD when the player is already on HEVC', () => {
    expect(planRequest(`${CONTENT_ROOT}${tierPath(50, 1440, 9000)}/seg_5.m4s`)).toEqual(expect.objectContaining({
      action: 'authoritative-rewrite',
      url: `${CONTENT_ROOT}${tierPath(50, 2160, 16000)}/seg_5.m4s`
    }));
  });

  test('flags a manual pick that had to play lower, including when the request is already the fallback', () => {
    setConfig({ forceMax: false, forcedId: representationAt(2160).id, forcedHeight: 2160 });
    const cap = { streamKey: expect.any(String), requestedHeight: 2160, playingHeight: 1080 };

    expect(planRequest(avcSegment).qualityCap).toEqual(cap);
    expect(planRequest(`${CONTENT_ROOT}${tierPath(20, 1080, 5400)}/seg_5.m4s`)).toEqual(expect.objectContaining({
      action: 'pass-through', reason: 'already-target', qualityCap: cap
    }));
  });

  test('does not flag selections that play in their own codec', () => {
    setConfig({ forceMax: false, forcedId: representationAt(720).id, forcedHeight: 720 });
    expect(planRequest(avcSegment).qualityCap).toBeUndefined();

    setConfig({ forceMax: false, forcedId: representationAt(2160).id, forcedHeight: 2160 });
    expect(planRequest(`${CONTENT_ROOT}${tierPath(50, 1440, 9000)}/seg_5.m4s`).qualityCap).toBeUndefined();
  });

  test('an unrecognized request in a mixed-codec ladder is never sent to the HEVC tier', () => {
    const plan = planRequest(`${CONTENT_ROOT}${tierPath(26, 360, 450)}/seg_5.m4s`);

    expect(plan.url).not.toContain('_c50_');
  });
});
