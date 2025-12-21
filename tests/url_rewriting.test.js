import { jest } from '@jest/globals';

let maybeRewriteUrl;
let setAvailableRepresentations;
let setConfig;

beforeAll(async () => {
    const api = await import('../injected/index.js');
    ({
        maybeRewriteUrl,
        setAvailableRepresentations,
        setConfig,
    } = api);
});

describe('URL Rewriting', () => {

    beforeEach(() => {
        setAvailableRepresentations([]);
        setConfig({ forceMax: false, forcedId: null });
    });

    const repsTypeB = [
        { id: '1080p', height: 1080, bandwidth: 6000000, dashTier: '4500', template: 'video/1080p/seg_$Number$.m4s' },
        { id: '720p', height: 720, bandwidth: 4000000, dashTier: '2500', template: 'video/720p/seg_$Number$.m4s' }
    ];

    const repsTypeA = [
        { id: '1080p', height: 1080, bandwidth: 6000000, dashTier: '5500', template: 'path/_1080p_/_5500/seg_$Number$.m4s' },
        { id: '540p', height: 540, bandwidth: 2000000, dashTier: '2000', template: 'path/_540p_/_2000/seg_$Number$.m4s' }
    ];

    test('Should rewrite bitrate-based segments (Type B)', () => {
        setAvailableRepresentations(repsTypeB);
        setConfig({ forceMax: true });

        const input = 'https://host/video/_2500/seg_10.m4s';
        const result = maybeRewriteUrl(input);

        expect(result).toBe('https://host/video/_4500/seg_10.m4s');
    });

    test('Should rewrite resolution-based segments using templates (Type A)', () => {
        setAvailableRepresentations(repsTypeA);
        setConfig({ forceMax: true });

        const input = 'https://host/path/_540p_/_2000/seg_123.m4s';
        const result = maybeRewriteUrl(input);

        expect(result).toContain('_1080p_');
        expect(result).toContain('_5500');
        expect(result).toContain('seg_123.m4s');
    });

    test('Should NOT rewrite audio segments', () => {
        setAvailableRepresentations(repsTypeB);
        setConfig({ forceMax: true });

        const input = 'https://host/audio/_aac_/seg_1.m4s';
        const result = maybeRewriteUrl(input);
        expect(result).toBe(input);
    });

    test('Should NOT rewrite if no override configuration is active', () => {
        setAvailableRepresentations(repsTypeB);
        setConfig({ forceMax: false, forcedId: null });

        const input = 'https://host/video/_2500/seg_1.m4s';
        const result = maybeRewriteUrl(input);
        expect(result).toBe(input);
    });

    test('Should NOT rewrite ad segments', () => {
        setAvailableRepresentations(repsTypeB);
        setConfig({ forceMax: true });

        const input = 'https://googlevideo.com/videoplayback?source=dclk_video_ads';
        const result = maybeRewriteUrl(input);
        expect(result).toBe(input);
    });
});
