import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// Mock window.postMessage
jest.spyOn(window, 'postMessage').mockImplementation(() => { });

describe('Limited / Archived Stream Detection', () => {
    let analyzeUrl;
    let setRepresentations;
    let setConfig;

    beforeEach(async () => {
        jest.resetModules(); // Reset cache to get fresh module instances
        const urlAnalysisModule = await import('../injected/url-analysis.js');
        const stateModule = await import('../injected/state.js');

        analyzeUrl = urlAnalysisModule.analyzeUrl;
        setRepresentations = stateModule.setRepresentations;
        setConfig = stateModule.setConfig;

        setRepresentations([]);
        setConfig({ forceMax: false, forcedId: null });
        jest.clearAllMocks();
    });

    test('detects archived stream from URL pattern', () => {
        const url = 'https://example.com/path/to/manifest_video_1234_/segment.ts';
        analyzeUrl(url);

        expect(window.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'PQI_ARCHIVED_HLS_DETECTED',
                payload: { currentTier: '1234' }
            }),
            '*'
        );
    });

    test('detects archived stream with different URL format', () => {
        const url = 'https://example.com/manifest_video_480_001.ts';
        analyzeUrl(url);

        expect(window.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'PQI_ARCHIVED_HLS_DETECTED',
                payload: { currentTier: '480' }
            }),
            '*'
        );
    });

    // We can't easily test the "spam prevention" because `archivedHlsDetected` is a module-level variable
    // interacting with it across tests might be flaky if we don't reset modules, 
    // but for unit testing logic, one call is sufficient to prove the trigger works. 
    // The previous tests verify logic.

    test('does NOT detect archived stream for standard DASH segments', () => {
        const url = 'https://example.com/video/seg_1.m4s';
        analyzeUrl(url);

        expect(window.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'PQI_ARCHIVED_HLS_DETECTED'
            }),
            '*'
        );
    });
});
