// Popup Logic - Phase 8 UI Overhaul

let currentConfig = {
    forceMax: false,
    forcedId: null
};

document.addEventListener('DOMContentLoaded', () => {
    init();
});

async function init() {
    // 1. Load Config
    try {
        const result = await chrome.storage.sync.get(['forceMax', 'forcedId']);
        currentConfig.forceMax = result.forceMax || false;
        currentConfig.forcedId = result.forcedId || null;
        updateSelectionUI();
    } catch (e) {
        console.error('Error loading config', e);
    }

    // 2. Bind Buttons
    const btnAuto = document.getElementById('btn-auto');
    const btnMax = document.getElementById('btn-max');

    if (btnAuto) btnAuto.addEventListener('click', () => setMode(false, null));
    if (btnMax) btnMax.addEventListener('click', () => setMode(true, null));

    // 3. Start Polling
    startPolling();
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
    showToast("Updating quality... buffer may take 5-10s to clear.");
}

function showToast(msg) {
    const toast = document.getElementById('toast');
    if (!toast) return;

    toast.textContent = msg;
    toast.classList.add('visible');

    // Hide after 3s
    if (toast.timeout) clearTimeout(toast.timeout);
    toast.timeout = setTimeout(() => {
        toast.classList.remove('visible');
    }, 3500);
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
                    setLimitedStreamUI(false); // Reset limited state when disconnected
                } else if (response) {
                    setConnectionStatus(true);
                    updateStats(response);

                    // IMPORTANT: Check isLimitedStream FIRST - it may be set even when
                    // manifestQualities exist (e.g., archived streams where rewriting doesn't work)
                    if (response.isLimitedStream) {
                        // Stream detected but quality changes don't work
                        setLimitedStreamUI(true);
                    } else if (response.manifestQualities && response.manifestQualities.length > 0) {
                        setLimitedStreamUI(false);
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

function setLimitedStreamUI(isLimited) {
    const btnAuto = document.getElementById('btn-auto');
    const btnMax = document.getElementById('btn-max');
    const qualityContainer = document.getElementById('quality-list-container');
    const notice = document.getElementById('limited-notice');

    if (isLimited) {
        // Disable buttons
        if (btnAuto) btnAuto.disabled = true;
        if (btnMax) btnMax.disabled = true;

        // Hide quality list
        if (qualityContainer) qualityContainer.classList.add('hidden');

        // Show notice
        if (notice) notice.classList.remove('hidden');

        // Set Auto as active (reset to default)
        if (btnAuto) btnAuto.classList.add('active');
        if (btnMax) btnMax.classList.remove('active');
    } else {
        // Enable buttons
        if (btnAuto) btnAuto.disabled = false;
        if (btnMax) btnMax.disabled = false;

        // Hide notice
        if (notice) notice.classList.add('hidden');
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
