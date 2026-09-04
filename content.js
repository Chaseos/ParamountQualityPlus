(() => {
// Reopening/reinjecting an extension must not duplicate listeners or bootstrap.
if (globalThis.__PQP_CONTENT__) {
    globalThis.__PQP_CONTENT__.retryInjection();
    return;
}
let injectionFailed = false;
let latestInjectedConfig = null;
// ParamountPlusQualityController - Content Script

// State
let streamState = {
    resolution: null,
    bitrate: null, // kbps
    maxBitrate: null, // kbps
    timestamp: null,
    isEstimated: false, // true if resolution is estimated from bitrate
    qualitySource: null, // manifest or inferred
    hasActiveStream: false, // true if we're receiving segment data
    geolocationPermission: 'unknown',
    playbackDetected: false,
    recoveryActive: false,
    appliedConfig: null,
    manifestQualities: [],
    initializedAt: Date.now()
};
let lastDecodedHeight = null;
let lastPopupStateSignature = null;

function resetDisplayedQuality() {
    streamState.resolution = null;
    streamState.bitrate = null;
    streamState.maxBitrate = null;
    streamState.timestamp = null;
    streamState.isEstimated = false;
    streamState.hasActiveStream = false;
}

function resetStreamDisplay(streamKey = null) {
    resetDisplayedQuality();
    streamState.manifestQualities = [];
    streamState.manifestStreamKey = streamKey;
    streamState.requestStreamKey = streamKey;
    streamState.qualitySource = null;
    lastDecodedHeight = null;
}

function boundedStoredInteger(value, fallback, minimum, maximum) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizeStoredConfig(res = {}, recoverOriginalStream = false) {
    const forcedHeight = Number.parseInt(res.forcedHeight, 10);
    return {
        forceMax: recoverOriginalStream ? false : Boolean(res.forceMax),
        forcedId: recoverOriginalStream || typeof res.forcedId !== 'string' || !res.forcedId ? null : res.forcedId,
        forcedHeight: recoverOriginalStream || !Number.isFinite(forcedHeight) || forcedHeight <= 0 ? null : forcedHeight,
        enableRetries: res.enableRetries !== false,
        maxRetries: boundedStoredInteger(res.maxRetries, 3, 1, 10),
        enablePrefetch: res.enablePrefetch !== false,
        prefetchCount: boundedStoredInteger(res.prefetchCount, 5, 1, 20)
    };
}

function normalizeManifestQualities(payload) {
    if (!Array.isArray(payload)) return null;
    return payload.flatMap((quality, index) => {
        if (!quality || typeof quality !== 'object') return [];
        const height = Number.parseInt(quality.height, 10);
        const bandwidth = Number(quality.bandwidth);
        if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(bandwidth) || bandwidth < 0) return [];
        return [{
            id: typeof quality.id === 'string' ? quality.id : String(quality.id ?? `quality-${index}`),
            height,
            bandwidth,
            streamKey: typeof quality.streamKey === 'string' ? quality.streamKey : null
        }];
    }).slice(0, 20);
}

const PENDING_CONFIG_KEY = 'pqiPendingQualityConfig';
const ORIGINAL_STREAM_RECOVERY_KEY = 'pqiOriginalStreamRecovery';
let recoveryReloadRequested = false;

function detectPlaybackContext() {
    const player = document.querySelector('video, [class*="player"], [id*="player"], [data-testid*="player"]');
    const path = window.location.pathname.toLowerCase();
    const playbackPath = /\/(video|live|live-tv)\b/.test(path) || /\/sports\/.*\b(live|watch|stream)\b/.test(path);

    return Boolean(player || playbackPath);
}

function isLivePlaybackPath(path = window.location.pathname) {
    const normalized = path.toLowerCase();
    return normalized.includes('/live-tv/') || normalized.includes('/live/') ||
        /\/sports\/.*\/(?:live|watch|stream)\b/.test(normalized);
}

function getDecodedPlaybackQuality() {
    if (!streamState.hasActiveStream || typeof document.querySelectorAll !== 'function') return null;

    const videos = Array.from(document.querySelectorAll('video'))
        .filter(video => Number(video.videoHeight) > 0 && Number(video.readyState) >= 2)
        .sort((first, second) => {
            if (Boolean(first.paused) !== Boolean(second.paused)) return first.paused ? 1 : -1;
            return (Number(second.videoWidth) * Number(second.videoHeight)) -
                (Number(first.videoWidth) * Number(first.videoHeight));
        });
    const video = videos[0];
    if (!video) return null;

    const height = Number.parseInt(video.videoHeight, 10);
    const manifestMatch = streamState.manifestQualities.find(quality => quality.height === height);
    return {
        height,
        bitrate: manifestMatch ? Math.round(manifestMatch.bandwidth / 1000) : null
    };
}

function getStreamStateSnapshot() {
    const state = { ...streamState, playbackDetected: detectPlaybackContext() };
    const decoded = getDecodedPlaybackQuality();
    if (!decoded) return state;

    state.resolution = `${decoded.height}p`;
    if (decoded.bitrate) state.bitrate = decoded.bitrate;
    state.isEstimated = false;
    state.qualitySource = 'decoded';

    if (decoded.height !== lastDecodedHeight) {
        lastDecodedHeight = decoded.height;
        console.info('[PQI checkpoint] decoded_resolution', decoded);
    }
    return state;
}

// --- Injection Logic ---
function injectScript() {
    injectionFailed = false;
    const script = document.createElement('script');
    script.type = 'module';
    script.src = chrome.runtime.getURL('injected/index.js');
    script.onload = function () {
        this.remove();
        // The module consumes the staged value before installing its network
        // hooks. Posting it again covers browsers where sessionStorage was
        // unavailable without reintroducing a startup Auto/Force Max race.
        if (latestInjectedConfig) {
            window.postMessage({ type: 'PQI_CONFIG', payload: latestInjectedConfig }, '*');
        }
    };
    script.onerror = () => { injectionFailed = true; script.remove(); };
    (document.head || document.documentElement).appendChild(script);

}

// --- Message Listening ---
window.addEventListener('message', (event) => {
    // We only accept messages from ourselves
    if (event.source !== window || !event.data || event.data.type !== 'PARAMOUNT_QUALITY_DATA') {
        return;
    }

    if (!event.data.payload || typeof event.data.payload !== 'object') return;

    let {
        resolution,
        bitrate,
        maxBitrate,
        timestamp,
        isEstimated,
        source,
        streamKey,
        observationSequence
    } = event.data.payload;

    if (Number.isFinite(observationSequence)) {
        if (observationSequence < (streamState.lastObservationSequence || 0)) return;
    }

    if (streamKey && streamState.requestStreamKey && streamKey !== streamState.requestStreamKey) {
        resetDisplayedQuality();
    }
    if (streamKey) streamState.requestStreamKey = streamKey;
    if (Number.isFinite(observationSequence)) streamState.lastObservationSequence = observationSequence;

    // Mark that we have an active stream
    streamState.hasActiveStream = true;

    // Replace a coarse bitrate estimate with an exact manifest match whenever
    // possible. Paramount ladders vary by title, so 2.74 Mbps may be 576p and
    // 1.59 Mbps may be 540p even when the global heuristic says otherwise.
    if ((!resolution || isEstimated) && bitrate && streamState.manifestQualities) {
        const bitrateBps = bitrate * 1000;
        const candidates = streamState.manifestQualities
            .filter(q => Number.isFinite(q.bandwidth) && q.bandwidth > 0)
            .map(q => ({ quality: q, difference: Math.abs(q.bandwidth - bitrateBps) }))
            .sort((a, b) => a.difference - b.difference);
        const closest = candidates[0];
        const tolerance = closest ? Math.max(75000, closest.quality.bandwidth * 0.05) : 0;
        const match = closest && closest.difference <= tolerance ? closest.quality : null;

        if (match) {
            resolution = match.height + 'p';
            isEstimated = false; // We found exact match in manifest
        }
    }

    // Network hooks only emit successful media responses and attach request
    // ordering, so a lower representation is just as authoritative as a
    // higher one. Artificially delaying downgrades made manual 234p appear as
    // the player's original 540p request indefinitely.
    if (resolution) {
        streamState.resolution = resolution;
        streamState.isEstimated = isEstimated || false;
        streamState.timestamp = timestamp;
    }

    // Always update bitrate to show current segment rate
    if (bitrate) streamState.bitrate = bitrate;
    if (maxBitrate) streamState.maxBitrate = maxBitrate;
    if (source) streamState.qualitySource = source;
});

window.addEventListener('message', (event) => {
    if (event.data?.type === 'PQI_MANIFEST_DATA') {
        console.info('[PQI checkpoint] ladder_message_observed', {
            sourceMatches: event.source === window,
            payloadIsArray: Array.isArray(event.data.payload),
            payloadCount: Array.isArray(event.data.payload) ? event.data.payload.length : null
        });
    }
    if (event.source === window && event.data) {
        if (event.data.type === 'PQI_MANIFEST_DATA') {
            const qualities = normalizeManifestQualities(event.data.payload);
            if (!qualities) {
                console.info('[PQI checkpoint] ladder_message_rejected', { reason: 'not-an-array' });
                return;
            }
            const manifestStreamKey = qualities[0]?.streamKey || null;
            if (manifestStreamKey && streamState.manifestStreamKey &&
                manifestStreamKey !== streamState.manifestStreamKey) {
                resetStreamDisplay(manifestStreamKey);
            }
            if (manifestStreamKey) streamState.manifestStreamKey = manifestStreamKey;
            streamState.manifestQualities = qualities;
            streamState.qualitySource = 'manifest';
            console.info('[PQI checkpoint] ladder_state_stored', {
                representationCount: qualities.length,
                maxHeight: qualities.length ? Math.max(...qualities.map(quality => quality.height)) : null,
                streamKey: manifestStreamKey
            });
            reconcileStoredQuality(qualities);
        } else if (event.data.type === 'PQI_STREAM_RESET') {
            const streamKey = typeof event.data.payload?.streamKey === 'string'
                ? event.data.payload.streamKey
                : null;
            resetStreamDisplay(streamKey);
        } else if (event.data.type === 'PQI_ACTIVE_QUALITY' && event.data.payload &&
            typeof event.data.payload === 'object') {
            // Update live stats from DAI variant playlist match
            const { resolution, bitrate, streamKey } = event.data.payload;
            if (streamKey && streamState.manifestStreamKey && streamKey !== streamState.manifestStreamKey) {
                return;
            }
            const configuredHeight = Number.parseInt(streamState.appliedConfig?.forcedHeight, 10) ||
                streamState.manifestQualities.find(q => q.id === streamState.appliedConfig?.forcedId)?.height || null;
            const observedHeight = Number.parseInt(resolution, 10);
            if (configuredHeight && observedHeight && configuredHeight !== observedHeight) {
                return;
            }
            if (resolution) streamState.resolution = resolution;
            if (bitrate) streamState.bitrate = bitrate;
            streamState.isEstimated = false; // Known from playlist URL match
            streamState.qualitySource = 'manifest';
            streamState.timestamp = Date.now();
        } else if (event.data.type === 'PQI_GEOLOCATION_PERMISSION') {
            streamState.geolocationPermission = event.data.payload?.state || 'unknown';
        } else if (event.data.type === 'PQI_ORIGINAL_STREAM_RECOVERY' && !recoveryReloadRequested) {
            recoveryReloadRequested = true;
            streamState.recoveryActive = true;
            streamState.appliedConfig = {
                forceMax: false,
                forcedId: null,
                forcedHeight: null
            };
            try {
                window.sessionStorage.setItem(ORIGINAL_STREAM_RECOVERY_KEY, '1');
            } catch (error) {
                console.warn('[PQI] Unable to stage original-stream recovery.', error);
            }
            window.location.reload();
        }
    }
});

// Listen for Popup requests
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'GET_STREAM_STATE') {
        const snapshot = getStreamStateSnapshot();
        const signature = `${snapshot.manifestQualities.length}:${snapshot.resolution || ''}:${snapshot.qualitySource || ''}`;
        if (signature !== lastPopupStateSignature) {
            lastPopupStateSignature = signature;
            console.info('[PQI checkpoint] popup_state_sent', {
                representationCount: snapshot.manifestQualities.length,
                resolution: snapshot.resolution,
                qualitySource: snapshot.qualitySource
            });
        }
        sendResponse(snapshot);
    } else if (request.type === 'REQUEST_GEOLOCATION_PERMISSION') {
        let didRespond = false;
        let timeoutId = null;

        const respondOnce = (payload) => {
            if (didRespond) return;
            didRespond = true;
            if (timeoutId) clearTimeout(timeoutId);
            window.removeEventListener('message', handleResult);
            sendResponse(payload);
        };

        const handleResult = (event) => {
            if (event.source !== window || event.data?.type !== 'PQI_GEOLOCATION_REQUEST_RESULT') {
                return;
            }

            respondOnce(event.data.payload || { outcome: 'unknown' });
        };

        window.addEventListener('message', handleResult);
        window.postMessage({ type: 'PQI_REQUEST_GEOLOCATION_PERMISSION' }, '*');

        timeoutId = setTimeout(() => respondOnce({ outcome: 'timeout' }), 12000);

        return true;

    } else if (request.type === 'APPLY_QUALITY_CHANGE') {
        streamState.recoveryActive = false;
        streamState.appliedConfig = request.payload;
        if (request.reloadLivePlayback && isLivePlaybackPath()) {
            try {
                window.sessionStorage.setItem(PENDING_CONFIG_KEY, JSON.stringify(request.payload));
            } catch (error) {
                console.warn('[PQI] Unable to stage live quality configuration for reload.', error);
            }
            window.location.reload();
            return;
        }
        window.postMessage({ type: 'PQI_CONFIG', payload: request.payload }, '*');
    }
});

