window.addEventListener('message', event => {
    if (event.source !== window || event.data?.type !== 'PQI_SAFARI_NATIVE_STATE') return;
    const data = event.data.payload;
    if (!data || typeof data.active !== 'boolean') return;
    if (!data.active) {
        delete streamState.nativePlayback;
        resetDisplayedQuality();
        return;
    }
    if (!['loading', 'ready', 'switching', 'failed'].includes(data.phase)) return;
    streamState.nativePlayback = { phase: data.phase };
    streamState.resolution = Number.isInteger(data.height) && data.height > 0 && data.height <= 16384
        ? `${data.height}p` : null;
    streamState.bitrate = Number.isFinite(data.bitrate) && data.bitrate > 0 ? data.bitrate : null;
    streamState.hasActiveStream = true;
    streamState.qualitySource = 'safari-native';
    streamState.timestamp = Date.now();
});
