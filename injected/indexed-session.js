import { recordManifestReport, recordMediaReport, persistDiagnosticReport, resetReportContext } from './diagnostic-report.js';
import { filterIndexedDash } from './indexed-dash.js';
import { createRecoveryController } from './recovery-controller.js';
import { getDiagnosticSnapshot, recordDiagnosticEvent, recordPlaybackCheckpoint } from './diagnostics.js';
import { getConfig, getRepresentations } from './state.js';
import { deriveStreamKey } from './stream-model.js';

export function createIndexedSession() {
  let current = null;
  let reloadRequested = false;
  let mediaReceived = false;
  const reported = new Set();
  let detachPlayerError = () => {};
  function bindPlayerError(result) {
    detachPlayerError();
    detachPlayerError = () => {};
    if (!result.selectedHeight) return;
    const matchesResource = player => {
      const url = player?.resource?.location?.mediaUrl;
      return typeof url === 'string' && deriveStreamKey(url, 'dash') === result.streamKey;
    };
    const players = [...new Set(Array.from(document.querySelectorAll('video')).map(video => video.player)
      .filter(player => player?.isAd === false && typeof player.on === 'function' && typeof player.off === 'function' && matchesResource(player)))];
    if (players.length !== 1) return;
    const player = players[0];
    let handled = false;
    const handle = event => {
      const error = event?.detail?.error;
      if (handled || current !== result || player.isAd !== false || !matchesResource(player) ||
          error?.fatal !== true || String(error.code) !== '2103' || error.cause?.category !== 4) return;
      const cause = error.cause;
      const restrictions = cause.code === 4012 ? cause.data?.[0] : null;
      const detail = { playerCode: '2103', shakaCode: Number.isInteger(cause.code) ? cause.code : null,
        category: 'manifest', selectedHeight: result.selectedHeight,
        hasAppRestrictions: restrictions?.hasAppRestrictions === true,
        missingKeyCount: Array.isArray(restrictions?.missingKeys) ? restrictions.missingKeys.length : 0,
        restrictedKeyStatuses: Array.isArray(restrictions?.restrictedKeyStatuses)
          ? restrictions.restrictedKeyStatuses.filter(status => ['output-restricted', 'internal-error'].includes(status)) : [] };
      handled = true;
      try {
        window.sessionStorage.setItem('pqiIndexedFailure', JSON.stringify({
          path: window.location.pathname, recordedAt: Date.now(), ...detail
        }));
      } catch { /* Recovery must work even when diagnostic storage is unavailable. */ }
      recordPlaybackCheckpoint('indexed_player_error', { streamKey: result.streamKey, ...detail });
      recovery.requestRecovery({ streamKey: result.streamKey, strategy: 'indexed-manifest' }, detail, { terminal: true });
    };
    try {
      player.on('error', handle);
      detachPlayerError = () => {
        try { player.off('error', handle); } catch { /* The player may already be disposed. */ }
      };
    } catch {
      recordPlaybackCheckpoint('indexed_player_observer_unavailable', { streamKey: result.streamKey });
    }
  }
  const recovery = createRecoveryController({
    canFallbackToOriginal: () => false,
    postRecovery: payload => {
      persistDiagnosticReport(getDiagnosticSnapshot(), payload.detail);
      window.postMessage({ type: 'PQI_ORIGINAL_STREAM_RECOVERY', payload }, '*');
    },
    recordDiagnosticEvent,
    recordCheckpoint: recordPlaybackCheckpoint
  });
  const publish = () => window.postMessage({ type: 'PQI_QUALITY_STRATEGY', payload: {
    streamKey: current?.streamKey || null,
    strategy: current ? 'indexed-manifest' : null,
    selectedHeight: current?.selectedHeight || null
  } }, '*');
  const reset = () => {
    detachPlayerError();
    detachPlayerError = () => {};
    resetReportContext();
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
    recordManifestReport(result);
    current = result;
    bindPlayerError(result);
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
  const observe = (url, succeeded, detail, cancelled = false, info = {}) => {
    if (!matches(url)) return;
    recordMediaReport(url, typeof detail === 'number' ? detail : null, { ...info, cancelled, outcome: cancelled ? 'cancelled' : succeeded ? 'success' : typeof detail === 'string' ? detail : 'http-error' });
    if (cancelled) return;
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
  window.addEventListener('pagehide', reset);
  return { prepare, commit, reset, observe, handlesManifest: () => Boolean(current) };
}
