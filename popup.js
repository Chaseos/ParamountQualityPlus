// Popup Logic - Phase 8 UI Overhaul

let currentConfig = {
    forceMax: false,
    forcedId: null,
    enableRetries: true,
    maxRetries: 3,
    enablePrefetch: true,
    prefetchCount: 5
};

const KOFI_URL = 'https://ko-fi.com/chaseos';
const REVIEW_STORE_URLS = Object.freeze({
    chrome: "https://chromewebstore.google.com/detail/paramount-quality+/jdhjjddhdmhphkfgcfclekdngihnoann/reviews",
    edge: "https://microsoftedge.microsoft.com/addons/detail/paramount-quality/cpaekgjghoegidknadojliokbcldohjb",
    firefox: "https://addons.mozilla.org/en-US/firefox/addon/paramount-quality/reviews/",
    opera: "https://addons.opera.com/en/extensions/details/paramount-quality/#feedback-container"
});
const SIMPLE_VIDEO_SPEED_CONTROLLER_STORE_URLS = Object.freeze({
    chrome: "https://chromewebstore.google.com/detail/simple-video-speed-contro/kcjfpmjkbkhgojilpihplkedadndnked",
    edge: "https://microsoftedge.microsoft.com/addons/detail/simple-video-speed-contro/mnmagmdfgdjhbfkdnonnhkfnbnjpehja",
    firefox: "https://addons.mozilla.org/en-US/firefox/addon/simple-video-speed-controller/",
    opera: "https://addons.opera.com/en/extensions/details/simple-video-speed-controller/"
});
const REVIEW_STORE_EXTENSION_IDS = Object.freeze({
    chrome: "jdhjjddhdmhphkfgcfclekdngihnoann",
    edge: "cpaekgjghoegidknadojliokbcldohjb",
    firefox: "@paramount-quality-plus"
});
let hasShownSimpleVideoSpeedControllerAd = false;

document.addEventListener('DOMContentLoaded', () => {
    init();
});

async function init() {
    localizeUI();
    const kofiLink = document.getElementById('kofi-link');
    if (kofiLink) kofiLink.href = KOFI_URL;

    // 1. Load Config
    try {
        const result = await chrome.storage.sync.get(['forceMax', 'forcedId', 'reviewClicked', 'simpleVideoSpeedControllerAdShown', 'enableRetries', 'maxRetries', 'enablePrefetch', 'prefetchCount']);
        currentConfig.forceMax = result.forceMax || false;
        currentConfig.forcedId = result.forcedId || null;
        currentConfig.enableRetries = result.enableRetries !== false;
        currentConfig.maxRetries = result.maxRetries !== undefined ? result.maxRetries : 3;
        currentConfig.enablePrefetch = result.enablePrefetch !== false;
        currentConfig.prefetchCount = result.prefetchCount !== undefined ? result.prefetchCount : 5;
        hasShownSimpleVideoSpeedControllerAd = Boolean(result.simpleVideoSpeedControllerAdShown);
        
        updateSelectionUI();
        initNetworkControlsUI();

        if (!result.reviewClicked && (result.forceMax || result.forcedId)) {
            const reviewCard = document.getElementById('review-card');
            if (reviewCard) reviewCard.style.display = 'block';
        } else if (shouldShowSimpleVideoSpeedControllerAd(result)) {
            showSimpleVideoSpeedControllerAd();
        }
    } catch (e) {
        console.error('Error loading config', e);
    }

    // 2. Bind Buttons
    const btnAuto = document.getElementById('btn-auto');
    const btnMax = document.getElementById('btn-max');

    if (btnAuto) btnAuto.addEventListener('click', () => setMode(false, null));
    if (btnMax) btnMax.addEventListener('click', () => setMode(true, null));
    const requestLocationBtn = document.getElementById('request-location-btn');
    if (requestLocationBtn) requestLocationBtn.addEventListener('click', requestLocationAccess);

    // 3. Bind Review Link
    const reviewLink = document.getElementById('review-link');
    if (reviewLink) {
        reviewLink.href = determineStoreUrl();
        reviewLink.addEventListener('click', () => {
            chrome.storage.sync.set({ reviewClicked: true });
            const reviewCard = document.getElementById('review-card');
            if (reviewCard) reviewCard.style.display = 'none';
            showSimpleVideoSpeedControllerAd();
        });
    }

    const simpleVideoSpeedControllerAdLink = document.getElementById('simple-video-speed-controller-ad-link');
    if (simpleVideoSpeedControllerAdLink) {
        simpleVideoSpeedControllerAdLink.href = determineSimpleVideoSpeedControllerStoreUrl();
        simpleVideoSpeedControllerAdLink.addEventListener('click', () => {
            hasShownSimpleVideoSpeedControllerAd = true;
            chrome.storage.sync.set({ simpleVideoSpeedControllerAdShown: true });
            const simpleVideoSpeedControllerAdCard = document.getElementById('simple-video-speed-controller-ad-card');
            if (simpleVideoSpeedControllerAdCard) simpleVideoSpeedControllerAdCard.style.display = 'none';
        });
    }

    // 4. Start Polling
    startPolling();
}

