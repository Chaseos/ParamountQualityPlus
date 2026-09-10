import { filterIndexedDash } from './indexed-dash.js';
import { createRecoveryController } from './recovery-controller.js';
import { recordDiagnosticEvent, recordPlaybackCheckpoint } from './diagnostics.js';
import { getConfig, getRepresentations } from './state.js';

export function createIndexedSession() {
  let current = null;
  let reloadRequested = false;
  let mediaReceived = false;
  const reported = new Set();
  const recovery = createRecoveryController({
    canFallbackToOriginal: () => false,
    postRecovery: payload => window.postMessage({ type: 'PQI_ORIGINAL_STREAM_RECOVERY', payload }, '*'),
    recordDiagnosticEvent,
    recordCheckpoint: recordPlaybackCheckpoint
  });
  const publish = () => window.postMessage({ type: 'PQI_QUALITY_STRATEGY', payload: {
    streamKey: current?.streamKey || null,
    strategy: current ? 'indexed-manifest' : null,
    selectedHeight: current?.selectedHeight || null
  } }, '*');
  const reset = () => {
    current = null;
    mediaReceived = false;
    reported.clear();
    reloadRequested = false;
    recovery.reset();
    publish();
  };
  const prepare = (text, url) => {
    const representations = getRepresentations();
    const result = filterIndexedDash(text, url, representations, getConfig());
    return { ...result, url, original: text, representations, streamKey: representations[0]?.streamKey || null };
  };
  // Commit only after the transport has successfully installed the new body.
  const commit = result => {
    if (!result.supported) {
      if (result.original.includes('_cenc_fmp4_dash') && !reported.has(result.reason)) {
        reported.add(result.reason);
        recordPlaybackCheckpoint('indexed_manifest_skipped', { reason: result.reason });
      }
      if (current?.url === result.url) reset();
      return;
    }
    current = result;
    publish();
    recordPlaybackCheckpoint('indexed_manifest', {
      streamKey: result.streamKey, reason: result.reason, selectedHeight: result.selectedHeight
    });
  };
  const configChanged = event => {
    if (event.source !== window || event.data?.type !== 'PQI_CONFIG' || !current || reloadRequested) return;
    const next = filterIndexedDash(current.original, current.url, current.representations, getConfig());
    if (!next.supported || next.selectedHeight === current.selectedHeight) return;
    reloadRequested = true;
    window.postMessage({ type: 'PQI_INDEXED_RELOAD', payload: {
      streamKey: current.streamKey, config: getConfig()
    } }, '*');
  };
  window.addEventListener('message', configChanged);
  const matches = url => {
    if (!current?.selectedHeight) return false;
    try {
      const candidate = new URL(url);
      return current.mediaUrls.some(value => {
        const selected = new URL(value);
        return selected.origin === candidate.origin && selected.pathname === candidate.pathname;
      });
    } catch { return false; }
  };
  const observe = (url, succeeded, detail, cancelled = false) => {
    if (!matches(url) || cancelled) return;
    const plan = { streamKey: current.streamKey, strategy: 'indexed-manifest' };
    if (succeeded) { mediaReceived = true; recovery.recordRewriteSuccess(plan); }
    else recovery.requestRecovery(plan, detail);
  };
  document.addEventListener?.('error', event => {
    const video = event.target;
    if (video?.tagName !== 'VIDEO' || video.player?.isAd !== false || !mediaReceived || !current?.selectedHeight ||
        ![3, 4].includes(video.error?.code)) return;
    recovery.requestRecovery({ streamKey: current.streamKey, strategy: 'indexed-manifest' },
      `video-error-${video.error.code}`, { terminal: true });
  }, true);
  return { prepare, commit, reset, observe, handlesManifest: () => Boolean(current) };
}
