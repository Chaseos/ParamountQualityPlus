import { jest } from '@jest/globals';
import { clearPrefetchQueue } from '../injected/prefetch.js';
import { getRepresentations, setConfig, setRepresentations } from '../injected/state.js';

let originalFetchMock;

beforeAll(async () => {
    // Setup a mock fetch before initNetworkHooks runs
    originalFetchMock = jest.fn();
    window.fetch = originalFetchMock;

    setConfig({ enableRetries: true, maxRetries: 3, enablePrefetch: true, prefetchCount: 5 });

    // Provide a dummy matchMedia or other things if jsdom complains, but usually fetch is enough.
    
    // Importing this will run initNetworkHooks and capture our mock as ORIGINAL_FETCH,
    // and overwrite window.fetch with the retry wrapper.
    await import('../injected/index.js');
});

beforeEach(() => {
    originalFetchMock.mockClear();
    clearPrefetchQueue();
    setRepresentations([]);
    setConfig({ enableRetries: true, maxRetries: 3, enablePrefetch: true, prefetchCount: 5 });
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
});

describe('Fetch Retries for Segments', () => {

    test('Should not retry successful requests', async () => {
        originalFetchMock.mockResolvedValue({ ok: true, status: 200, clone: () => ({ text: async () => '' }) });
        
        const responsePromise = window.fetch('https://host/video/seg_10.m4s');
        const response = await responsePromise;

        // 1 main fetch + 5 prefetch = 6 calls
        expect(originalFetchMock).toHaveBeenCalledTimes(6);
        expect(response.ok).toBe(true);
    });

    test('Should retry failed requests with backoff up to 3 times', async () => {
        // First the prefetch calls will happen (3 of them), then the main fetch, 
        // but we can just use mockImplementation to only fail the main URL
        let attempt = 0;
        originalFetchMock.mockImplementation((url) => {
            if (url === 'https://host/video/seg_10.m4s') {
                attempt++;
                if (attempt === 1) return Promise.resolve({ ok: false, status: 502 });
                if (attempt === 2) return Promise.resolve({ ok: false, status: 503 });
                return Promise.resolve({ ok: true, status: 200, clone: () => ({ text: async () => '' }) });
            }
            return Promise.resolve({ ok: true, status: 200 }); // Pre-fetch calls succeed
        });

        const fetchPromise = window.fetch('https://host/video/seg_10.m4s');
        
        // Wait for microtasks so the try block can finish and hit the timeout
        await jest.advanceTimersByTimeAsync(500);
        await jest.advanceTimersByTimeAsync(1000);

        const response = await fetchPromise;

        // 5 prefetch calls + 3 main fetch calls (2 fails, 1 success) = 8 calls
        expect(originalFetchMock).toHaveBeenCalledTimes(8);
        expect(response.ok).toBe(true);
    });

    test('Should return failure if all 3 retries fail', async () => {
        originalFetchMock.mockResolvedValue({ ok: false, status: 500 });

        const fetchPromise = window.fetch('https://host/video/seg_10.m4s');
        
        for (let i = 0; i < 3; i++) {
             await jest.advanceTimersByTimeAsync(500 * Math.pow(2, i));
        }

        const response = await fetchPromise;

        // 5 prefetch calls + 3 main fetch calls = 8 calls
        expect(originalFetchMock).toHaveBeenCalledTimes(8);
        expect(response.ok).toBe(false);
    });

    test('Should not retry non-segment / non-manifest URLs', async () => {
        originalFetchMock.mockResolvedValue({ ok: false, status: 500 });

        const response = await window.fetch('https://host/api/user/profile');
        
        // Should only be called once, no retries
        expect(originalFetchMock).toHaveBeenCalledTimes(1);
        expect(response.ok).toBe(false);
    });

    test('preserves CMCD on the player request while normalizing prefetches', async () => {
        const url = 'https://host/video/seg_10.m4s?CMCD=br%3D1802%2Cot%3Dv%2Ctb%3D5812';
        originalFetchMock.mockResolvedValue({ ok: true, status: 200, headers: { get: () => 'video/mp4' } });

        await window.fetch(url);

        expect(originalFetchMock.mock.calls.some(([resource]) => resource === url)).toBe(true);
        expect(originalFetchMock.mock.calls.filter(([resource]) => resource.includes('seg_10.m4s'))[0][0]).toBe(url);
    });

    test('parses a manifest before resolving it to the player', async () => {
        let releaseManifest;
        const manifestText = new Promise(resolve => { releaseManifest = resolve; });
        const response = {
            ok: true,
            status: 200,
            headers: { get: () => 'application/dash+xml' },
            clone: () => ({ text: () => manifestText })
        };
        originalFetchMock.mockResolvedValue(response);

        let playerReceivedManifest = false;
        const fetchPromise = window.fetch('https://host/manifest.mpd').then(result => {
            playerReceivedManifest = true;
            return result;
        });
        await Promise.resolve();
        expect(playerReceivedManifest).toBe(false);

        releaseManifest(`
            <MPD><Period><AdaptationSet contentType="video">
              <Representation id="5" width="1920" height="1080" bandwidth="5812183">
                <SegmentTemplate media="PPUSA_MOVIE_c20_1080p_asset_5400/seg_$Number$.m4s" />
              </Representation>
            </AdaptationSet></Period></MPD>
        `);

        await fetchPromise;
        expect(getRepresentations()).toEqual([
            expect.objectContaining({ height: 1080, dashTier: '5400', source: 'manifest' })
        ]);
    });

    test('fails open when a manifest body cannot be inspected', async () => {
        const response = {
            ok: true,
            status: 200,
            headers: { get: () => 'application/dash+xml' },
            clone: () => ({ text: () => Promise.reject(new Error('unreadable')) })
        };
        originalFetchMock.mockResolvedValue(response);

        await expect(window.fetch('https://host/manifest.mpd')).resolves.toBe(response);
    });

    test('clears stale representations when a new VOD content id starts', async () => {
        setRepresentations([{ id: 'old-title', height: 1080, hlsTier: '5', source: 'manifest' }]);
        const response = {
            ok: true,
            status: 200,
            headers: { get: () => 'application/dash+xml' },
            clone: () => ({ text: async () => '' })
        };
        originalFetchMock.mockResolvedValue(response);

        await window.fetch('https://pubads.g.doubleclick.net/ondemand/dash/content/1/vid/NEW_TITLE/CHS/streams/1/manifest.mpd');

        expect(getRepresentations()).toEqual([]);
    });

});
