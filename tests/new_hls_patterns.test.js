import { jest } from '@jest/globals';

let maybeRewriteUrl;
let setAvailableRepresentations;
let parseHlsManifest;
let analyzeUrl;
let setConfig;

beforeAll(async () => {
    const api = await import('../injected/index.js');
    ({
        maybeRewriteUrl,
        setAvailableRepresentations,
        parseHlsManifest,
        analyzeUrl,
        setConfig
    } = api);
});

// --- Mocks ---
window.postMessage = jest.fn();

describe('Paramount New HLS Pattern Support', () => {

    beforeEach(() => {
        setAvailableRepresentations([]);
        setConfig({ forceMax: false, forcedId: null });
        window.postMessage.mockClear();
    });

    test('Should parse HLS tiers from manifest_N.m3u8 pattern', () => {
        const manifest = `
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=8942000,RESOLUTION=1920x1080
manifest_8.m3u8?CMCD=...
#EXT-X-STREAM-INF:BANDWIDTH=1352000,RESOLUTION=640x360
manifest_3.m3u8?CMCD=...
        `.trim();

        parseHlsManifest(manifest, 'https://host/stream/master.m3u8');

        expect(window.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'PQI_MANIFEST_DATA' }),
            '*'
        );

        const qualities = window.postMessage.mock.calls[0][0].payload;
        expect(qualities.length).toBe(2);

        const highQuality = qualities.find(q => q.height === 1080);
        expect(highQuality.hlsTier).toBe('8');

        const lowQuality = qualities.find(q => q.height === 360);
        expect(lowQuality.hlsTier).toBe('3');
    });

    test('Should rewrite HLS segments with manifest_N_M.ts pattern', async () => {
        const reps = [
            { id: 'hls_0', height: 1080, hlsTier: '8', isHls: true },
            { id: 'hls_1', height: 360, hlsTier: '3', isHls: true }
        ];
        setAvailableRepresentations(reps);
        setConfig({ forcedId: 'hls_0' });

        const originalUrl = 'https://host/stream/manifest_3_3328.ts?m=123';
        const rewrittenUrl = maybeRewriteUrl(originalUrl);

        expect(rewrittenUrl).toBe('https://host/stream/manifest_8_3328.ts?m=123');
    });

    test('Should analyze and report stats for manifest_N_M.ts pattern', async () => {
        analyzeUrl('https://host/stream/manifest_3_3328.ts?CMCD=br=1352,tb=8942');

        expect(window.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'PARAMOUNT_QUALITY_DATA',
                payload: expect.objectContaining({
                    bitrate: 1352,
                    maxBitrate: 8942
                })
            }),
            '*'
        );

        expect(window.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'PQI_ARCHIVED_HLS_DETECTED',
                payload: { currentTier: '3' }
            }),
            '*'
        );
    });

    test('Should maintain backwards compatibility with classic manifest_video pattern', () => {
        const reps = [
            { id: 'hls_0', height: 1080, hlsTier: '2400', isHls: true }
        ];
        setAvailableRepresentations(reps);
        setConfig({ forcedId: 'hls_0' });

        const originalUrl = 'https://host/manifest_video_1200_0_100.mp4';
        const rewrittenUrl = maybeRewriteUrl(originalUrl);

        expect(rewrittenUrl).toBe('https://host/manifest_video_2400_0_100.mp4');
    });
});
