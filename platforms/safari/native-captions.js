// Avia's native adapter caches TextTrack identities. A new HLS source replaces
// those tracks, so mode restoration alone leaves its custom renderer disconnected.
export function prepareNativeCaptions(video) {
    try {
        const player = video.player;
        const adapter = player?.getAdapter?.('playback');
        const settings = adapter?.context?.textTrackSettings;
        const surface = adapter?.textTrackSurface;
        if (player?.isAd || adapter?.video !== video || adapter?.getId?.() !== 'html5' ||
            typeof adapter.createTextTrackSurface !== 'function' || typeof surface?.destroy !== 'function' ||
            !Array.isArray(adapter.textTracks) || !['hidden', 'showing', 'disabled'].includes(settings?.mode) ||
            // Rebuilding a surface with external <track> resources could remove
            // site-owned nodes. This bridge is only for native in-band HLS tracks.
            adapter.context.resource?.location?.textTrackUrl || video.querySelector?.('track')) return false;

        // Use the site's factory, live language/mode settings, and cue renderer.
        // Construct first so a factory failure leaves the existing surface intact.
        const replacement = adapter.createTextTrackSurface();
        if (!replacement || replacement === surface || typeof replacement.destroy !== 'function') return false;
        try {
            surface.destroy();
        } finally {
            adapter.textTracks = [];
            adapter.textTrack = null;
            adapter.textTrackSurface = replacement;
        }
        // The player owns the replacement and its cleanup. Its addtrack listener
        // handles late tracks and subsequent user changes, including Off.
        return true;
    } catch {
        // A changed or unsupported player must not prevent the quality switch.
        return false;
    }
}