function determineStoreUrl() {
    return REVIEW_STORE_URLS[detectReviewStore()];
}

function determineSimpleVideoSpeedControllerStoreUrl() {
    return SIMPLE_VIDEO_SPEED_CONTROLLER_STORE_URLS[detectReviewStore()];
}

function shouldShowSimpleVideoSpeedControllerAd(storageState) {
    return Boolean(storageState.reviewClicked) && !storageState.simpleVideoSpeedControllerAdShown;
}

function showSimpleVideoSpeedControllerAd() {
    if (hasShownSimpleVideoSpeedControllerAd) return;

    const simpleVideoSpeedControllerAdCard = document.getElementById('simple-video-speed-controller-ad-card');
    if (simpleVideoSpeedControllerAdCard) simpleVideoSpeedControllerAdCard.style.display = 'block';
}

function getReviewRoutingEnvironment() {
    const runtime = typeof chrome !== 'undefined' ? chrome.runtime : null;
    const userAgentData = navigator.userAgentData || {};

    return {
        extensionId: runtime && runtime.id ? runtime.id : "",
        extensionUrl: runtime && runtime.getURL ? runtime.getURL("") : "",
        userAgent: navigator.userAgent || "",
        userAgentBrands: Array.isArray(userAgentData.brands) ? userAgentData.brands : []
    };
}

function detectReviewStore(env = getReviewRoutingEnvironment()) {
    const extensionId = env.extensionId || "";
    const extensionUrl = env.extensionUrl || "";
    const ua = env.userAgent || "";
    const brandText = (env.userAgentBrands || [])
        .map(brand => brand && brand.brand)
        .filter(Boolean)
        .join(" ");

    if (extensionId === REVIEW_STORE_EXTENSION_IDS.firefox || extensionUrl.startsWith("moz-extension://") || ua.includes("Firefox")) {
        return "firefox";
    }

    if (extensionId === REVIEW_STORE_EXTENSION_IDS.edge || /\bMicrosoft Edge\b/.test(brandText) || /Edg(A|iOS)?\//.test(ua)) {
        return "edge";
    }

    if (/\bOpera\b/.test(brandText) || ua.includes("OPR/") || ua.includes("Opera")) {
        return "opera";
    }

    return "chrome";
}

function setMode(forceMax, forcedId) {

    currentConfig.forceMax = forceMax;
    currentConfig.forcedId = forcedId;

    // Save
    chrome.storage.sync.set({ forceMax, forcedId }, () => {

    });

    // Notify Content
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {

            chrome.tabs.sendMessage(tabs[0].id, {
                type: 'UPDATE_CONFIG',
                payload: { forceMax, forcedId }
            });
        } else {
            console.warn('[PQI Popup] No active tab found to notify');
        }
    });

    updateSelectionUI();

    // Show feedback
    showToast(chrome.i18n.getMessage("updatingQuality") || "Updating quality... buffer may take 10-20 seconds to clear.");
}

