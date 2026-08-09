import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseDashManifest, parseHlsManifest } from '../injected/manifest-parser.js';
import { getRepresentations, getStreamSession, setRepresentations } from '../injected/state.js';

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
});
