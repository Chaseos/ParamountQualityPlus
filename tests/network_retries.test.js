import { jest } from '@jest/globals';

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
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
});

describe('Fetch Retries for Segments', () => {

    test('Should not retry successful requests', async () => {
        originalFetchMock.mockResolvedValueOnce({ ok: true, status: 200, clone: () => ({ text: async () => '' }) });
        
        const responsePromise = window.fetch('https://host/video/seg_10.m4s');
        const response = await responsePromise;

        expect(originalFetchMock).toHaveBeenCalledTimes(1);
        expect(response.ok).toBe(true);
    });

    test('Should retry failed requests with backoff up to 3 times', async () => {
        originalFetchMock
            .mockResolvedValueOnce({ ok: false, status: 502 }) // Try 1 fails
            .mockResolvedValueOnce({ ok: false, status: 503 }) // Try 2 fails
            .mockResolvedValueOnce({ ok: true, status: 200, clone: () => ({ text: async () => '' }) }); // Try 3 succeeds

        const fetchPromise = window.fetch('https://host/video/seg_10.m4s');
        
        // Wait for microtasks so the try block can finish and hit the timeout
        await jest.advanceTimersByTimeAsync(500);
        await jest.advanceTimersByTimeAsync(1000);

        const response = await fetchPromise;

        expect(originalFetchMock).toHaveBeenCalledTimes(3);
        expect(response.ok).toBe(true);
    });

    test('Should return failure if all 3 retries fail', async () => {
        originalFetchMock.mockResolvedValue({ ok: false, status: 500 });

        const fetchPromise = window.fetch('https://host/video/seg_10.m4s');
        
        for (let i = 0; i < 3; i++) {
             await jest.advanceTimersByTimeAsync(500 * Math.pow(2, i));
        }

        const response = await fetchPromise;

        expect(originalFetchMock).toHaveBeenCalledTimes(3);
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
