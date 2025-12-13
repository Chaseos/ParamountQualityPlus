import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { parseHlsManifest } from '../injected/manifest-parser.js';
import { maybeRewriteUrl } from '../injected/rewriter.js';
import { setRepresentations, setConfig, getConfig, getRepresentations } from '../injected/state.js';

// Mock window.postMessage
// Mock window.postMessage
jest.spyOn(window, 'postMessage').mockImplementation(() => { });

describe('Google DAI Live Stream Logic', () => {
    beforeEach(() => {
        setRepresentations([]);
        setConfig({ forceMax: false, forcedId: null });
        jest.clearAllMocks();
    });

    const masterManifest = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=635781,RESOLUTION=480x270
https://dai.google.com/linear/hls/pa/event/EID/stream/SID/variant/0219929b8f4989b82a0b9a8f58f7352a/bandwidth/635781.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=8940798,RESOLUTION=1920x1080
https://dai.google.com/linear/hls/pa/event/EID/stream/SID/variant/51dee42484fe2a2135500e11874015a5/bandwidth/8940798.m3u8`;

    test('parses DAI variants and extracts IDs', () => {
        parseHlsManifest(masterManifest);
        const reps = getRepresentations();
        expect(reps.length).toBe(2);

        const low = reps.find(r => r.height === 270);
        const high = reps.find(r => r.height === 1080);

        expect(low.daiId).toBe('0219929b8f4989b82a0b9a8f58f7352a');
        expect(high.daiId).toBe('51dee42484fe2a2135500e11874015a5');
    });

    test('rewrites variant URL to forced ID', () => {
        parseHlsManifest(masterManifest);
        setConfig({ forceMax: false, forcedId: 'hls_1' }); // hls_1 should be the high quality one (index 1)

        // Verify index assumption
        const reps = getRepresentations();
        const high = reps.find(r => r.height === 1080);
        expect(high.id).toBe('hls_1');

        const originalUrl = 'https://dai.google.com/linear/hls/pa/event/EID/stream/SID/variant/0219929b8f4989b82a0b9a8f58f7352a/bandwidth/635781.m3u8';
        const expectedUrl = 'https://dai.google.com/linear/hls/pa/event/EID/stream/SID/variant/51dee42484fe2a2135500e11874015a5/bandwidth/635781.m3u8';

        const rewrote = maybeRewriteUrl(originalUrl);
        expect(rewrote).toBe(expectedUrl);
    });


    test('rewrites variant playlist URL (not segments) to forced ID', () => {
        parseHlsManifest(masterManifest);
        setConfig({ forceMax: true });

        // Original Variant Playlist URL for the LOW quality stream
        const originalVariantUrl = 'https://dai.google.com/linear/hls/pa/event/EID/stream/SID/variant/0219929b8f4989b82a0b9a8f58f7352a/bandwidth/635781.m3u8';

        // Expected Rewrite: High Quality ID (51dee42484fe2a2135500e11874015a5)
        const expectedRewrittenUrl = 'https://dai.google.com/linear/hls/pa/event/EID/stream/SID/variant/51dee42484fe2a2135500e11874015a5/bandwidth/635781.m3u8';

        const rewrote = maybeRewriteUrl(originalVariantUrl);
        expect(rewrote).toBe(expectedRewrittenUrl);
    });

    test('infers active quality from variant playlist request', () => {
        parseHlsManifest(masterManifest); // Populate available reps

        const variantRequestUrl = 'https://dai.google.com/linear/hls/pa/event/EID/stream/SID/variant/51dee42484fe2a2135500e11874015a5/bandwidth/8940798.m3u8';
        const variantResponse = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:100
#EXTINF:6.0,
segment_100.ts`;

        parseHlsManifest(variantResponse, variantRequestUrl);

        expect(window.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'PQI_ACTIVE_QUALITY',
                payload: expect.objectContaining({
                    daiId: '51dee42484fe2a2135500e11874015a5',
                    resolution: '1080p',
                    bitrate: 8941 // 8940798 / 1000 rounded
                })
            }),
            '*'
        );
    });


});
