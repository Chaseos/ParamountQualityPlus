import { consumePendingConfig, initConfigListener } from './config.js';
import { analyzeUrl, resetAnalysisState } from './url-analysis.js';
import { parseManifest, parseDashManifest, parseHlsManifest } from './manifest-parser.js';
import {
  getInferredMaxCandidate,
  maybeRewriteUrl,
  planRequest,
  recordInferredFallbackResult,
  resetInferredFallbackState,
  retryRewriteUrl,
  resolveTargetRepresentation
} from './rewriter.js';
import { initNetworkHooks } from './network-hooks.js';
import { estimateResolutionFromBitrate } from './constants.js';
import { getConfig, getRepresentations, getStreamSession, setConfig, setRepresentations } from './state.js';
import { getDiagnosticSnapshot, initDiagnostics, resetDiagnostics } from './diagnostics.js';
import { installStartupSource } from './startup-source.js';
import { sourceRecoverySupported } from './source-recovery.js';
import { restorePlaybackPosition } from './position-handoff.js';

// Wire together config handling and network interception as soon as the module
// loads so the injected script is fully operational without additional setup.
consumePendingConfig();
initConfigListener();
initDiagnostics();
// The page's own fetch, before the network hooks replace it.
const pageFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
restorePlaybackPosition();
const hooks = initNetworkHooks({ analyzeUrl, parseManifest });
// Choose the stream an explicit quality pick can actually play before the
// player's first load, rather than recovering after it fails.
installStartupSource({ sourcePreference: sourceRecoverySupported(), stagePosition: hooks.stagePosition,
  fetchCatalog: pageFetch });
initGeolocationPermissionObserver();
initGeolocationRequestListener();

function initGeolocationPermissionObserver() {
  const postPermission = (state) => {
    window.postMessage({
      type: 'PQI_GEOLOCATION_PERMISSION',
      payload: { state }
    }, '*');
  };

  if (!navigator.permissions?.query) {
    postPermission('unsupported');
    return;
  }

  navigator.permissions.query({ name: 'geolocation' }).then((status) => {
    postPermission(status.state);
    status.onchange = () => postPermission(status.state);
  }).catch(() => {
    postPermission('unknown');
  });
}

function initGeolocationRequestListener() {
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== 'PQI_REQUEST_GEOLOCATION_PERMISSION') {
      return;
    }

    const postResult = (payload) => {
      window.postMessage({
        type: 'PQI_GEOLOCATION_REQUEST_RESULT',
        payload
      }, '*');
    };

    if (!navigator.geolocation?.getCurrentPosition) {
      postResult({ outcome: 'unsupported' });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      () => {
        postResult({ outcome: 'granted' });
        window.postMessage({
          type: 'PQI_GEOLOCATION_PERMISSION',
          payload: { state: 'granted' }
        }, '*');
      },
      (error) => {
        postResult({
          outcome: error?.code === 1 ? 'denied' : 'failed',
          code: error?.code || null
        });
      },
      { maximumAge: 0, timeout: 10000 }
    );
  });
}

// Re-export pieces for tests and external tooling that depend on the injected
// logic while keeping the runtime side effects (above) intact.
export {
  analyzeUrl,
  resetAnalysisState,
  estimateResolutionFromBitrate,
  getConfig,
  getInferredMaxCandidate,
  getRepresentations as getAvailableRepresentations,
  maybeRewriteUrl,
  planRequest,
  parseDashManifest,
  parseHlsManifest,
  parseManifest,
  recordInferredFallbackResult,
  resetInferredFallbackState,
  resolveTargetRepresentation,
  retryRewriteUrl,
  setConfig,
  getStreamSession,
  getDiagnosticSnapshot,
  resetDiagnostics,
  setRepresentations as setAvailableRepresentations
};
