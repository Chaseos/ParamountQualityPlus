const {
    parseManifest,
    maybeRewriteUrl,
    retryRewriteUrl,
    setAvailableRepresentations,
    setConfig,
    getAvailableRepresentations,
    analyzeUrl,
    estimateResolutionFromBitrate
} = require('../injected.js');

// --- Mocks & Setup ---
// Mocks
window.fetch = jest.fn();
window.postMessage = jest.fn();
window.addEventListener = jest.fn();

// DOMParser Mock specifically designed to handle our Manifest XML stubs
global.DOMParser = class {
    parseFromString(str) {
        return {
            getElementsByTagName: (tagName) => {
                if (tagName === 'Representation') {
                    // Extract all <Representation ... /> tags
                    const reps = [];
                    const regex = /<Representation\s+([^>]+)>/g;
                    let match;
                    while ((match = regex.exec(str)) !== null) {
                        const attrsStr = match[1];
                        const getAttr = (name) => {
                            const m = attrsStr.match(new RegExp(`${name}="([^"]+)"`));
                            return m ? m[1] : null;
                        };

                        // Look for child BaseURL or SegmentTemplate
                        // This simplistic mock assumes they are either direct children in string or we rely on logic handling 'null'.
                        const id = getAttr('id');

                        // Mock getElementsByTagName for children of Representation
                        reps.push({
                            getAttribute: getAttr,
                            getElementsByTagName: (childTag) => {
                                if (childTag === 'BaseURL') {
                                    // See if we have <BaseURL>..._4500/...</BaseURL> near this representation?
                                    // Too hard to regex reliably. Let's rely on 'getAttribute' only for this mock unless strictly needed.
                                    return [];
                                }
                                if (childTag === 'SegmentTemplate') {
                                    // Logic checks rep-level template first.
                                    // We can inject it as an attribute match for testing convenience if code allows, 
                                    // but code checks child node.
                                    // Let's assume global template for most tests to simplify mock complexity.
                                    return [];
                                }
                                return [];
                            },
                            parentNode: {
                                tagName: 'AdaptationSet',
                                getAttribute: (attr) => {
                                    if (attr === 'mimeType') return 'video/mp4';
                                    if (attr === 'contentType') return 'video';
                                    return null;
                                }
                            }
                        });
                    }
                    return reps;
                }

                if (tagName === 'AdaptationSet') {
                    // Check for Global SegmentTemplate
                    const regex = /<SegmentTemplate\s+media="([^"]+)"/;
                    const match = str.match(regex);
                    if (match) {
                        return [{
                            getAttribute: (attr) => (attr === 'contentType' ? 'video' : null),
                            getElementsByTagName: (tag) => {
                                if (tag === 'SegmentTemplate') return [{ getAttribute: () => match[1] }];
                                return [];
                            }
                        }];
                    }
                    return [];
                }
                return [];
            }
        };
    }
};

