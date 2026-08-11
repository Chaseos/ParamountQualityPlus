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

// Wire together config handling and network interception as soon as the module
// loads so the injected script is fully operational without additional setup.
consumePendingConfig();
initConfigListener();
initDiagnostics();
initNetworkHooks({ analyzeUrl, parseManifest });
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
