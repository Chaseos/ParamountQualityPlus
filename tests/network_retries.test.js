import { jest } from '@jest/globals';
import { clearPrefetchQueue } from '../injected/prefetch.js';

let originalFetchMock;

beforeAll(async () => {
    // Setup a mock fetch before initNetworkHooks runs
    originalFetchMock = jest.fn();
    window.fetch = originalFetchMock;

    // Provide a dummy matchMedia or other things if jsdom complains, but usually fetch is enough.
    
    // Importing this will run initNetworkHooks and capture our mock as ORIGINAL_FETCH,
    // and overwrite window.fetch with the retry wrapper.
    await import('../injected/index.js');
});

beforeEach(() => {
    originalFetchMock.mockClear();
    clearPrefetchQueue();
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

});
