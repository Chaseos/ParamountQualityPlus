import { jest } from '@jest/globals';

let parseManifest;
let getAvailableRepresentations;
let setAvailableRepresentations;

beforeAll(async () => {
    const api = await import('../injected/index.js');
    ({
        parseManifest,
        getAvailableRepresentations,
        setAvailableRepresentations,
    } = api);
});

// --- Mocks & Setup ---
window.fetch = jest.fn();
window.postMessage = jest.fn();
window.addEventListener = jest.fn();

global.DOMParser = class {
    parseFromString(str) {
        const createNode = (tagName, attrs = '', content = '', parent = null) => {
            const node = {
                tagName,
                localName: tagName,
                parentNode: parent,
                textContent: content.trim(),
                getAttribute: (name) => {
                    const m = attrs.match(new RegExp(`${name}="([^"]+)"`));
                    return m ? m[1] : null;
                },
                getElementsByTagNameNS: (ns, tag) => {
                    if (tag === 'Representation') {
                        const reps = [];
                        const regex = /<Representation\s+([^>]+)>(?:([\s\S]*?)<\/Representation>)?/g;
                        let m;
                        while ((m = regex.exec(content)) !== null) {
                            reps.push(createNode('Representation', m[1], m[2] || '', node));
                        }
                        return reps;
                    }
                    if (tag === 'SegmentTemplate') {
                        const m = content.match(/<SegmentTemplate\s+([^>]+)>/);
                        if (m) {
                            return [{
                                getAttribute: (name) => {
                                    const am = m[1].match(new RegExp(`${name}="([^"]+)"`));
                                    return am ? am[1] : null;
                                }
                            }];
                        }
                    }
                    if (tag === 'BaseURL') {
                        const m = content.match(/<BaseURL>([^<]+)<\/BaseURL>/);
                        if (m) return [{ textContent: m[1] }];
                    }
                    return [];
                },
                getElementsByTagName: (tag) => node.getElementsByTagNameNS('*', tag)
            };
            return node;
        };

        const root = {
            getElementsByTagNameNS: (ns, tag) => {
                if (tag === 'Period') {
                    const m = str.match(/<Period\s*([^>]*)>([\s\S]*?)<\/Period>/);
                    return m ? [createNode('Period', m[1], m[2])] : [];
                }
                if (tag === 'AdaptationSet') {
                    const sets = [];
                    const regex = /<AdaptationSet\s+([^>]+)>([\s\S]*?)<\/AdaptationSet>/g;
                    let m;
                    while ((m = regex.exec(str)) !== null) {
                        sets.push(createNode('AdaptationSet', m[1], m[2]));
                    }
                    return sets;
                }
                if (tag === 'Representation') {
                    const reps = [];
                    const regex = /<Representation\s+([^>]+)>(?:([\s\S]*?)<\/Representation>)?/g;
                    let m;
                    while ((m = regex.exec(str)) !== null) {
                        reps.push(createNode('Representation', m[1], m[2] || ''));
                    }
                    return reps;
                }
                return [];
            },
            getElementsByTagName: (tag) => root.getElementsByTagNameNS('*', tag),
            querySelectorAll: (tag) => root.getElementsByTagNameNS('*', tag),
            querySelector: (tag) => {
                const res = root.getElementsByTagNameNS('*', tag);
                return res.length > 0 ? res[0] : null;
            }
        };
        return root;
    }
};

