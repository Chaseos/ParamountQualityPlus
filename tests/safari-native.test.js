import { jest } from '@jest/globals';
import { TextEncoder } from 'node:util';
import { createNativeMaster } from '../platforms/safari/native-master.js';
import { NativeHlsSession } from '../platforms/safari/native-session.js';
import { parseHlsManifest } from '../injected/manifest-parser.js';
import { getRepresentations, setRepresentations } from '../injected/state.js';
import { selectRepresentation } from '../injected/stream-model.js';

globalThis.TextEncoder = TextEncoder;
test('native discovery invokes the browser fetch with its global receiver', async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = jest.fn(function () {
        if (this !== globalThis) throw new TypeError('Invalid fetch receiver');
        return Promise.resolve({ ok: true, url: original, text: async () => master });
    });
    const session = new NativeHlsSession(new Video(), { parseManifest: parse, select: () => null });
    try {
        await session.load();
        expect(session.failed).toBe(false);
        expect(session.representations).toHaveLength(2);
    } finally {
        session.dispose();
        globalThis.fetch = previous;
    }
});
const original = 'https://media.example.test/program/master.m3u8?session=test';
const master = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://example/content",KEYFORMAT="com.apple.streamingkeydelivery"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",URI="audio.m3u8?signature=keep%2Bthis"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Español",LANGUAGE="es",URI="subtitles.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio",SUBTITLES="subs"
360.m3u8?signature=low%2Bquality
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio",SUBTITLES="subs"
1080.m3u8?signature=high%2Bquality
`;
const decode = uri => Buffer.from(uri.split(',')[1], 'base64').toString('utf8');
const parse = (text, url) => { setRepresentations([]); parseHlsManifest(text, url); return getRepresentations(); };
const audio = () => [{ language: 'en', label: 'English', enabled: true }];

class Video extends EventTarget {
    constructor() {
        super();
        this._src = original;
        this.currentSrc = original;
        this.isConnected = true;
        this.currentTime = 120;
        this.duration = 3600;
        this.readyState = 4;
        this.videoHeight = 1080;
        this.paused = false;
        this.playbackRate = 1.25;
        this.audioTracks = audio();
        this.textTracks = [{ language: 'es', label: 'Español', mode: 'showing' }];
        this.seekable = { length: 1, start: () => 0, end: () => 3600 };
        this.assignments = [];
        this.play = jest.fn(async () => { this.paused = false; });
        this.pause = jest.fn(() => { this.paused = true; });
    }
    get src() { return this._src; }
    set src(value) {
        this._src = value;
        this.currentSrc = value;
        this.assignments.push(value);
        this.readyState = 0;
        this.videoHeight = 0;
        this.currentTime = 0;
        this.audioTracks = [];
    }
    metadata() { this.readyState = 1; this.dispatchEvent(new Event('loadedmetadata')); }
    decoded(height, tracks = audio()) {
        this.readyState = 4;
        this.videoHeight = height;
        this.audioTracks = tracks;
        this.dispatchEvent(new Event('canplay'));
    }
}

function fixture(initialConfig = {}) {
    const video = new Video();
    let config = initialConfig;
    const notify = jest.fn();
    const fetchMaster = jest.fn(async () => ({ ok: true, url: original, text: async () => master }));
    const session = new NativeHlsSession(video, {
        parseManifest: parse, select: reps => selectRepresentation(reps, config), fetchMaster, notify
    });
    return { video, session, notify, fetchMaster, configure: value => { config = value; } };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('Safari reuses the shared manifest ladder and keeps audio, captions, DRM and signed rendition URLs', () => {
    const reps = parse(master, original);
    expect(reps.map(rep => rep.height)).toEqual([1080, 360]);
    const selected = selectRepresentation(reps, { forcedHeight: 360 });
    const result = decode(createNativeMaster(master, original, selected));
    expect(result.match(/#EXT-X-STREAM-INF/g)).toHaveLength(1);
    expect(result).toContain('https://media.example.test/program/360.m3u8?signature=low%2Bquality');
    expect(result).not.toContain('1080.m3u8');
    expect(result).toContain('URI="https://media.example.test/program/audio.m3u8?signature=keep%2Bthis"');
    expect(result).toContain('NAME="Español"');
    expect(result).toContain('URI="skd://example/content"');
    expect(result).toContain('SUBTITLES="subs"');
});

test('unrecognized or unsafe masters fail before changing playback', () => {
    const selected = parse(master, original)[0];
    for (const invalid of ['#EXTM3U\n#EXTINF:6\nsegment.ts', master + '#EXT-X-DEFINE:NAME="x",VALUE="y"',
        master + '#EXT-X-CONTENT-STEERING:SERVER-URI="steering.json"', master.replace('skd://example/content', 'javascript:alert(1)')]) {
        expect(() => createNativeMaster(invalid, original, selected)).toThrow();
    }
    expect(() => createNativeMaster(master, original, { variantUrl: 'https://unrelated.example/video.m3u8' })).toThrow();
});

test('Auto discovers the native ladder without replacing the original source', async () => {
    const { session, video, fetchMaster } = fixture();
    await session.load();
    expect(session.representations).toHaveLength(2);
    expect(video.assignments).toHaveLength(0);
    expect(fetchMaster).toHaveBeenCalledTimes(1);
    session.dispose();
});

test('manual switch restores position and rate and cannot report success after losing audio', async () => {
    const { session, video, notify } = fixture({ forcedHeight: 360 });
    await session.load();
    expect(session.switching).toBe(true);
    video.metadata();
    expect(video.currentTime).toBe(120);
    expect(video.playbackRate).toBe(1.25);
    video.decoded(360, []);
    expect(session.switching).toBe(true);
    video.decoded(360);
    expect(session.switching).toBe(false);
    expect(session.applied).toBe(360);
    expect(notify).toHaveBeenLastCalledWith('ready');
    session.dispose();
});

test('queued selection is applied after the active switch, and Auto restores the exact original URL', async () => {
    const { session, video, configure } = fixture({ forcedHeight: 360 });
    await session.load();
    configure({ forceMax: true });
    session.apply();
    expect(video.assignments).toHaveLength(1);
    video.metadata(); video.decoded(360);
    expect(video.assignments).toHaveLength(2);
    expect(decode(video.src)).toContain('1080.m3u8?signature=high%2Bquality');
    video.metadata(); video.decoded(1080);
    configure({}); session.apply();
    expect(video.src).toBe(original);
    video.metadata(); video.decoded(720);
    expect(session.applied).toBeNull();
    session.dispose();
});

test('an obsolete play rejection cannot roll back a newer queued quality switch', async () => {
    const { session, video, configure } = fixture({ forcedHeight: 360 });
    let rejectOldPlay;
    video.play.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOldPlay = reject; }));
    await session.load();
    video.metadata();
    configure({ forceMax: true });
    video.decoded(360);
    const latestSource = video.src;
    rejectOldPlay(new DOMException('Source replaced by the next selection', 'AbortError'));
    await Promise.resolve();
    const observed = { source: video.src, failed: session.failed, switching: session.switching };
    video.metadata(); video.decoded(1080);
    const applied = session.applied;
    session.dispose();
    expect(observed).toEqual({ source: latestSource, failed: false, switching: true });
    expect(applied).toBe(1080);
});

test('native errors restore original playback without retry loops; an explicit selection can retry', async () => {
    const { session, video, notify } = fixture({ forcedHeight: 360 });
    await session.load();
    video.dispatchEvent(new Event('error'));
    expect(video.src).toBe(original);
    expect(notify).toHaveBeenLastCalledWith('failed');
    video.metadata(); video.decoded(1080);
    session.apply();
    expect(video.assignments).toHaveLength(2);
    session.apply({ retry: true });
    expect(video.assignments).toHaveLength(3);
    session.dispose();
});

test('caption surfaces are refreshed before source replacement, including rollback, but not during Auto discovery', async () => {
    const { session, video, configure } = fixture();
    const destroyedSources = [];
    const settings = { mode: 'hidden', language: 'es' };
    const adapter = {
        video, getId: () => 'html5', context: { textTrackSettings: settings }, textTracks: [],
        createTextTrackSurface: jest.fn(() => ({ destroy: () => destroyedSources.push(video.src) }))
    };
    adapter.textTrackSurface = adapter.createTextTrackSurface();
    video.player = { getAdapter: () => adapter };
    await session.load();
    expect(destroyedSources).toEqual([]);
    configure({ forcedHeight: 360 });
    session.apply();
    const selectedSource = video.src;
    expect(destroyedSources).toEqual([original]);
    video.dispatchEvent(new Event('error'));
    expect(destroyedSources).toEqual([original, selectedSource]);
    expect(video.src).toBe(original);
    expect(settings).toEqual({ mode: 'hidden', language: 'es' });
    session.dispose();
});

test('paused playback stays paused and live switching preserves distance from the live edge', async () => {
    const { session, video } = fixture({ forcedHeight: 360 });
    video.paused = true;
    video.duration = Infinity;
    video.currentTime = 3590;
    await session.load();
    video.seekable.end = () => 3700;
    video.metadata(); video.decoded(360);
    expect(video.currentTime).toBe(3690);
    expect(video.paused).toBe(true);
    expect(video.play).not.toHaveBeenCalled();
    session.dispose();
});

test('failed loads remain retryable and a site-owned source change is never overwritten', async () => {
    const { session, video, fetchMaster } = fixture({ forcedHeight: 360 });
    fetchMaster.mockRejectedValueOnce(new Error('offline'));
    await session.load();
    expect(session.failed).toBe(true);
    session.apply({ retry: true });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(fetchMaster).toHaveBeenCalledTimes(2);
    expect(session.representations).toHaveLength(2);
    video.src = 'https://media.example.test/next-episode/master.m3u8';
    const count = video.assignments.length;
    video.dispatchEvent(new Event('error'));
    session.apply();
    expect(video.assignments).toHaveLength(count);
    session.dispose();
});

test('concurrent discovery is coalesced and disposal discards stale manifest results', async () => {
    const { session, fetchMaster, video } = fixture({ forceMax: true });
    let resolve;
    fetchMaster.mockImplementation(() => new Promise(done => { resolve = done; }));
    const first = session.load();
    await session.load();
    expect(fetchMaster).toHaveBeenCalledTimes(1);
    session.dispose();
    resolve({ ok: true, url: original, text: async () => master });
    await first;
    expect(video.assignments).toHaveLength(0);
});

test('an empty native playlist stays retryable instead of caching an unusable master', async () => {
    const { session, fetchMaster } = fixture();
    fetchMaster.mockResolvedValueOnce({ ok: true, url: original, text: async () => '#EXTM3U' });
    await session.load();
    expect(session.master).toBeNull();
    session.apply({ retry: true });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(fetchMaster).toHaveBeenCalledTimes(2);
    expect(session.representations).toHaveLength(2);
    session.dispose();
});
