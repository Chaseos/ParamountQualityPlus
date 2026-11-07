// Content scripts can't reach chrome.action, so they report the playing height here.
chrome.runtime.onMessage.addListener((request, sender) => {
    if (request?.type !== 'SET_RESOLUTION_BADGE' || !Number.isInteger(sender.tab?.id)) return;
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: String(request.text || '') }, () => {
        void chrome.runtime.lastError; // The tab may have closed since the report.
    });
});