function reconcileStoredQuality(qualities) {
    chrome.storage.sync.get(['forceMax', 'forcedId', 'forcedHeight'], (config) => {
        if (config.forceMax || (!config.forcedId && !config.forcedHeight)) return;

        const targetHeight = parseInt(config.forcedHeight, 10);
        const match = Number.isFinite(targetHeight)
            ? qualities.find(q => parseInt(q.height, 10) === targetHeight)
            : qualities.find(q => q.id === config.forcedId);

        if (!match) {
            // A partial/ad-period manifest or a new representation ID should
            // not erase the user's cross-title height preference. Keep the
            // stable height and allow a later content ladder to remap its ID.
            if (config.forcedId) chrome.storage.sync.set({ forcedId: null });
            return;
        }

        if (config.forcedId !== match.id || parseInt(config.forcedHeight, 10) !== parseInt(match.height, 10)) {
            chrome.storage.sync.set({ forcedId: match.id, forcedHeight: match.height });
        }
    });
}

// --- Config Sync ---
function syncConfig({ bootstrap = false, injectAfterConfig = false } = {}) {
    chrome.storage.sync.get(['forceMax', 'forcedId', 'forcedHeight', 'enableRetries', 'maxRetries', 'enablePrefetch', 'prefetchCount'], (res) => {
        let recoverOriginalStream = false;
        try {
            recoverOriginalStream = window.sessionStorage.getItem(ORIGINAL_STREAM_RECOVERY_KEY) === '1';
            if (recoverOriginalStream) window.sessionStorage.removeItem(ORIGINAL_STREAM_RECOVERY_KEY);
        } catch (error) {
            console.warn('[PQI] Unable to restore original-stream recovery.', error);
        }

        const config = normalizeStoredConfig(res, recoverOriginalStream);

        if (recoverOriginalStream) streamState.recoveryActive = true;
        const appliedConfig = streamState.recoveryActive
            ? { ...config, forceMax: false, forcedId: null, forcedHeight: null }
            : config;
        streamState.appliedConfig = appliedConfig;
        latestInjectedConfig = appliedConfig;

        if (bootstrap) {
            try {
                window.sessionStorage.setItem(PENDING_CONFIG_KEY, JSON.stringify(appliedConfig));
            } catch (error) {
                console.warn('[PQI] Unable to stage initial quality configuration.', error);
            }
            if (injectAfterConfig) injectScript();
        }
        // If the module is already active this updates it immediately. If it is
        // still loading, the staged session value and onload post cover both
        // sides of the race without delaying interception installation.
        window.postMessage({ type: 'PQI_CONFIG', payload: appliedConfig }, '*');
    });
}

// Start the main-world module immediately so early manifests can be observed.
// The asynchronous saved selection is staged and posted as soon as it arrives.
globalThis.__PQP_CONTENT__ = {
    retryInjection: () => { if (injectionFailed) injectScript(); }
};
/* PLATFORM_BOOTSTRAP */
injectScript();
syncConfig({ bootstrap: true });

// Listen for storage changes
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes.forceMax || changes.forcedId || changes.forcedHeight || changes.enableRetries || changes.maxRetries || changes.enablePrefetch || changes.prefetchCount)) {

        syncConfig();
    }
});

/* PLATFORM_CONTENT */
})();
