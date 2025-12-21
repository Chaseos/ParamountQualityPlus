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

        expect(payload.bitrate).toBe(3000); // Uses dashTier
        expect(payload.resolution).toBe('720p');
        expect(payload.isEstimated).toBe(false);
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

    test('Should fallback to estimation for unknown segments', () => {
        setAvailableRepresentations([]);

        analyzeUrl('https://host/path/_4500/seg_1.m4s');

        const payload = window.postMessage.mock.calls[0][0].payload;
        expect(payload.bitrate).toBe(4500);
        expect(payload.resolution).toBe('1080p');
        expect(payload.isEstimated).toBe(true);
    });
});
