import { NativeHlsSession } from './native-session.js';

export function initNativeHls({ parseHlsManifest, getRepresentations, getConfig, selectRepresentation }) {
    let session = null;
    let phase = 'loading';
    const publish = () => {
        if (!session || session.video.player?.isAd) return;
        const height = session.video.videoHeight || null;
        const representation = session.representations.find(item => item.height === height);
        window.postMessage({ type: 'PQI_SAFARI_NATIVE_STATE', payload: {
            active: true, phase, height,
            // Native segment requests are invisible to JS. This is the advertised
            // manifest bandwidth, never a claim of measured network throughput.
            bitrate: representation?.bandwidth ? Math.round(representation.bandwidth / 1000) : null
        } }, '*');
    };
    const reset = () => {
        if (!session) return;
        session.dispose();
        session = null;
        window.postMessage({ type: 'PQI_SAFARI_NATIVE_STATE', payload: { active: false } }, '*');
    };
    const tick = () => {
        const videos = Array.from(document.querySelectorAll('video'));
        const video = videos.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
        if (session && (session.video !== video || !session.ownsSource())) reset();
        if (!video || video.player?.isAd) return;
        if (!session) {
            if (video.readyState < 1) return;
            let url;
            try { url = new URL(video.currentSrc || video.src); } catch { return; }
            if (url.protocol !== 'https:' || !/\.m3u8$/i.test(url.pathname)) return;
            const candidate = new NativeHlsSession(video, {
                parseManifest: (master, source) => {
                    parseHlsManifest(master, source);
                    return [...getRepresentations()];
                },
                select: representations => selectRepresentation(representations, getConfig()),
                notify: state => {
                    if (session !== candidate) return;
                    phase = state;
                    publish();
                }
            });
            session = candidate;
            void session.load();
        }
        session.apply();
        publish();
    };
    const configChanged = event => {
        if (event.source !== window || event.data?.type !== 'PQI_CONFIG') return;
        session?.apply({ retry: true });
    };
    window.addEventListener('message', configChanged);
    // One bounded poll also notices site-owned src/element changes, ad completion,
    // decoded resolution changes and popup reopening, without patching DOM APIs.
    let interval = setInterval(tick, 1000);
    tick();
    window.addEventListener('pagehide', event => {
        clearInterval(interval);
        if (!event.persisted) {
            window.removeEventListener('message', configChanged);
            reset();
        }
    });
    window.addEventListener('pageshow', event => {
        if (event.persisted) {
            clearInterval(interval);
            interval = setInterval(tick, 1000);
            tick();
        }
    });
}
