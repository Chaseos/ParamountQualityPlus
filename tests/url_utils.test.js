import { extractResolutionFromPath, isSegmentUrl, isManifestUrl } from '../injected/url-utils.js';

describe('URL Utils', () => {
    describe('isSegmentUrl', () => {
        test('should correctly identify segments', () => {
            expect(isSegmentUrl('seg_10.m4s')).toBe(true);
            expect(isSegmentUrl('video_1_10.ts')).toBe(true);
            expect(isSegmentUrl('init.mp4')).toBe(true);
            expect(isSegmentUrl('init.m4v')).toBe(true);
            expect(isSegmentUrl('init.m4s')).toBe(true);
            expect(isSegmentUrl('manifest.mpd')).toBe(false);
            expect(isSegmentUrl('playlist.m3u8')).toBe(false);
        });

        test('matches the extension at the end of the path only', () => {
            expect(isSegmentUrl('https://host/video/SEG_10.M4S?CMCD=br%3D1#t')).toBe(true);
            expect(isSegmentUrl('https://host/beacon?url=https%3A%2F%2Fhost%2Fseg_10.m4s&name=seg_10.m4s')).toBe(false);
            expect(isSegmentUrl('https://host/assets/components.tsx')).toBe(false);
            expect(isSegmentUrl('https://cdn.tsx.example/api/collect')).toBe(false);
            expect(isManifestUrl('https://host/stream.mpd?token=1')).toBe(true);
            expect(isManifestUrl('https://host/master.m3u8/level/seg_1.ts')).toBe(false);
            expect(isManifestUrl('https://host/report?manifest=stream.mpd')).toBe(false);
            expect(isManifestUrl(null)).toBe(false);
        });
    });

    describe('isManifestUrl', () => {
        test('should correctly identify manifests', () => {
            expect(isManifestUrl('manifest.mpd')).toBe(true);
            expect(isManifestUrl('playlist.m3u8')).toBe(true);
            expect(isManifestUrl('seg_10.m4s')).toBe(false);
        });
    });
});
