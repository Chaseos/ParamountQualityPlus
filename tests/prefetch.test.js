import { jest } from '@jest/globals';
import { maybePrefetchSegments, clearPrefetchQueue } from '../injected/prefetch.js';

describe('Segment Prefetching', () => {
    let mockFetch;

    beforeEach(() => {
        mockFetch = jest.fn(() => Promise.resolve({ ok: true }));
        clearPrefetchQueue();
    });

    test('should prefetch next 5 segments for standard m4s pattern', () => {
        maybePrefetchSegments('https://host/video/seg_10.m4s', mockFetch);

        expect(mockFetch).toHaveBeenCalledTimes(5);
        expect(mockFetch).toHaveBeenNthCalledWith(1, 'https://host/video/seg_11.m4s', { priority: 'low' });
        expect(mockFetch).toHaveBeenNthCalledWith(2, 'https://host/video/seg_12.m4s', { priority: 'low' });
        expect(mockFetch).toHaveBeenNthCalledWith(3, 'https://host/video/seg_13.m4s', { priority: 'low' });
        expect(mockFetch).toHaveBeenNthCalledWith(4, 'https://host/video/seg_14.m4s', { priority: 'low' });
        expect(mockFetch).toHaveBeenNthCalledWith(5, 'https://host/video/seg_15.m4s', { priority: 'low' });
    });

    test('should maintain leading zeros', () => {
        maybePrefetchSegments('https://host/video/seg_009.m4s', mockFetch);

        expect(mockFetch).toHaveBeenCalledTimes(5);
        expect(mockFetch).toHaveBeenNthCalledWith(1, 'https://host/video/seg_010.m4s', { priority: 'low' });
        expect(mockFetch).toHaveBeenNthCalledWith(2, 'https://host/video/seg_011.m4s', { priority: 'low' });
        expect(mockFetch).toHaveBeenNthCalledWith(3, 'https://host/video/seg_012.m4s', { priority: 'low' });
        expect(mockFetch).toHaveBeenNthCalledWith(4, 'https://host/video/seg_013.m4s', { priority: 'low' });
        expect(mockFetch).toHaveBeenNthCalledWith(5, 'https://host/video/seg_014.m4s', { priority: 'low' });
    });

    test('should prefetch next 5 segments for query param pattern', () => {
        maybePrefetchSegments('https://host/video/100.ts?tok=123', mockFetch);

        expect(mockFetch).toHaveBeenCalledTimes(5);
        expect(mockFetch).toHaveBeenNthCalledWith(1, 'https://host/video/101.ts?tok=123', { priority: 'low' });
        expect(mockFetch).toHaveBeenNthCalledWith(5, 'https://host/video/105.ts?tok=123', { priority: 'low' });
    });

    test('should not prefetch if no segment number is found', () => {
        maybePrefetchSegments('https://host/video/init.mp4', mockFetch);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    test('should not fetch duplicates already in the queue', () => {
        // First call populates queue with 10, and prefetches 11, 12, 13, 14, 15
        maybePrefetchSegments('https://host/video/seg_10.m4s', mockFetch);
        expect(mockFetch).toHaveBeenCalledTimes(5);
        
        mockFetch.mockClear();

        // Second call for the next segment (e.g. player naturally reaches it).
        // 11 is now the base. It will try to prefetch 12, 13, 14, 15, 16.
        // 12-15 are already in the queue, so it should ONLY fetch 16.
        maybePrefetchSegments('https://host/video/seg_11.m4s', mockFetch);
        
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledWith('https://host/video/seg_16.m4s', { priority: 'low' });
    });

    test('should ignore prefetch network failures (fire and forget)', async () => {
        const errorMockFetch = jest.fn(() => Promise.reject(new Error('Network drop')));
        
        // This should not throw, it catches it internally
        maybePrefetchSegments('https://host/video/seg_10.m4s', errorMockFetch);
        
        expect(errorMockFetch).toHaveBeenCalledTimes(5);
        // Wait a tick for microtasks to resolve so the catch blocks run
        await Promise.resolve();
    });
});
