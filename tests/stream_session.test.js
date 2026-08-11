import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseDashManifest, parseHlsManifest } from '../injected/manifest-parser.js';
import { getRepresentations, getStreamSession, setRepresentations } from '../injected/state.js';
import { classifyMediaRequest, selectRepresentation } from '../injected/stream-model.js';

window.postMessage = jest.fn();

describe('Stream-scoped representation state', () => {
  beforeEach(() => {
    setRepresentations([]);
    window.postMessage.mockClear();
  });

  test('resolves relative HLS variants and records one stream identity', () => {
    parseHlsManifest(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080
variant/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bandwidth/8000000.m3u8`,
    'https://dai.google.com/linear/hls/pa/event/E1/stream/S1/master.m3u8?token=master');

    expect(getRepresentations()[0]).toEqual(expect.objectContaining({
      family: 'google-dai-hls',
      streamKey: 'https://dai.google.com/event/E1/stream/S1',
      variantUrl: 'https://dai.google.com/linear/hls/pa/event/E1/stream/S1/variant/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bandwidth/8000000.m3u8'
    }));
  });

  test('replaces a prior HLS ladder when a DASH stream becomes active', () => {
    parseHlsManifest(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080
manifest_8.m3u8`, 'https://host/first/master.m3u8');

    parseDashManifest(`<MPD><Period><AdaptationSet contentType="video">
      <SegmentTemplate media="manifest_video_$RepresentationID$_0_$Number$.mp4" />
      <Representation id="7" width="1920" height="1080" bandwidth="8000000" />
    </AdaptationSet></Period></MPD>`, 'https://host/out/v1/second/manifest.mpd');

    expect(getRepresentations()).toHaveLength(1);
    expect(getRepresentations()[0]).toEqual(expect.objectContaining({ family: 'dash', rawId: '7' }));
    expect(getStreamSession()).toEqual(expect.objectContaining({
      key: 'https://host/out/v1/second',
      family: 'dash'
    }));
  });

  test('remaps a stale manual representation ID by manifest-confirmed height', () => {
    const representations = [
      { id: 's1-7', height: 1080, bandwidth: 8000000 },
      { id: 's1-5', height: 720, bandwidth: 3500000 }
    ];

    expect(selectRepresentation(representations, {
      forceMax: false,
      forcedId: 's0-7',
      forcedHeight: 1080
    })).toBe(representations[0]);
  });
});

describe('Media request classification', () => {
  test.each([
    'https://host/path/init.m4v',
    'https://host/path/init.m4s',
    'https://host/path/init-video-7.mp4',
    'https://host/path/manifest_video_7_0_init.mp4'
  ])('recognizes initialization request %s', url => {
    expect(classifyMediaRequest(url)).toEqual(expect.objectContaining({
      kind: 'segment',
      isInitialization: true
    }));
  });

  test('does not classify ordinary media as initialization', () => {
    expect(classifyMediaRequest('https://host/path/manifest_video_7_0_123.mp4').isInitialization)
      .toBe(false);
  });

  test.each([
    'https://host/out/v1/event/manifest_video_7_0_123.mp4',
    'https://dai.google.com/linear/hls/pa/event/E1/stream/S1/segment.ts',
    'https://news.example/index-english=128000-video=5000000-446155803.ts?CMCD=br%3D5980%2Cot%3Dv',
    'https://host/video/seg_1.m4s?CMCD=st%3Dl%2Cot%3Dv'
  ])('recognizes live request %s', url => {
    expect(classifyMediaRequest(url).isLive).toBe(true);
  });
});