describe('ParamountPlusQualityController - Extensive Tests', () => {

    beforeEach(() => {
        setAvailableRepresentations([]);
        setConfig({ forceMax: false, forcedId: null });
        window.postMessage.mockClear();
    });

    // --- 1. Manifest Parsing Accuracy ---
    describe('Manifest Parsing', () => {
        test('Type B (Bitrate-Based): Should map ~4500kbps to 1080p', () => {
            const xml = `
                <MPD>
                    <Period>
                        <AdaptationSet mimeType="video/mp4">
                            <SegmentTemplate media="video/$RepresentationID$/seg_$Number$.m4s" />
                            <Representation id="rep1" width="1920" height="1080" bandwidth="5800000" />
                            <!-- 5.8Mbps manifest max usually corresponds to ~4.5Mbps tier -->
                        </AdaptationSet>
                    </Period>
                </MPD>
            `;
            // Note: Our logic fuzzy matches 5800kbps / 1.3 ~= 4461 -> Closest 4500

            parseManifest(xml, 'http://test.com/manifest.mpd');
            const reps = getAvailableRepresentations();

            expect(reps.length).toBe(1);
            expect(reps[0].dashTier).toBe('4500'); // Fuzzy matched
            expect(reps[0].height).toBe(1080);
        });

        test('Type A (Resolution-Based): Should PRESERVE actual resolution (e.g. 234p)', () => {
            // Type A detection relies on 'template' having _(\d+p)_
            const xml = `
                 <MPD>
                     <Period>
                         <AdaptationSet mimeType="video/mp4">
                            <SegmentTemplate media="path/_234p_/_400/seg_$Number$.m4s" />
                            <Representation id="234p" width="416" height="234" bandwidth="400000" /> 
                         </AdaptationSet>
                     </Period>
                 </MPD>
             `;

            parseManifest(xml, 'http://test.com/manifest.mpd');
            const reps = getAvailableRepresentations();

            expect(reps.length).toBe(1);
            expect(reps[0].height).toBe(234); // Must NOT be 270p (estimated from 400kbps)
        });
    });

    // --- 2. URL Rewriting ---
    describe('URL Rewriting', () => {
        // Mock data for tests
        const repsTypeB = [
            { id: '1080p', height: 1080, bandwidth: 6000000, dashTier: '4500', template: 'video/1080p/seg_$Number$.m4s' },
            { id: '720p', height: 720, bandwidth: 4000000, dashTier: '2500', template: 'video/720p/seg_$Number$.m4s' }
        ];

        const repsTypeA = [
            { id: '1080p', height: 1080, bandwidth: 6000000, dashTier: '5500', template: 'path/_1080p_/_5500/seg_$Number$.m4s' },
            { id: '540p', height: 540, bandwidth: 2000000, dashTier: '2000', template: 'path/_540p_/_2000/seg_$Number$.m4s' }
        ];

        test('Type B: Should rewrite segment from 2500 -> 4500 (Force Max)', () => {
            setAvailableRepresentations(repsTypeB);
            setConfig({ forceMax: true }); // Target 1080p (4500)

            const input = 'https://host/video/_2500/seg_10.m4s';
            // Heuristic replacement
            const result = maybeRewriteUrl(input);

            expect(result).toBe('https://host/video/_4500/seg_10.m4s');
        });

        test('Type A: Should rewrite Resolution AND Bitrate (Force Max)', () => {
            setAvailableRepresentations(repsTypeA);
            setConfig({ forceMax: true }); // Target 1080p (5500)

            // Current playback: 540p / 2000
            const input = 'https://host/path/_540p_/_2000/seg_123.m4s';

            // Should activate Template Rewrite via retryRewriteUrl
            const result = maybeRewriteUrl(input);

            // Expected template: path/_1080p_/_5500/seg_$Number$.m4s
            expect(result).toContain('_1080p_');
            expect(result).toContain('_5500');
            expect(result).toContain('seg_123.m4s');
        });

        test('No Rewrite: Should NOT rewrite Audio segments', () => {
            setAvailableRepresentations(repsTypeB);
            setConfig({ forceMax: true });

            const input = 'https://host/audio/_aac_/seg_1.m4s';
            const result = maybeRewriteUrl(input);
            expect(result).toBe(input);
        });

        test('No Rewrite: Should NOT rewrite if no config active', () => {
            setAvailableRepresentations(repsTypeB);
            setConfig({ forceMax: false, forcedId: null });

            const input = 'https://host/video/_2500/seg_1.m4s';
            const result = maybeRewriteUrl(input);
            expect(result).toBe(input);
        });
    });

    // --- 3. Effective Bitrate Reporting ---
    describe('Effective Bitrate Reporting (UI Stats)', () => {

        test('Should prioritize dashTier (Average Bitrate) over Bandwidth', () => {
            // Because UI lists qualities by dashTier (e.g. 3.0 Mbps), the reported stats must match.
            const reps = [{
                id: '720p',
                height: 720,
                bandwidth: 4100000, // Max 4.1 Mbps
                dashTier: '3000',   // Avg 3.0 Mbps
                template: 'v/_720p_/seg.m4s'
            }];
            setAvailableRepresentations(reps);

            // Analyze a URL corresponding to this rep
            analyzeUrl('https://host/v/_720p_/seg.m4s');

            expect(window.postMessage).toHaveBeenCalled();
            const payload = window.postMessage.mock.calls[0][0].payload;

            // Must match dashTier derived value (in kbps)
            expect(payload.bitrate).toBe(3000);
            expect(payload.bitrate).not.toBe(4100);
            expect(payload.isEstimated).toBe(false);
        });

        test('Should fallback to estimation for unknown streams (Live/Limited)', () => {
            setAvailableRepresentations([]); // No manifest

            analyzeUrl('https://host/path/_4500/seg_1.m4s');

            const payload = window.postMessage.mock.calls[0][0].payload;

            // 4500 kbps tier
            expect(payload.bitrate).toBe(4500);
            expect(payload.resolution).toBe('1080p'); // Estimated via BITRATE_RESOLUTION_MAP
            expect(payload.isEstimated).toBe(true);
        });
    });

    // --- 4. Live/Limited Stream Handling ---
    describe('Live/Limited Streams', () => {
        test('Should not crash on Live streams without manifest', () => {
            setAvailableRepresentations([]);

            const input = 'https://live-ak.paramountplus.com/live/stream/seg-100.m4s';
            const result = maybeRewriteUrl(input);

            // If no reps, we return original URL
            expect(result).toBe(input);

            // Analyze should still report something if possible, or just safely exit
            analyzeUrl(input);
            // If URL pattern doesn't match our specific DASH patterns, it might not report anything, 
            // but crucial is it doesn't throw.
        });
    });

});