function initNetworkControlsUI() {
    const cbRetries = document.getElementById('cb-retries');
    const numRetries = document.getElementById('num-retries');
    const lblRetries = document.getElementById('label-retries');
    const descRetries = document.getElementById('desc-retries');
    
    const cbPrefetch = document.getElementById('cb-prefetch');
    const numPrefetch = document.getElementById('num-prefetch');
    const lblPrefetch = document.getElementById('label-prefetch');
    const descPrefetch = document.getElementById('desc-prefetch');

    if (!cbRetries || !numRetries || !cbPrefetch || !numPrefetch || !lblRetries || !lblPrefetch) return;

    // Set initial values
    cbRetries.checked = currentConfig.enableRetries;
    numRetries.value = currentConfig.maxRetries;
    numRetries.disabled = !currentConfig.enableRetries;
    lblRetries.style.color = currentConfig.enableRetries ? '' : 'var(--text-muted)';
    numRetries.style.color = currentConfig.enableRetries ? 'var(--text-main)' : 'var(--text-muted)';
    if(descRetries) descRetries.style.opacity = currentConfig.enableRetries ? '1' : '0.5';

    cbPrefetch.checked = currentConfig.enablePrefetch;
    numPrefetch.value = currentConfig.prefetchCount;
    numPrefetch.disabled = !currentConfig.enablePrefetch;
    lblPrefetch.style.color = currentConfig.enablePrefetch ? '' : 'var(--text-muted)';
    numPrefetch.style.color = currentConfig.enablePrefetch ? 'var(--text-main)' : 'var(--text-muted)';
    if(descPrefetch) descPrefetch.style.opacity = currentConfig.enablePrefetch ? '1' : '0.5';

    // Event Listeners
    const advancedToggle = document.getElementById('advanced-toggle');
    const advancedContent = document.getElementById('advanced-content');
    
    if (advancedToggle && advancedContent) {
        advancedToggle.addEventListener('click', () => {
            advancedToggle.classList.toggle('expanded');
            advancedContent.classList.toggle('expanded');
        });
    }

    cbRetries.addEventListener('change', (e) => {
        currentConfig.enableRetries = e.target.checked;
        numRetries.disabled = !currentConfig.enableRetries;
        lblRetries.style.color = currentConfig.enableRetries ? '' : 'var(--text-muted)';
        numRetries.style.color = currentConfig.enableRetries ? 'var(--text-main)' : 'var(--text-muted)';
        if(descRetries) descRetries.style.opacity = currentConfig.enableRetries ? '1' : '0.5';
        saveNetworkConfig();
    });

    numRetries.addEventListener('change', (e) => {
        let val = parseInt(e.target.value, 10);
        if (isNaN(val) || val < 1) val = 1;
        if (val > 10) val = 10;
        e.target.value = val;
        currentConfig.maxRetries = val;
        saveNetworkConfig();
    });

    cbPrefetch.addEventListener('change', (e) => {
        currentConfig.enablePrefetch = e.target.checked;
        numPrefetch.disabled = !currentConfig.enablePrefetch;
        lblPrefetch.style.color = currentConfig.enablePrefetch ? '' : 'var(--text-muted)';
        numPrefetch.style.color = currentConfig.enablePrefetch ? 'var(--text-main)' : 'var(--text-muted)';
        if(descPrefetch) descPrefetch.style.opacity = currentConfig.enablePrefetch ? '1' : '0.5';
        saveNetworkConfig();
    });

    numPrefetch.addEventListener('change', (e) => {
        let val = parseInt(e.target.value, 10);
        if (isNaN(val) || val < 1) val = 1;
        if (val > 20) val = 20;
        e.target.value = val;
        currentConfig.prefetchCount = val;
        saveNetworkConfig();
    });
}

function saveNetworkConfig() {
    const { enableRetries, maxRetries, enablePrefetch, prefetchCount } = currentConfig;
    chrome.storage.sync.set({ enableRetries, maxRetries, enablePrefetch, prefetchCount });
    showToast(chrome.i18n.getMessage("settingsSaved") || "Settings saved. Changes may take a few seconds...");
}

function requestLocationAccess() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) return;

        chrome.tabs.sendMessage(tabs[0].id, { type: 'REQUEST_GEOLOCATION_PERMISSION' }, (response) => {
            if (chrome.runtime.lastError || !response) {
                showToast(chrome.i18n.getMessage("locationPromptUnavailable") || "Open Paramount+ site settings and allow location, then refresh playback.");
                return;
            }

            if (response.outcome === 'granted') {
                showToast(chrome.i18n.getMessage("locationAccessGranted") || "Location allowed. Refresh playback if quality options do not appear.");
            } else {
                showToast(chrome.i18n.getMessage("locationPromptUnavailable") || "Open Paramount+ site settings and allow location, then refresh playback.");
            }
        });
    });
}

function showToast(msg) {
    const toast = document.getElementById('toast');
    if (!toast) return;

    toast.textContent = msg;
    toast.classList.add('visible');

    // Hide after 5s
    if (toast.timeout) clearTimeout(toast.timeout);
    toast.timeout = setTimeout(() => {
        toast.classList.remove('visible');
    }, 5000);
}

