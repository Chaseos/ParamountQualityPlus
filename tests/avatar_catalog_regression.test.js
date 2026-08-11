import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseManifest } from '../injected/manifest-parser.js';
import { planRequest, resetInferredFallbackState } from '../injected/rewriter.js';
import { getRepresentations, setConfig, setRepresentations } from '../injected/state.js';

const MANIFEST_URL = 'https://pubads.g.doubleclick.net/ondemand/dash/content/2497752/vid/4ArZ1SA516mS4BSuicLeDS1hmKzm8Irf/CHS/streams/session/manifest.mpd';
const CONTENT_ROOT = 'https://vod-gcs-cedexis.cbsaavideo.com/intl_vms/2020/06/05/1747188803528/3348861_cenc_precon_dash/';

const avatarManifest = `
  <MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
    <BaseURL>${CONTENT_ROOT}</BaseURL>
    <Period id="pre-roll-1-ad-1">
      <AdaptationSet contentType="video">
        <Representation id="ad-max" width="1920" height="1080" bandwidth="8000000">
          <SegmentTemplate media="$Number$.mp4" initialization="init.mp4" />
        </Representation>
      </AdaptationSet>
    </Period>
    <Period id="preview-slate">
      <AdaptationSet contentType="video">
        <Representation id="slate" width="3840" height="2160" bandwidth="12000000">
          <SegmentTemplate media="preview/seg_$Number$.m4s" initialization="preview/init.m4s" />
        </Representation>
      </AdaptationSet>
    </Period>
    <Period id="0">
      <AdaptationSet contentType="video" mimeType="video/mp4">
        <EssentialProperty schemeIdUri="http://dashif.org/guidelines/trickmode" value="video" />
        <Representation id="trick-2160" codecs="avc1.640033" width="3840" height="2160" bandwidth="110000">
          <SegmentTemplate media="trickplay/seg_$Number$.m4s" initialization="trickplay/init.m4s" />
        </Representation>
      </AdaptationSet>
      <AdaptationSet contentType="image" mimeType="image/jpeg">
        <Representation id="thumb_320x180" width="1280" height="1440" bandwidth="107298">
          <EssentialProperty schemeIdUri="http://dashif.org/guidelines/thumbnail_tile" value="4x8" />
          <SegmentTemplate media="thumbnails/$Number$.jpg" />
        </Representation>
      </AdaptationSet>
      <AdaptationSet id="preview-images-with-representation-type-only">
        <Representation id="poster-grid" mimeType="image/jpeg" width="1920" height="2160" bandwidth="90000">
          <SegmentTemplate media="posters/$Number$.jpg" />
        </Representation>
      </AdaptationSet>
      <AdaptationSet contentType="video">
        <Representation id="0" width="1920" height="1080" bandwidth="5462882">
          <SegmentTemplate media="NICKELODEON_AVATAR_105_V1_c23_1080p_3347410_5400/seg_$Number$.m4s" initialization="NICKELODEON_AVATAR_105_V1_c23_1080p_3347410_5400/init.m4v" />
        </Representation>
      </AdaptationSet>
      <AdaptationSet contentType="video">
        <Representation id="1" width="416" height="234" bandwidth="141729">
          <SegmentTemplate media="NICKELODEON_AVATAR_105_V1_c28_234p_3347410_130/seg_$Number$.m4s" initialization="NICKELODEON_AVATAR_105_V1_c28_234p_3347410_130/init.m4v" />
        </Representation>
      </AdaptationSet>
      <AdaptationSet contentType="video">
        <Representation id="4" width="960" height="540" bandwidth="1606505">
          <SegmentTemplate media="NICKELODEON_AVATAR_105_V1_c24_540p_3347410_2000/seg_$Number$.m4s" initialization="NICKELODEON_AVATAR_105_V1_c24_540p_3347410_2000/init.m4v" />
        </Representation>
      </AdaptationSet>
    </Period>
  </MPD>
`;

