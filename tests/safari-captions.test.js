import { jest } from '@jest/globals';
import { prepareNativeCaptions } from '../platforms/safari/native-captions.js';

class Track extends EventTarget {
    constructor(language = 'en') {
        super();
        Object.assign(this, { language, label: language, kind: 'subtitles', mode: 'disabled', activeCues: [] });
    }
    cue(text) {
        this.activeCues = [{ text }];
        this.dispatchEvent(new Event('cuechange'));
    }
}

function fixture(mode = 'hidden', language = 'en') {
    const tracks = Object.assign(new EventTarget(), { items: [], [Symbol.iterator]() { return this.items.values(); } });
    const settings = { mode, language };
    const render = jest.fn();
    const video = { textTracks: tracks, querySelector: () => null };
    const surfaces = [];
    const adapter = {
        video, getId: () => 'html5', context: { textTrackSettings: settings }, textTracks: [],
        createTextTrackSurface() {
            // Contract fixture: a surface caches identities, owns cue listeners,
            // and reads the player's live preferences when tracks arrive.
            const connected = new Set();
            const cue = event => {
                if (settings.mode !== 'disabled' && event.target.language === settings.language) render(event.target.activeCues);
            };
            const add = () => {
                for (const track of tracks) {
                    if ([...connected].some(old => old.language === track.language)) continue;
                    connected.add(track);
                    adapter.textTracks.push({ language: track.language });
                    track.addEventListener('cuechange', cue);
                    if (track.language === settings.language) track.mode = settings.mode;
                }
            };
            tracks.addEventListener('addtrack', add);
            const surface = { destroy: jest.fn(() => {
                tracks.removeEventListener('addtrack', add);
                for (const track of connected) track.removeEventListener('cuechange', cue);
            }) };
            surfaces.push(surface);
            return surface;
        }
    };
    video.player = { getAdapter: role => role === 'playback' ? adapter : null };
    adapter.textTrackSurface = adapter.createTextTrackSurface();
    const add = (...newTracks) => {
        tracks.items.push(...newTracks);
        tracks.dispatchEvent(new Event('addtrack'));
    };
    const original = new Track(language);
    add(original);
    const switchSource = () => { prepareNativeCaptions(video); tracks.items = []; };
    const cleanup = () => adapter.textTrackSurface.destroy();
    return { video, adapter, tracks, original, settings, render, surfaces, add, switchSource, cleanup };
}

test('replacement hidden tracks reconnect cues to the existing renderer in the selected language', () => {
    const f = fixture('hidden', 'es');
    f.original.cue('before');
    f.switchSource();
    const english = new Track('en'), spanish = new Track('es');
    f.add(english, spanish);
    spanish.cue('after');
    expect(spanish.mode).toBe('hidden');
    expect(f.render.mock.calls.map(([cues]) => cues[0].text)).toEqual(['before', 'after']);
    f.original.cue('stale');
    expect(f.render).toHaveBeenCalledTimes(2);
    expect(f.settings).toEqual({ mode: 'hidden', language: 'es' });
    f.cleanup();
});

test('late subtitles reconnect after playback readiness without a restoration timer', async () => {
    const f = fixture();
    f.switchSource();
    await Promise.resolve();
    const late = new Track();
    f.add(late);
    late.cue('late dialogue');
    expect(f.render).toHaveBeenCalledWith([{ text: 'late dialogue' }]);
    f.cleanup();
});

test.each(['hidden', 'showing', 'disabled'])('current %s state and changes to Off/language during loading are respected', mode => {
    const f = fixture(mode);
    f.switchSource();
    f.settings.mode = 'disabled';
    f.settings.language = 'es';
    const spanish = new Track('es');
    f.add(new Track(), spanish);
    spanish.cue('off');
    expect(spanish.mode).toBe('disabled');
    expect(f.render).not.toHaveBeenCalled();
    // Site-owned controls can turn captions back on after the switch.
    f.settings.mode = 'hidden';
    spanish.cue('enabled later');
    expect(f.render).toHaveBeenCalledTimes(1);
    f.cleanup();
});

test('repeated switches (including rollback/Auto) do not duplicate track entries or cue listeners', () => {
    const f = fixture();
    for (let index = 0; index < 4; index++) {
        f.switchSource();
        const track = new Track();
        f.add(track);
        track.cue(String(index));
        expect(f.adapter.textTracks).toHaveLength(1);
        expect(f.render).toHaveBeenCalledTimes(index + 1);
    }
    expect(f.surfaces.slice(0, -1).every(surface => surface.destroy.mock.calls.length === 1)).toBe(true);
    f.cleanup();
    f.tracks.items[0].cue('after site teardown');
    expect(f.render).toHaveBeenCalledTimes(4);
});

test.each(['other adapter', 'other video', 'ad', 'external track', 'external URL', 'missing factory'])('leaves %s untouched', reason => {
    const f = fixture();
    if (reason === 'other adapter') f.adapter.getId = () => 'dash';
    if (reason === 'other video') f.adapter.video = {};
    if (reason === 'ad') f.video.player.isAd = true;
    if (reason === 'external track') f.video.querySelector = () => ({});
    if (reason === 'external URL') f.adapter.context.resource = { location: { textTrackUrl: 'https://example.test/captions.vtt' } };
    if (reason === 'missing factory') f.adapter.createTextTrackSurface = undefined;
    expect(prepareNativeCaptions(f.video)).toBe(false);
    expect(f.surfaces).toHaveLength(1);
    f.original.cue('still connected');
    expect(f.render).toHaveBeenCalledTimes(1);
    f.cleanup();
});

test('missing/changed player APIs and factory failures do not throw or destroy working captions', () => {
    expect(prepareNativeCaptions({})).toBe(false);
    const f = fixture();
    f.adapter.createTextTrackSurface = () => { throw new Error('unsupported'); };
    expect(prepareNativeCaptions(f.video)).toBe(false);
    expect(f.surfaces[0].destroy).not.toHaveBeenCalled();
    f.original.cue('still connected');
    expect(f.render).toHaveBeenCalledTimes(1);
    f.cleanup();
});