function localizeUI() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const msg = chrome.i18n.getMessage(el.getAttribute('data-i18n'));
        if (msg) el.textContent = msg;
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const msg = chrome.i18n.getMessage(el.getAttribute('data-i18n-title'));
        if (msg) el.title = msg;
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
        const msg = chrome.i18n.getMessage(el.getAttribute('data-i18n-aria-label'));
        if (msg) el.setAttribute('aria-label', msg);
    });
}

function updateSelectionUI() {
    const btnAuto = document.getElementById('btn-auto');
    const btnMax = document.getElementById('btn-max');
    const qList = document.getElementById('quality-list');

    if (!btnAuto || !btnMax || !qList) return;

    // Reset all
    btnAuto.classList.remove('active');
    btnMax.classList.remove('active');

    // Auto
    if (!currentConfig.forceMax && !currentConfig.forcedId) {
        btnAuto.classList.add('active');
    }
    // Max
    else if (currentConfig.forceMax) {
        btnMax.classList.add('active');
    }

    // Specific List Items
    let isForcedIdInList = false;
    Array.from(qList.children).forEach(btn => {
        btn.classList.remove('active');
        if (!currentConfig.forceMax && currentConfig.forcedId && btn.dataset.id === currentConfig.forcedId) {
            btn.classList.add('active');
            isForcedIdInList = true;
        }
    });

    // Fallback to Auto if the forced ID is not in the list (but we have a list loaded)
    if (!currentConfig.forceMax && currentConfig.forcedId && !isForcedIdInList && qList.children.length > 0) {
        btnAuto.classList.add('active');
    }
}

function startPolling() {
    const poll = () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (!tabs[0]) return;
            chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_STREAM_STATE' }, (response) => {
                if (chrome.runtime.lastError) {
                    setConnectionStatus(false);
                } else if (response) {
                    setConnectionStatus(true);
                    updateStats(response);

                    if (response.manifestQualities && response.manifestQualities.length > 0) {
                        renderQualityList(response.manifestQualities);
                    }
                }
            });
        });
    };

    poll(); // Immediate
    setInterval(poll, 1000); // Loop
}

function setConnectionStatus(connected) {
    const dot = document.getElementById('connection-dot');
    if (dot) {
        if (connected) dot.classList.add('active');
        else dot.classList.remove('active');
    }
}


function updateStats(data) {
    const resEl = document.getElementById('res-val');
    const brEl = document.getElementById('bitrate-val');

    if (resEl && data.resolution) {
        resEl.textContent = data.resolution;
    }

    if (brEl && data.bitrate) {
        // Mbps (e.g. 5.7)
        const mbps = (data.bitrate / 1000).toFixed(1);
        brEl.textContent = `${mbps} Mbps`;
    }

    updateGeolocationNotice(data);
}

function updateGeolocationNotice(data) {
    const notice = document.getElementById('geo-notice');
    if (!notice) return;

    notice.classList.toggle('visible', shouldShowGeolocationNotice(data));
}

function shouldShowGeolocationNotice(data, now = Date.now()) {
    const hasQualityOptions = Boolean(data.manifestQualities && data.manifestQualities.length > 0);
    const hasWaitedForStream = now - (data.initializedAt || now) > 8000;
    const locationMayBeBlocked = data.geolocationPermission === 'denied' ||
        data.geolocationPermission === 'prompt' ||
        data.geolocationPermission === 'unknown';

    return data.playbackDetected &&
        !hasQualityOptions &&
        hasWaitedForStream &&
        locationMayBeBlocked;
}

function renderQualityList(qualities) {
    const container = document.getElementById('quality-list-container');
    const list = document.getElementById('quality-list');

    if (!container || !list) return;

    if (qualities.length > 0) {
        container.classList.remove('hidden');
    }

    // Simple diff check: count
    if (list.children.length === qualities.length) {
        updateSelectionUI();
        return;
    }

    list.innerHTML = '';

    qualities.forEach(q => {
        const btn = document.createElement('button');
        btn.className = 'q-btn';
        btn.dataset.id = q.id;

        const mbps = Math.round(q.bandwidth / 10000) / 100; // rough Mbps

        btn.innerHTML = `
            <span>${q.height}p</span>
            <span style="opacity:0.6; font-size:11px;">${mbps} Mbps</span>
        `;

        // Click -> Specific Mode
        btn.addEventListener('click', () => {
            setMode(false, q.id);
        });

        list.appendChild(btn);
    });

    updateSelectionUI();
}
