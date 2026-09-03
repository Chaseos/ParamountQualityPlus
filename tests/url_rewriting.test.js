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

    test('rewrites VOD initialization files to the selected representation directory', () => {
        setAvailableRepresentations([
            {
                id: '1080p',
                height: 1080,
                bandwidth: 5880000,
                pathId: 'Sleepy_Hollow_FTR_VMASTER_2725014_4500'
            },
            {
                id: '540p',
                height: 540,
                bandwidth: 2738000,
                pathId: 'Sleepy_Hollow_FTR_VMASTER_2725014_2100'
            }
        ]);
        setConfig({ forceMax: true });

        const input = 'https://vod-gcs-cedexis.cbsaavideo.com/path/Sleepy_Hollow_FTR_VMASTER_2725014_2100/init.m4v?CMCD=ot%3Di';
        expect(maybeRewriteUrl(input))
            .toContain('/Sleepy_Hollow_FTR_VMASTER_2725014_4500/init.m4v');
    });

    test('rewrites initialization URLs from the manifest initialization template', () => {
        setAvailableRepresentations([
            {
                id: 's0-7', rawId: '7', height: 1080, bandwidth: 8000000,
                template: 'manifest_video_$RepresentationID$_0_$Number$.mp4',
                initialization: 'manifest_video_$RepresentationID$_0_init.mp4'
            },
            {
                id: 's0-4', rawId: '4', height: 540, bandwidth: 1800000,
                template: 'manifest_video_$RepresentationID$_0_$Number$.mp4',
                initialization: 'manifest_video_$RepresentationID$_0_init.mp4'
            }
        ]);
        setConfig({ forceMax: true });

        expect(maybeRewriteUrl('https://host/out/v1/live/manifest_video_4_0_init.mp4?m=1'))
            .toBe('https://host/out/v1/live/manifest_video_7_0_init.mp4?m=1');
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

    test('rewrites the captured Big Brother live DASH representation ID', () => {
        setAvailableRepresentations([
            { id: 's0-7', rawId: '7', height: 1080, bandwidth: 8000000 },
            { id: 's0-4', rawId: '4', height: 540, bandwidth: 1800000 }
        ]);
        setConfig({ forceMax: true, forcedId: null });

        const input = 'https://airspace-cdn.cbsivideo.com/out/v1/live/manifest_video_4_0_465410.mp4?CMCD=br%3D1800%2Cot%3Dv%2Ctb%3D8000';
        expect(maybeRewriteUrl(input))
            .toContain('manifest_video_7_0_465410.mp4');
    });

    test('rewrites live DASH templates with cache-busting queries', () => {
        const template = 'manifest_video_$RepresentationID$_0_$Number$.mp4?m=1783441869';
        setAvailableRepresentations([
            {
                id: 's0-7', rawId: '7', height: 1080, bandwidth: 8000000,
                template, compatibilityKey: 'dash:period-0:avc', family: 'dash'
            },
            {
                id: 's0-4', rawId: '4', height: 540, bandwidth: 1800000,
                template, compatibilityKey: 'dash:period-0:avc', family: 'dash'
            }
        ]);
        setConfig({ forceMax: true, forcedId: null });

        const input = 'https://airspace-cdn.cbsivideo.com/out/v1/live/' +
            'manifest_video_4_0_465410.mp4?m=1783441869&CMCD=br%3D1800%2Cot%3Dv%2Ctb%3D8000';

        expect(maybeRewriteUrl(input)).toBe(
            'https://airspace-cdn.cbsivideo.com/out/v1/live/' +
            'manifest_video_7_0_465410.mp4?m=1783441869&CMCD=br%3D1800%2Cot%3Dv%2Ctb%3D8000'
        );
    });

    test('never rewrites a DASH manifest URL', () => {
        setAvailableRepresentations([
            {
                id: 's0-7',
                rawId: '7',
                height: 1080,
                bandwidth: 8000000,
                template: 'manifest_video_$RepresentationID$_0_$Number$.mp4'
            }
        ]);
        setConfig({ forceMax: true, forcedId: null });

        const manifestUrl = 'https://host/out/v1/live/manifest.mpd?m=1';
        expect(maybeRewriteUrl(manifestUrl)).toBe(manifestUrl);
    });

    test('does not apply the active DASH ladder to unrelated media', () => {
        setAvailableRepresentations([
            {
                id: 'content-1080',
                pathId: 'SHOW_c20_1080p_asset_5400',
                height: 1080,
                bandwidth: 5800000,
                compatibilityKey: 'dash:period-0:avc',
                family: 'dash'
            },
            {
                id: 'content-540',
                pathId: 'SHOW_c24_540p_asset_2000',
                height: 540,
                bandwidth: 1800000,
                compatibilityKey: 'dash:period-0:avc',
                family: 'dash'
            }
        ]);
        setConfig({ forceMax: true, forcedId: null });

        const trailer = 'https://www.paramountplus.com/trailers/preview.mp4';
        expect(maybeRewriteUrl(trailer)).toBe(trailer);
    });

    test('keeps tiered HLS rewrites within the source codec and audio family', () => {
        setAvailableRepresentations([
            {
                id: 'hls-1080', height: 1080, bandwidth: 6000000,
                family: 'tiered-hls', hlsTier: '7',
                variants: [
                    { id: 'hls-1080-avc', height: 1080, family: 'tiered-hls', hlsTier: '6', compatibilityKey: 'hls:avc:stereo:SDR' },
                    { id: 'hls-1080-hevc', height: 1080, family: 'tiered-hls', hlsTier: '7', compatibilityKey: 'hls:hevc:surround:HDR' }
                ]
            },
            {
                id: 'hls-540', height: 540, bandwidth: 1800000,
                family: 'tiered-hls', hlsTier: '3',
                variants: [
                    { id: 'hls-540-avc', height: 540, family: 'tiered-hls', hlsTier: '2', compatibilityKey: 'hls:avc:stereo:SDR' },
                    { id: 'hls-540-hevc', height: 540, family: 'tiered-hls', hlsTier: '3', compatibilityKey: 'hls:hevc:surround:HDR' }
                ]
            }
        ]);
        setConfig({ forceMax: true, forcedId: null, forcedHeight: null });

        expect(maybeRewriteUrl('https://host/video/manifest_video_2_0_123.ts'))
            .toBe('https://host/video/manifest_video_6_0_123.ts');
        expect(maybeRewriteUrl('https://host/video/manifest_video_3_0_123.ts'))
            .toBe('https://host/video/manifest_video_7_0_123.ts');
    });

    test.each([
        ['STAR_TREK_ST_101_c24_540p_4309720_2000', 'STAR_TREK_ST_101_c22_720p_4309720_3200'],
        ['PPUSA_SURVIVOR_5008_V1_c24_540p_3820071_2000', 'PPUSA_SURVIVOR_5008_V1_c22_720p_3820071_3200']
    ])('matches a manual VOD target to the current title and asset: %s', (sourcePath, targetPath) => {
        const representations = [
            {
                id: 'vod-1080', height: 1080, bandwidth: 5812000, family: 'dash',
                pathId: targetPath.replace('_c22_720p_', '_c20_1080p_').replace('_3200', '_5400'),
                compatibilityKey: 'dash:period-0:avc'
            },
            {
                id: 'vod-720', height: 720, bandwidth: 3800000, family: 'dash',
                pathId: targetPath, compatibilityKey: 'dash:period-1:avc'
            }
        ];
        setAvailableRepresentations(representations);
        setConfig({ forceMax: false, forcedId: 'vod-720', forcedHeight: 720 });

        expect(maybeRewriteUrl(
            `https://vod.pplus.paramount.tech/title_cenc_precon_dash/${sourcePath}/seg_10.m4s?CMCD=ot%3Dv`
        )).toContain(`${targetPath}/seg_10.m4s`);
    });

    test('does not match a manual VOD target from a different asset', () => {
        setAvailableRepresentations([{
            id: 'vod-720', height: 720, bandwidth: 3800000, family: 'dash',
            pathId: 'PPUSA_SURVIVOR_5008_V1_c22_720p_9999999_3200',
            compatibilityKey: 'dash:period-1:avc'
        }]);
        setConfig({ forceMax: false, forcedId: 'vod-720', forcedHeight: 720 });

        const input = 'https://vod.pplus.paramount.tech/title_cenc_precon_dash/' +
            'PPUSA_SURVIVOR_5008_V1_c24_540p_3820071_2000/seg_10.m4s';
        expect(maybeRewriteUrl(input)).toBe(input);
    });
});