describe('Manifest Parsing', () => {

    beforeEach(() => {
        setAvailableRepresentations([]);
        window.postMessage.mockClear();
    });

    test('Should parse Type B (Bitrate-Based) manifests', () => {
        const xml = `
            <MPD>
                <Period>
                    <AdaptationSet mimeType="video/mp4">
                        <SegmentTemplate media="video/$RepresentationID$/seg_$Number$.m4s" />
                        <Representation id="rep_a" width="1920" height="1080" bandwidth="5800000" />
                    </AdaptationSet>
                </Period>
            </MPD>
        `;
        parseManifest(xml, 'http://example.com/manifest.mpd');
        const reps = getAvailableRepresentations();

        expect(reps.length).toBe(1);
        expect(reps[0].dashTier).toBe('5800');
        expect(reps[0].height).toBe(1080);
    });

    test('Should parse Type A (Resolution-Based) manifests and preserve resolution', () => {
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
        parseManifest(xml, 'http://example.com/manifest.mpd');
        const reps = getAvailableRepresentations();
        expect(reps[0].height).toBe(234);
    });

    test('Should prioritize Movie content over Ads (Path Collision)', () => {
        const manifest = `
            <MPD>
                <Period>
                    <AdaptationSet contentType="video" mimeType="video/mp4">
                        <Representation id="5" bandwidth="5093000" width="1920" height="1080">
                            <BaseURL>https://dai.google.com/5093/</BaseURL>
                        </Representation>
                    </AdaptationSet>
                    <AdaptationSet contentType="video" mimeType="video/mp4">
                        <Representation id="movie_1080" bandwidth="5577000" width="1920" height="1080">
                            <BaseURL>CONTENT_FEATURE_4K_c26_1080p_1234567_5577/</BaseURL>
                        </Representation>
                    </AdaptationSet>
                </Period>
            </MPD>
        `;
        parseManifest(manifest, 'movie.mpd');
        const reps = getAvailableRepresentations();
        expect(reps.length).toBe(1);
        expect(reps[0].pathId).toBe('CONTENT_FEATURE_4K_c26_1080p_1234567_5577');
    });

    test('Should prioritize Features over Ads in complex paths', () => {
        const manifest = `
            <MPD>
                <Period>
                    <AdaptationSet contentType="video" mimeType="video/mp4">
                        <Representation id="ad_1080" bandwidth="4036000" width="1920" height="1080">
                            <BaseURL>https://r1.googlevideo.com/videoplayback?source=dclk_video_ads</BaseURL>
                        </Representation>
                    </AdaptationSet>
                    <AdaptationSet contentType="video" mimeType="video/mp4">
                        <Representation id="rep_1080" bandwidth="3000000" width="1920" height="1080">
                            <BaseURL>ExampleMovie_1920x1080_Feature_8CH_1234567_3000/</BaseURL>
                        </Representation>
                    </AdaptationSet>
                </Period>
            </MPD>
        `;
        parseManifest(manifest, 'example.mpd');
        const reps = getAvailableRepresentations();
        expect(reps.length).toBe(1);
        expect(reps[0].id).toBe('s1-rep_1080');
    });

    test('Should handle ID collisions across AdaptationSets using prefixing', () => {
        const manifest = `
            <MPD>
                <Period>
                    <AdaptationSet contentType="video" mimeType="video/mp4">
                        <Representation id="1" bandwidth="500000" width="416" height="234" />
                    </AdaptationSet>
                    <AdaptationSet contentType="video" mimeType="video/mp4">
                        <Representation id="1" bandwidth="1500000" width="854" height="480" />
                    </AdaptationSet>
                </Period>
            </MPD>
        `;
        parseManifest(manifest, 'multi.mpd');
        const reps = getAvailableRepresentations();
        expect(reps.find(r => r.height === 234).id).toBe('s0-1');
        expect(reps.find(r => r.height === 480).id).toBe('s1-1');
    });

    test('Should filter out Ads if valid Content is present', () => {
        const manifest = `
            <MPD>
                <Period>
                    <AdaptationSet contentType="video" mimeType="video/mp4">
                        <Representation id="ad" bandwidth="150000" width="360" height="200">
                            <BaseURL>https://r1.googlevideo.com/videoplayback?source=dclk_video_ads</BaseURL>
                        </Representation>
                        <Representation id="movie" bandwidth="200000" width="416" height="234">
                            <BaseURL>1234567_cenc_precon_dash/234p/</BaseURL>
                        </Representation>
                    </AdaptationSet>
                </Period>
            </MPD>
        `;
        parseManifest(manifest, 'filter.mpd');
        const reps = getAvailableRepresentations();
        expect(reps.length).toBe(1);
        expect(reps[0].height).toBe(234);
    });

    test('Should recognize FTR/VMASTER markers in movie paths', () => {
        const manifest = `
            <MPD>
                <Period>
                    <AdaptationSet contentType="video" mimeType="video/mp4">
                        <Representation id="0" bandwidth="154000" width="360" height="200">
                            <SegmentTemplate media="$Number$.mp4?orig=https://googlevideo.com/videoplayback?source=dclk_video_ads" />
                        </Representation>
                        <Representation id="0" bandwidth="155418" width="416" height="234">
                            <SegmentTemplate media="AnotherMovie_FTR_VMASTER_engUS_110/seg_$Number$.m4s" />
                        </Representation>
                    </AdaptationSet>
                </Period>
            </MPD>
        `;
        parseManifest(manifest, 'movie.mpd');
        const reps = getAvailableRepresentations();
        expect(reps.length).toBe(1);
        expect(reps[0].height).toBe(234);
    });

    test('Should support \'video 2\' AdaptationSets and Sports markers', () => {
        const manifest = `
            <MPD>
                <Period>
                    <AdaptationSet contentType="video" mimeType="video/mp4">
                        <Representation id="0" bandwidth="155418" width="416" height="234">
                            <SegmentTemplate media="Sports_Event_Replay_engUS/seg_$Number$.m4s" />
                        </Representation>
                    </AdaptationSet>
                    <AdaptationSet contentType="video 2" mimeType="video/mp4">
                        <Representation id="1" bandwidth="6000000" width="1920" height="1080">
                            <SegmentTemplate media="Sports_Event_Replay_engUS_1080/seg_$Number$.m4s" />
                        </Representation>
                    </AdaptationSet>
                </Period>
            </MPD>
        `;
        parseManifest(manifest, 'sports.mpd');
        const reps = getAvailableRepresentations();
        expect(reps.length).toBe(2);
        expect(reps[0].height).toBe(1080);
    });
});
