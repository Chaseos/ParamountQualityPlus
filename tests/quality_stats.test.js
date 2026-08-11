import { jest } from '@jest/globals';

let analyzeUrl;
let setAvailableRepresentations;

beforeAll(async () => {
    const api = await import('../injected/index.js');
    ({
        analyzeUrl,
        setAvailableRepresentations,
    } = api);
});

// --- Mocks ---
window.postMessage = jest.fn();

describe('Quality Stats & Bitrate Reporting', () => {

    beforeEach(() => {
        setAvailableRepresentations([]);
        window.postMessage.mockClear();
    });

    test('Should report stats based on manifest data when available', () => {
        const reps = [{
            id: '720p',
            height: 720,
            bandwidth: 4100000,
            dashTier: '3000',
            template: 'v/_720p_/seg.m4s'
        }];
        setAvailableRepresentations(reps);

        analyzeUrl('https://host/v/_720p_/seg.m4s');

        expect(window.postMessage).toHaveBeenCalled();
        const payload = window.postMessage.mock.calls[0][0].payload;

        expect(payload.bitrate).toBe(4100); // Uses MPD bandwidth, not the nominal URL tier
        expect(payload.resolution).toBe('720p');
        expect(payload.isEstimated).toBe(false);
        expect(payload.source).toBe('manifest');
    });

    test('Should prioritize Manifest Resolution over Bitrate Estimation', () => {
        const reps = [{
            id: 's0-360p',
            height: 360,
            bandwidth: 380000,
            dashTier: '380'
        }];
        setAvailableRepresentations(reps);

        // Bitrate 380 usually estimates to 270p, but manifest says 360p
        analyzeUrl('https://host/path/_380/seg_1.m4s');

        const payload = window.postMessage.mock.calls[0][0].payload;
        expect(payload.resolution).toBe('360p');
        expect(payload.isEstimated).toBe(false);
    });

    test('Should use rewritten target metadata before path if there is a mismatch', () => {
        const reps = [
            { id: '1080p', height: 1080, bandwidth: 5800000 },
            { id: '540p', height: 540, bandwidth: 2400000 }
        ];
        setAvailableRepresentations(reps);

        analyzeUrl('https://host/path/manifest_video_540p_2400/seg_1.m4s?CMCD=br%3D2400%2Cot%3Dv', {
            rewritten: true,
            targetHeight: 1080,
            targetBitrateKbps: 5800,
            targetSource: 'manifest'
        });

        const payload = window.postMessage.mock.calls[0][0].payload;
        expect(payload.resolution).toBe('1080p');
        expect(payload.bitrate).toBe(5800);
        expect(payload.isEstimated).toBe(false);
        expect(payload.source).toBe('manifest');
    });

    test('Should prefer the requested representation path over stale CMCD when they disagree', () => {
        const reps = [
            { id: '1080p', height: 1080, bandwidth: 5880000 },
            { id: 540, height: 540, bandwidth: 2738000 }
        ];
        setAvailableRepresentations(reps);

        analyzeUrl('https://host/video/_540p_/_2738/seg_1.m4s?CMCD=br%3D5880%2Cot%3Dv');

        const payload = window.postMessage.mock.calls[0][0].payload;
        expect(payload.resolution).toBe('540p');
        expect(payload.bitrate).toBe(2738);
        expect(payload.source).toBe('manifest');
    });

    test('Should fallback to estimation for unknown segments', () => {
        setAvailableRepresentations([]);

        analyzeUrl('https://host/path/_4500/seg_1.m4s');

        const payload = window.postMessage.mock.calls[0][0].payload;
        expect(payload.bitrate).toBe(4500);
        expect(payload.resolution).toBe('1080p');
        expect(payload.isEstimated).toBe(true);
        expect(payload.source).toBe('inferred');
    });

    test.each([
        {
            title: 'Sleepy Hollow',
            bitrate: 2738,
            expectedHeight: 576,
            qualities: [
                { height: 1080, bandwidth: 5880000 },
                { height: 720, bandwidth: 3940000 },
                { height: 576, bandwidth: 2740000 },
                { height: 540, bandwidth: 1940000 }
            ]
        },
        {
            title: 'Arrival',
            bitrate: 1590,
            expectedHeight: 540,
            qualities: [
                { height: 1080, bandwidth: 3300000 },
                { height: 720, bandwidth: 2400000 },
                { height: 540, bandwidth: 1590000 },
                { height: 432, bandwidth: 990000 }
            ]
        }
    ])('matches $title CMCD bitrate to its manifest ladder', ({ bitrate, expectedHeight, qualities }) => {
        setAvailableRepresentations(qualities);

        analyzeUrl(`https://host/content/seg_1.m4s?CMCD=br%3D${bitrate}%2Cot%3Dv`);

        const payload = window.postMessage.mock.calls[0][0].payload;
        expect(payload.resolution).toBe(`${expectedHeight}p`);
        expect(payload.bitrate).toBe(bitrate);
        expect(payload.isEstimated).toBe(false);
        expect(payload.source).toBe('manifest');
    });

    test('Should prefer the current CMCD bitrate over nominal manifest metadata', () => {
        setAvailableRepresentations([{
            id: '720p',
            height: 720,
            bandwidth: 4100000,
            dashTier: '3000'
        }]);

        analyzeUrl('https://host/video/_720p_/_3000/seg_1.m4s?CMCD=br%3D2875%2Cot%3Dv');

        expect(window.postMessage.mock.calls[0][0].payload.bitrate).toBe(2875);
    });

    test('reports the target manifest bitrate after a successful rewrite', () => {
        setAvailableRepresentations([{
            id: '4',
            rawId: '4',
            height: 1080,
            bandwidth: 8000000,
            hlsTier: '4'
        }]);

        analyzeUrl(
            'https://host/video/manifest_video_4_0_123.mp4?CMCD=br%3D1802%2Cot%3Dv',
            { rewritten: true }
        );

        const payload = window.postMessage.mock.calls[0][0].payload;
        expect(payload.resolution).toBe('1080p');
        expect(payload.bitrate).toBe(8000);
        expect(payload.source).toBe('manifest');
        expect(payload.maxBitrate).toBe(8000);
    });

    test('uses the live manifest ceiling when CMCD tb becomes stale', () => {
        setAvailableRepresentations([
            { id: '7', rawId: '7', height: 1080, bandwidth: 8000000 },
            { id: '4', rawId: '4', height: 540, bandwidth: 1800000 }
        ]);

        analyzeUrl('https://host/out/v1/live/manifest_video_7_0_123.mp4?CMCD=br%3D1800%2Cot%3Dv%2Cst%3Dl%2Ctb%3D1800', {
            rewritten: true,
            targetHeight: 1080,
            targetBitrateKbps: 8000,
            targetSource: 'manifest'
        });

        expect(window.postMessage.mock.calls[0][0].payload).toEqual(expect.objectContaining({
            resolution: '1080p',
            bitrate: 8000,
            maxBitrate: 8000
        }));
    });
});