describe('Avatar legacy catalog regression', () => {
  beforeEach(() => {
    window.postMessage = jest.fn();
    setRepresentations([]);
    setConfig({ forceMax: true, forcedId: null, forcedHeight: null });
    resetInferredFallbackState();
  });

  test('ignores a higher-bitrate DAI ad period and rewrites content initialization and media together', () => {
    parseManifest(avatarManifest, MANIFEST_URL);

    expect(getRepresentations().map(rep => rep.height)).toEqual([1080, 540, 234]);
    expect(getRepresentations()[0]).toEqual(expect.objectContaining({
      pathId: 'NICKELODEON_AVATAR_105_V1_c23_1080p_3347410_5400',
      bandwidth: 5462882,
      isContent: true
    }));

    const sourceDirectory = 'NICKELODEON_AVATAR_105_V1_c24_540p_3347410_2000';
    const initPlan = planRequest(`${CONTENT_ROOT}${sourceDirectory}/init.m4v?CMCD=ot%3Di`);
    const segmentPlan = planRequest(`${CONTENT_ROOT}${sourceDirectory}/seg_4.m4s?CMCD=br%3D1607%2Cot%3Dv%2Ctb%3D5463`);

    expect(initPlan).toEqual(expect.objectContaining({
      action: 'authoritative-rewrite',
      mediaRole: 'initialization',
      url: expect.stringContaining('NICKELODEON_AVATAR_105_V1_c23_1080p_3347410_5400/init.m4v')
    }));
    expect(segmentPlan).toEqual(expect.objectContaining({
      action: 'authoritative-rewrite',
      mediaRole: 'segment',
      url: expect.stringContaining('NICKELODEON_AVATAR_105_V1_c23_1080p_3347410_5400/seg_4.m4s')
    }));
  });

  test('does not replace a content ladder when a separate ad-only manifest arrives', () => {
    parseManifest(avatarManifest, MANIFEST_URL);
    const contentLadder = getRepresentations();

    parseManifest(`
      <MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
        <Period id="mid-roll-1-ad-2">
          <AdaptationSet contentType="video">
            <Representation id="ad" width="1920" height="1080" bandwidth="9000000">
              <SegmentTemplate media="$Number$.mp4" initialization="init.mp4" />
            </Representation>
          </AdaptationSet>
        </Period>
      </MPD>
    `, `${MANIFEST_URL}?ad=1`);

    expect(getRepresentations()).toBe(contentLadder);
    expect(getRepresentations().map(rep => rep.height)).toEqual([1080, 540, 234]);
  });

  test('keeps same-height codec ladders separate at request time', () => {
    parseManifest(`
      <MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period id="0">
        <AdaptationSet contentType="video" codecs="avc1.640028">
          <SegmentTemplate media="avc/$RepresentationID$/seg_$Number$.m4s" initialization="avc/$RepresentationID$/init.m4s" />
          <Representation id="avc-540" width="960" height="540" bandwidth="1900000" />
          <Representation id="avc-1080" width="1920" height="1080" bandwidth="6000000" />
        </AdaptationSet>
        <AdaptationSet contentType="video" codecs="hvc1.1.6.L120">
          <SegmentTemplate media="hevc/$RepresentationID$/seg_$Number$.m4s" initialization="hevc/$RepresentationID$/init.m4s" />
          <Representation id="hevc-540" width="960" height="540" bandwidth="1200000" />
          <Representation id="hevc-1080" width="1920" height="1080" bandwidth="4000000" />
        </AdaptationSet>
      </Period></MPD>
    `, 'https://vod.pplus.paramount.tech/title/manifest.mpd');

    const plan = planRequest('https://vod.pplus.paramount.tech/title/hevc/hevc-540/seg_9.m4s');
    expect(plan).toEqual(expect.objectContaining({
      action: 'authoritative-rewrite',
      url: 'https://vod.pplus.paramount.tech/title/hevc/hevc-1080/seg_9.m4s'
    }));
  });

  test('uses validated VOD inference when a manifest ladder cannot map the source request', () => {
    setRepresentations([
      {
        id: 'max-from-manifest', height: 1080, bandwidth: 5462882,
        family: 'dash', source: 'manifest', compatibilityKey: 'dash:0:avc'
      },
      {
        id: 'low-from-another-period', height: 540, bandwidth: 1606505,
        family: 'dash', source: 'manifest', compatibilityKey: 'dash:1:avc'
      }
    ]);

    const plan = planRequest(
      `${CONTENT_ROOT}NICKELODEON_AVATAR_105_V1_c24_540p_3347410_2000/seg_4.m4s?CMCD=br%3D1607%2Cot%3Dv%2Ctb%3D5463`
    );

    expect(plan).toEqual(expect.objectContaining({
      action: 'inferred-probe',
      strategy: 'paramount-vod:legacy-catalog-c23',
      url: expect.stringContaining('NICKELODEON_AVATAR_105_V1_c23_1080p_3347410_5400/seg_4.m4s')
    }));
  });
});
