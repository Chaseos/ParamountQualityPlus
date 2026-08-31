import { createNativeMaster } from './native-master.js';
import { prepareNativeCaptions } from './native-captions.js';

// Own only the source assigned by this session. A site navigation or ad must
// never be replaced with an old episode's signed URL.
export class NativeHlsSession {
    constructor(video, { parseManifest, select, fetchMaster = (url, options) => globalThis.fetch(url, options), notify = () => {} }) {
        this.video = video;
        this.original = video.src || video.currentSrc;
        this.expected = this.original;
        this.parseManifest = parseManifest;
        this.select = select;
        this.fetchMaster = fetchMaster;
        this.notify = notify;
        this.representations = [];
        this.master = null;
        this.applied = null;
        this.failed = false;
        this.disposed = false;
        this.abort = new AbortController();
    }

    ownsSource() {
        const source = this.video.src || this.video.currentSrc;
        return !this.disposed && this.video.isConnected && source === this.expected;
    }

    async load() {
        if (this.loading || this.disposed) return;
        this.loading = true;
        this.notify('loading');
        const timeout = setTimeout(() => this.abort.abort(), 8000);
        try {
            const response = await this.fetchMaster(this.original, { signal: this.abort.signal });
            if (!response.ok) throw new Error('Manifest request failed');
            const master = await response.text();
            if (!this.ownsSource()) return;
            if (master.length > 1024 * 1024 || !master.trimStart().startsWith('#EXTM3U')) {
                throw new Error('Invalid native master');
            }
            this.master = master;
            this.representations = this.parseManifest(master, response.url || this.original);
            // Resolve relative rendition/track paths against a redirect's final URL.
            this.masterURL = response.url || this.original;
            if (!this.representations.length) throw new Error('No native renditions');
            this.notify('ready');
            this.apply();
        } catch {
            if (this.ownsSource()) {
                this.master = null;
                this.representations = [];
                this.failed = true;
                this.notify('failed');
            }
        } finally {
            clearTimeout(timeout);
            this.loading = false;
        }
    }

    apply({ retry = false } = {}) {
        if (!this.ownsSource() || this.video.player?.isAd || this.switching) return;
        if (retry) this.failed = false;
        if (this.failed) return;
        if (!this.master) {
            if (retry) {
                this.abort = new AbortController();
                void this.load();
            }
            return;
        }
        const target = this.select(this.representations);
        const height = target?.height || null;
        if (height === this.applied) return;
        try {
            const source = target ? createNativeMaster(this.master, this.masterURL, target) : this.original;
            this.switchSource(source, height);
        } catch {
            this.failed = true;
            this.notify('failed');
        }
    }

    switchSource(source, height) {
        const video = this.video;
        const snapshot = {
            time: video.currentTime, paused: video.paused, rate: video.playbackRate,
            liveOffset: !Number.isFinite(video.duration) && video.seekable.length
                ? video.seekable.end(video.seekable.length - 1) - video.currentTime : null,
            audio: Array.from(video.audioTracks || []).find(track => track.enabled),
            captions: Array.from(video.textTracks || []).filter(track => track.mode === 'showing')
        };
        let restored = false;
        let rollingBack = false;
        let playerCaptions = false;
        let finished = false;
        this.switching = true;
        this.notify('switching');

        const finish = () => {
            finished = true;
            clearTimeout(timeout);
            clearTimeout(this.recoveryTimeout);
            for (const event of events) video.removeEventListener(event, inspect);
            this.cancelSwitch = null;
            this.switching = false;
        };
        const restore = () => {
            let time = snapshot.time;
            if (snapshot.liveOffset !== null && video.seekable.length) {
                time = video.seekable.end(video.seekable.length - 1) - snapshot.liveOffset;
            }
            if (Number.isFinite(time)) video.currentTime = Math.max(0, time);
            video.playbackRate = snapshot.rate;
            restored = true;
            if (snapshot.paused) video.pause();
            else void video.play().catch(fail);
        };
        const fail = () => {
            // Replacing src for a queued selection can reject the previous play().
            if (finished) return;
            if (!this.ownsSource()) { finish(); return; }
            this.failed = true;
            this.notify('failed');
            if (rollingBack) { finish(); return; }
            rollingBack = true;
            restored = false;
            this.applied = null;
            this.expected = this.original;
            playerCaptions = prepareNativeCaptions(video);
            video.src = this.original;
        };
        const inspect = event => {
            if (!this.ownsSource()) { finish(); return; }
            if (event.type === 'error') { fail(); return; }
            try {
                if (!restored && video.readyState >= 1) restore();
                if (video.readyState < 2 || !video.videoHeight) return;
                const audio = Array.from(video.audioTracks || []);
                if (snapshot.audio && !audio.length) return;
                const selectedAudio = audio.find(track => track.language === snapshot.audio?.language &&
                    track.label === snapshot.audio?.label);
                if (selectedAudio) selectedAudio.enabled = true;
                for (const track of playerCaptions ? [] : Array.from(video.textTracks || [])) {
                    if (snapshot.captions.some(saved => saved.language === track.language && saved.label === track.label)) {
                        track.mode = 'showing';
                    }
                }
                if (!rollingBack && height && video.videoHeight !== height) return;
                this.applied = rollingBack ? null : height;
                finish();
                if (!rollingBack) {
                    this.notify('ready');
                    // A second selection may have arrived while the source was loading.
                    this.apply();
                }
            } catch { fail(); }
        };
        const events = ['loadedmetadata', 'loadeddata', 'canplay', 'resize', 'timeupdate', 'error'];
        for (const event of events) video.addEventListener(event, inspect);
        const timeout = setTimeout(() => {
            fail();
            // Allow original playback to recover, but never leave listeners alive indefinitely.
            if (this.switching) this.recoveryTimeout = setTimeout(finish, 15000);
        }, 20000);
        this.cancelSwitch = finish;
        this.expected = source;
        playerCaptions = prepareNativeCaptions(video);
        video.src = source;
    }

    dispose() {
        this.disposed = true;
        this.abort.abort();
        this.cancelSwitch?.();
        clearTimeout(this.recoveryTimeout);
        this.master = null;
        this.representations = [];
    }
}
