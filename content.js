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
    initializedAt: Date.now()
};

function resetDisplayedQuality() {
    streamState.resolution = null;
    streamState.bitrate = null;
    streamState.maxBitrate = null;
    streamState.timestamp = null;
    streamState.isEstimated = false;
    streamState.hasActiveStream = false;
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

// --- Injection Logic ---
function injectScript(initialConfig) {
    const script = document.createElement('script');
    script.type = 'module';
    script.src = chrome.runtime.getURL('injected/index.js');
    script.onload = function () {
        this.remove();
        // The module consumes the staged value before installing its network
        // hooks. Posting it again covers browsers where sessionStorage was
        // unavailable without reintroducing a startup Auto/Force Max race.
        window.postMessage({ type: 'PQI_CONFIG', payload: initialConfig }, '*');
    };
    (document.head || document.documentElement).appendChild(script);

}

// --- Message Listening ---
window.addEventListener('message', (event) => {
    // We only accept messages from ourselves
    if (event.source !== window || !event.data || event.data.type !== 'PARAMOUNT_QUALITY_DATA') {
        return;
    }

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
    if (event.source === window && event.data) {
        if (event.data.type === 'PQI_MANIFEST_DATA') {
            const manifestStreamKey = event.data.payload?.[0]?.streamKey || null;
            if (manifestStreamKey && streamState.manifestStreamKey &&
                manifestStreamKey !== streamState.manifestStreamKey) {
                resetDisplayedQuality();
                streamState.requestStreamKey = null;
            }
            if (manifestStreamKey) streamState.manifestStreamKey = manifestStreamKey;
            streamState.manifestQualities = event.data.payload;
            streamState.qualitySource = 'manifest';
            reconcileStoredQuality(event.data.payload);
        } else if (event.data.type === 'PQI_ACTIVE_QUALITY') {
            // Update live stats from DAI variant playlist match
            const { resolution, bitrate } = event.data.payload;
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
        streamState.playbackDetected = detectPlaybackContext();
        sendResponse(streamState);
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
function syncConfig({ bootstrap = false } = {}) {
    chrome.storage.sync.get(['forceMax', 'forcedId', 'forcedHeight', 'enableRetries', 'maxRetries', 'enablePrefetch', 'prefetchCount'], (res) => {
        let recoverOriginalStream = false;
        try {
            recoverOriginalStream = window.sessionStorage.getItem(ORIGINAL_STREAM_RECOVERY_KEY) === '1';
            if (recoverOriginalStream) window.sessionStorage.removeItem(ORIGINAL_STREAM_RECOVERY_KEY);
        } catch (error) {
            console.warn('[PQI] Unable to restore original-stream recovery.', error);
        }

        const config = {
            forceMax: recoverOriginalStream ? false : !!res.forceMax,
            forcedId: recoverOriginalStream ? null : (res.forcedId || null),
            forcedHeight: recoverOriginalStream ? null : (res.forcedHeight || null),
            enableRetries: res.enableRetries !== false, // default true
            maxRetries: res.maxRetries !== undefined ? res.maxRetries : 3,
            enablePrefetch: res.enablePrefetch !== false, // default true
            prefetchCount: res.prefetchCount !== undefined ? res.prefetchCount : 5
        };

        if (recoverOriginalStream) streamState.recoveryActive = true;
        const appliedConfig = streamState.recoveryActive
            ? { ...config, forceMax: false, forcedId: null, forcedHeight: null }
            : config;
        streamState.appliedConfig = appliedConfig;

        if (bootstrap) {
            try {
                window.sessionStorage.setItem(PENDING_CONFIG_KEY, JSON.stringify(appliedConfig));
            } catch (error) {
                console.warn('[PQI] Unable to stage initial quality configuration.', error);
            }
            injectScript(appliedConfig);
        } else {
            window.postMessage({ type: 'PQI_CONFIG', payload: appliedConfig }, '*');
        }
    });
}

// Read the saved selection before the main-world hooks are installed. This
// prevents an original initialization segment from racing ahead of Force Max.
syncConfig({ bootstrap: true });

// Listen for storage changes
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes.forceMax || changes.forcedId || changes.forcedHeight || changes.enableRetries || changes.maxRetries || changes.enablePrefetch || changes.prefetchCount)) {

        syncConfig();
    }
});
