// Popup Logic - Phase 8 UI Overhaul

let currentConfig = {
    forceMax: false,
    forcedId: null
};

document.addEventListener('DOMContentLoaded', () => {
    init();
});

async function init() {
    localizeUI();
    // 1. Load Config
    try {
        const result = await chrome.storage.sync.get(['forceMax', 'forcedId', 'reviewClicked']);
        currentConfig.forceMax = result.forceMax || false;
        currentConfig.forcedId = result.forcedId || null;
        updateSelectionUI();

        if (!result.reviewClicked && (result.forceMax || result.forcedId)) {
            const reviewCard = document.getElementById('review-card');
            if (reviewCard) reviewCard.style.display = 'block';
        }
    } catch (e) {
        console.error('Error loading config', e);
    }

    // 2. Bind Buttons
    const btnAuto = document.getElementById('btn-auto');
    const btnMax = document.getElementById('btn-max');

    if (btnAuto) btnAuto.addEventListener('click', () => setMode(false, null));
    if (btnMax) btnMax.addEventListener('click', () => setMode(true, null));

    // 3. Bind Review Link
    const reviewLink = document.getElementById('review-link');
    if (reviewLink) {
        reviewLink.href = determineStoreUrl();
        reviewLink.addEventListener('click', () => {
            chrome.storage.sync.set({ reviewClicked: true });
            const reviewCard = document.getElementById('review-card');
            if (reviewCard) reviewCard.style.display = 'none';
        });
    }

    // 4. Start Polling
    startPolling();
}

function determineStoreUrl() {
    const ua = navigator.userAgent;
    const isFirefox = ua.includes("Firefox");
    const isOpera = ua.includes("OPR/") || ua.includes("Opera");

    if (isFirefox) {
        return "https://addons.mozilla.org/en-US/firefox/addon/paramount-quality/reviews/";
    } else if (isOpera) {
        return "https://addons.opera.com/en/extensions/details/paramount-quality/#feedback-container";
    } else {
        // Default to Chrome
        return "https://chromewebstore.google.com/detail/paramount-quality+/jdhjjddhdmhphkfgcfclekdngihnoann/reviews";
    }
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
    Array.from(qList.children).forEach(btn => {
        btn.classList.remove('active');
        if (!currentConfig.forceMax && currentConfig.forcedId && btn.dataset.id === currentConfig.forcedId) {
            btn.classList.add('active');
        }
    });
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
