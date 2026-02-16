import { jest } from '@jest/globals';

let maybeRewriteUrl;
let setAvailableRepresentations;
let parseHlsManifest;
let analyzeUrl;
let setConfig;

let resetAnalysisState;

beforeAll(async () => {
    const api = await import('../injected/index.js');
    ({
        maybeRewriteUrl,
        setAvailableRepresentations,
        parseHlsManifest,
        analyzeUrl,
        setConfig,
        resetAnalysisState
    } = api);
});

// --- Mocks ---
window.postMessage = jest.fn();

describe('Paramount New HLS Pattern Support', () => {

    beforeEach(() => {
        setAvailableRepresentations([]);
        setConfig({ forceMax: false, forcedId: null });
        window.postMessage.mockClear();
        resetAnalysisState();
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

        // We no longer trigger PQI_ARCHIVED_HLS_DETECTED because we support these streams
        expect(window.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: 'PQI_ARCHIVED_HLS_DETECTED' }),
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
    test('Should NOT mark manifest_video as NO_CONTROL if st=l is present in CMCD', () => {
        const url = 'https://host/manifest_video_3_0_5312625.mp4?CMCD=st=l,br=1100';
        analyzeUrl(url);

        // Since we now support rewriting live streams, this should NOT trigger NO_CONTROL
        expect(window.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'PQI_LIVE_NO_CONTROL_DETECTED'
            }),
            '*'
        );

        expect(window.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'PARAMOUNT_QUALITY_DATA',
                payload: expect.objectContaining({
                    bitrate: 1100
                })
            }),
            '*'
        );

        // Should NOT trigger ARCHIVED
        expect(window.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: 'PQI_ARCHIVED_HLS_DETECTED' }),
            '*'
        );
    });

    test('Should rewrite manifest_video segments even if st=l is present in CMCD', () => {
        const reps = [
            { id: 'hls_0', height: 1080, hlsTier: '5', isHls: true }
        ];
        setAvailableRepresentations(reps);
        setConfig({ forcedId: 'hls_0' });

        const originalUrl = 'https://host/manifest_video_3_0_5312625.mp4?CMCD=st=l,br=1100';
        const rewrittenUrl = maybeRewriteUrl(originalUrl);

        // Should rewrite Tier 3 to Tier 5
        expect(rewrittenUrl).toBe('https://host/manifest_video_5_0_5312625.mp4?CMCD=st=l,br=1100');
    });

    test('Should rewrite initialization segments (manifest_video_X_Y_init.mp4)', () => {
        const reps = [
            { id: 'hls_0', height: 1080, hlsTier: '5', isHls: true }
        ];
        setAvailableRepresentations(reps);
        setConfig({ forcedId: 'hls_0' });

        const originalUrl = 'https://host/manifest_video_3_0_init.mp4?CMCD=st=l';
        const rewrittenUrl = maybeRewriteUrl(originalUrl);

        expect(rewrittenUrl).toBe('https://host/manifest_video_5_0_init.mp4?CMCD=st=l');
    });

    test('Should rewrite complex encoded CMCD URL if matched', () => {
        const reps = [
            { id: 'hls_0', height: 1080, hlsTier: '5', isHls: true }
        ];
        setAvailableRepresentations(reps);
        setConfig({ forcedId: 'hls_0' });

        const originalUrl = 'https://prope97d0g68.airspace-cdn.cbsivideo.com/out/v1/f85f9f0852004c26acd060c33de74e86/manifest_video_3_0_5313421.mp4?m=1739300121&CMCD=bl%3D9700%2Cbr%3D1100%2Csid%3D%224e31873a-6365-4b1c-8527-58f219c9e929%22%2Cst%3Dl%2Ctb%3D2000';
        const rewrittenUrl = maybeRewriteUrl(originalUrl);

        // Should rewrite Tier 3 to Tier 5
        expect(rewrittenUrl).toContain('manifest_video_5_0_5313421.mp4');
    });
});
