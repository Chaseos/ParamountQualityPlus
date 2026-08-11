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

    test('does not retry a player-cancelled segment request', async () => {
        const aborted = Object.assign(new Error('signal is aborted'), { name: 'AbortError' });
        originalFetchMock.mockRejectedValue(aborted);

        await expect(window.fetch('https://host/video/seg_10.m4s')).rejects.toBe(aborted);
        expect(originalFetchMock).toHaveBeenCalledTimes(6); // One player request plus five prefetches.
        expect(originalFetchMock.mock.calls.filter(([resource]) => resource === 'https://host/video/seg_10.m4s')).toHaveLength(1);
    });

    test('Should not retry non-segment / non-manifest URLs', async () => {
        originalFetchMock.mockResolvedValue({ ok: false, status: 500 });

        const response = await window.fetch('https://host/api/user/profile');
        
        // Should only be called once, no retries
        expect(originalFetchMock).toHaveBeenCalledTimes(1);
        expect(response.ok).toBe(false);
    });

    test('passes ordinary API requests through unchanged when Force Max is active', async () => {
        const apiUrl = 'https://www.paramountplus.com/apps-api/v2.0/live/channels';
        const response = { ok: true, status: 200 };
        setConfig({
            forceMax: true,
            forcedId: null,
            enableRetries: true,
            maxRetries: 3,
            enablePrefetch: true,
            prefetchCount: 5
        });
        originalFetchMock.mockResolvedValue(response);

        await expect(window.fetch(apiUrl)).resolves.toBe(response);
        expect(originalFetchMock).toHaveBeenCalledTimes(1);
        expect(originalFetchMock).toHaveBeenCalledWith(apiUrl);
    });

    test('does not retry failed ordinary API requests when Force Max is active', async () => {
        const apiUrl = 'https://www.paramountplus.com/apps-api/v2.0/live/channel/metadata';
        const response = { ok: false, status: 503 };
        setConfig({
            forceMax: true,
            forcedId: null,
            enableRetries: true,
            maxRetries: 3,
            enablePrefetch: true,
            prefetchCount: 5
        });
        originalFetchMock.mockResolvedValue(response);

        await expect(window.fetch(apiUrl)).resolves.toBe(response);
        expect(originalFetchMock).toHaveBeenCalledTimes(1);
    });

    test('preserves CMCD on the player request while normalizing prefetches', async () => {
        const url = 'https://host/video/seg_10.m4s?CMCD=br%3D1802%2Cot%3Dv%2Ctb%3D5812';
        originalFetchMock.mockResolvedValue({ ok: true, status: 200, headers: { get: () => 'video/mp4' } });

        await window.fetch(url);

        expect(originalFetchMock.mock.calls.some(([resource]) => resource === url)).toBe(true);
        expect(originalFetchMock.mock.calls.filter(([resource]) => resource.includes('seg_10.m4s'))[0][0]).toBe(url);
    });

    test('does not prefetch rewritten live initialization files', async () => {
        setRepresentations([
            { id: 's0-7', rawId: '7', height: 1080, bandwidth: 8000000 },
            { id: 's0-4', rawId: '4', height: 540, bandwidth: 1800000 }
        ]);
        setConfig({
            forceMax: true,
            forcedId: null,
            enableRetries: true,
            maxRetries: 3,
            enablePrefetch: true,
            prefetchCount: 5
        });
        originalFetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            headers: { get: () => 'video/mp4' }
        });

        await window.fetch('https://host/out/v1/live/manifest_video_4_0_init.mp4?m=1');

        expect(originalFetchMock).toHaveBeenCalledTimes(1);
        expect(originalFetchMock.mock.calls[0][0])
            .toContain('/manifest_video_7_0_init.mp4?m=1');
    });

    test('does not prefetch Google DAI live segments when CMCD omits st=l', async () => {
        const url = 'https://news.example/index-english=128000-video=5000000-446155803.ts?CMCD=br%3D5980%2Cot%3Dv%2Ctb%3D5980';
        const response = { ok: true, status: 200, headers: { get: () => 'video/mp2t' } };
        originalFetchMock.mockResolvedValue(response);

        await expect(window.fetch(url)).resolves.toBe(response);

        expect(originalFetchMock).toHaveBeenCalledTimes(1);
        expect(originalFetchMock).toHaveBeenCalledWith(url);
    });

    test('does not prefetch encrypted Paramount VOD segments', async () => {
        const url = 'https://vod.pplus.paramount.tech/path/asset_cenc_precon_dash/title_2100/seg_10.m4s?token=1';
        const response = { ok: true, status: 200, headers: { get: () => 'video/mp4' } };
        originalFetchMock.mockResolvedValue(response);

        await expect(window.fetch(url)).resolves.toBe(response);

        expect(originalFetchMock).toHaveBeenCalledTimes(1);
        expect(originalFetchMock).toHaveBeenCalledWith(url);
    });

    test('does not start speculative prefetches while the tab is hidden', async () => {
        const visibility = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        const url = 'https://host/video/seg_10.m4s';
        const response = { ok: true, status: 200, headers: { get: () => 'video/mp4' } };
        originalFetchMock.mockResolvedValue(response);

        try {
            await expect(window.fetch(url)).resolves.toBe(response);
        } finally {
            visibility.mockRestore();
        }

        expect(originalFetchMock).toHaveBeenCalledTimes(1);
        expect(originalFetchMock).toHaveBeenCalledWith(url);
    });

    test('keeps live DASH refreshes authoritative and continues rewriting later media', async () => {
        const manifestUrl = 'https://host/out/v1/live/manifest.mpd?m=1';
        const segmentUrl = 'https://host/out/v1/live/manifest_video_4_0_123.mp4?m=1';
        const manifestText = `<MPD><Period><AdaptationSet contentType="video">
          <SegmentTemplate media="manifest_video_$RepresentationID$_0_$Number$.mp4" />
          <Representation id="7" width="1920" height="1080" bandwidth="8000000" />
          <Representation id="4" width="960" height="540" bandwidth="1800000" />
        </AdaptationSet></Period></MPD>`;
        const manifestResponse = {
            ok: true,
            status: 200,
            headers: { get: () => 'application/dash+xml' },
            clone: () => ({ text: async () => manifestText })
        };
        const segmentResponse = {
            ok: true,
            status: 200,
            headers: { get: () => 'video/mp4' }
        };
        setConfig({
            forceMax: true,
            forcedId: null,
            enableRetries: true,
            maxRetries: 3,
            enablePrefetch: true,
            prefetchCount: 5
        });
        originalFetchMock.mockImplementation(url =>
            String(url).includes('.mpd') ? Promise.resolve(manifestResponse) : Promise.resolve(segmentResponse)
        );

        await window.fetch(manifestUrl);
        await window.fetch(segmentUrl);

        expect(originalFetchMock).toHaveBeenCalledTimes(2);
        expect(originalFetchMock.mock.calls[0][0]).toBe(manifestUrl);
        expect(originalFetchMock.mock.calls[1][0]).toContain('manifest_video_7_0_123.mp4?m=1');
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
