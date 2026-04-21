// ParamountPlusQualityController - Content Script

// State
let streamState = {
    resolution: null,
    bitrate: null, // kbps
    maxBitrate: null, // kbps
    timestamp: null,
    isEstimated: false, // true if resolution is estimated from bitrate
    hasActiveStream: false // true if we're receiving segment data
};

// --- Injection Logic ---
function injectScript() {
    const script = document.createElement('script');
    script.type = 'module';
    script.src = chrome.runtime.getURL('injected/index.js');
    script.onload = function () {
        this.remove();
    };
    (document.head || document.documentElement).appendChild(script);

}

// --- Message Listening ---
window.addEventListener('message', (event) => {
    // We only accept messages from ourselves
    if (event.source !== window || !event.data || event.data.type !== 'PARAMOUNT_QUALITY_DATA') {
        return;
    }

    let { resolution, bitrate, maxBitrate, timestamp, isEstimated } = event.data.payload;

    // Mark that we have an active stream
    streamState.hasActiveStream = true;

    // Attempt to derive resolution from bitrate if missing
    if (!resolution && bitrate && streamState.manifestQualities) {
        const bitrateBps = bitrate * 1000;
        const match = streamState.manifestQualities.find(q => {
            const diff = Math.abs(q.bandwidth - bitrateBps);
            return diff < 50000; // tolerance of 50kbps
        });

        if (match) {
            resolution = match.height + 'p';
            isEstimated = false; // We found exact match in manifest
        }
    }

    // Parse numeric height from resolution string (e.g., "1080p" -> 1080)
    const getHeight = (res) => {
        if (!res) return 0;
        const match = res.match(/(\d+)p?/i);
        return match ? parseInt(match[1], 10) : 0;
    };

    const newHeight = getHeight(resolution);
    const currentHeight = getHeight(streamState.resolution);
    const timeSinceLastUpdate = Date.now() - (streamState.timestamp || 0);

    // Prefer higher resolution if multiple segments are buffering at once.
    // Allow downgrades only after a short delay (3s) to avoid UI flickering 
    // during transient buffering or initial playback ramps.
    if (resolution) {
        if (newHeight >= currentHeight || timeSinceLastUpdate > 3000 || streamState.isEstimated) {
            streamState.resolution = resolution;
            streamState.isEstimated = isEstimated || false;
            streamState.timestamp = timestamp;
        }
    }

    // Always update bitrate to show current segment rate
    if (bitrate) streamState.bitrate = bitrate;
    if (maxBitrate) streamState.maxBitrate = maxBitrate;
});

window.addEventListener('message', (event) => {
    if (event.source === window && event.data) {
        if (event.data.type === 'PQI_MANIFEST_DATA') {
            streamState.manifestQualities = event.data.payload;
        } else if (event.data.type === 'PQI_ACTIVE_QUALITY') {
            // Update live stats from DAI variant playlist match
            const { resolution, bitrate, daiId } = event.data.payload;
            if (resolution) streamState.resolution = resolution;
            if (bitrate) streamState.bitrate = bitrate;
            streamState.isEstimated = false; // Known from playlist URL match
            streamState.timestamp = Date.now();
        }
    }
});

// Listen for Popup requests
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'GET_STREAM_STATE') {
        sendResponse(streamState);
    }
});

// Initialize
injectScript();


// --- Config Sync ---
function syncConfig() {
    chrome.storage.sync.get(['forceMax', 'forcedId', 'enableRetries', 'maxRetries', 'enablePrefetch', 'prefetchCount'], (res) => {
        const config = {
            forceMax: !!res.forceMax,
            forcedId: res.forcedId || null,
            enableRetries: res.enableRetries !== false, // default true
            maxRetries: res.maxRetries !== undefined ? res.maxRetries : 3,
            enablePrefetch: res.enablePrefetch !== false, // default true
            prefetchCount: res.prefetchCount !== undefined ? res.prefetchCount : 5
        };

        // Send to injected script
        window.postMessage({ type: 'PQI_CONFIG', payload: config }, '*');
    });
}

// Listen for storage changes
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes.forceMax || changes.forcedId || changes.enableRetries || changes.maxRetries || changes.enablePrefetch || changes.prefetchCount)) {

        syncConfig();
    }
});

// Initial sync (give injected script a moment to load)
setTimeout(syncConfig, 500);
