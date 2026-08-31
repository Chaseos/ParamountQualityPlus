function updateSafariPlaybackState(data) {
    if (!data.nativePlayback) return;
    const bitrate = document.getElementById('bitrate-val');
    if (bitrate) bitrate.textContent = data.bitrate ? `~${(data.bitrate / 1000).toFixed(1)} Mbps` : '--';
    const resolution = document.getElementById('res-val');
    if (resolution) resolution.textContent = data.resolution || '--';
}
