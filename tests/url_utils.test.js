import { stripCMCD, extractResolutionFromPath, isSegmentUrl, isManifestUrl } from '../injected/url-utils.js';

describe('URL Utils', () => {
    describe('stripCMCD', () => {
        test('should remove CMCD parameter from the end of a URL', () => {
            const url = 'https://host/video/seg_10.m4s?CMCD=bl%3D9600%2Cbr%3D2892';
            expect(stripCMCD(url)).toBe('https://host/video/seg_10.m4s');
        });

        test('should remove CMCD parameter from the middle of a URL', () => {
            const url = 'https://host/video/seg_10.m4s?tok=abc&CMCD=bl%3D9600&time=123';
            expect(stripCMCD(url)).toBe('https://host/video/seg_10.m4s?tok=abc&time=123');
        });

        test('should remove CMCD parameter from the beginning of query string', () => {
            const url = 'https://host/video/seg_10.m4s?CMCD=bl%3D9600&tok=abc';
            expect(stripCMCD(url)).toBe('https://host/video/seg_10.m4s?tok=abc');
        });

        test('should return original URL if no CMCD is present', () => {
            const url = 'https://host/video/seg_10.m4s?tok=abc';
            expect(stripCMCD(url)).toBe(url);
        });

        test('should return original URL if it has no query string', () => {
            const url = 'https://host/video/seg_10.m4s';
            expect(stripCMCD(url)).toBe(url);
        });

        test('should handle null or undefined safely', () => {
            expect(stripCMCD(null)).toBe(null);
            expect(stripCMCD(undefined)).toBe(undefined);
            expect(stripCMCD('')).toBe('');
        });
    });

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
    });

    describe('isManifestUrl', () => {
        test('should correctly identify manifests', () => {
            expect(isManifestUrl('manifest.mpd')).toBe(true);
            expect(isManifestUrl('playlist.m3u8')).toBe(true);
            expect(isManifestUrl('seg_10.m4s')).toBe(false);
        });
    });
});
