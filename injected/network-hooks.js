import { clearRepresentations, getConfig, getRepresentations, getStreamSession } from './state.js';
import { isManifestUrl, isSegmentUrl, stripCMCD } from './url-utils.js';
import {
  canFallbackToOriginal,
  planRequest,
  recordAuthoritativeRewriteResult,
  recordInferredFallbackResult,
  resetInferredFallbackState
} from './rewriter.js';
import { maybePrefetchSegments } from './prefetch.js';
import { createRecoveryController } from './recovery-controller.js';
import { classifyMediaRequest, deriveStreamKey } from './stream-model.js';
import { diagnosticNow, recordDiagnosticEvent, recordPlaybackCheckpoint, recordRequestAttempt } from './diagnostics.js';

// Monkey-patch fetch/XMLHttpRequest to inspect and optionally rewrite network
// requests. This lets the extension force specific quality tiers while still
// falling back gracefully when a server rejects the override.
export function initNetworkHooks({ analyzeUrl, parseManifest }) {
  const ORIGINAL_FETCH = window.fetch;
  const ORIGINAL_XHR_OPEN = XMLHttpRequest.prototype.open;
  const ORIGINAL_XHR_SEND = XMLHttpRequest.prototype.send;
  let activeStreamKey = null;
  let observationSequence = 0;
  const recordedOverrideStates = new Set();
  const recordedPassThroughReasons = new Set();
  const recordedPlaybackCheckpoints = new Set();
  const xhrInferenceProbes = new Map();

  function recordStreamCheckpoint(checkpoint, plan = {}, detail = {}) {
    const streamKey = plan?.streamKey || plan?.rejectionKey || 'unknown';
    const key = `${checkpoint}|${streamKey}|${plan?.mediaRole || 'none'}`;
    if (recordedPlaybackCheckpoints.has(key)) return;
    recordedPlaybackCheckpoints.add(key);
    recordPlaybackCheckpoint(checkpoint, {
      streamKey: plan?.streamKey || null,
      strategy: plan?.strategy || null,
      mediaRole: plan?.mediaRole || null,
      ...detail
    });
  }

  const recovery = createRecoveryController({
    canFallbackToOriginal,
    recordDiagnosticEvent,
    recordCheckpoint: recordStreamCheckpoint,
    postRecovery: payload => window.postMessage({ type: 'PQI_ORIGINAL_STREAM_RECOVERY', payload }, '*')
  });

  function resetForNewContent(url) {
    if (!isManifestUrl(url)) return;

    const request = classifyMediaRequest(url);
    const hasContentIdentity = /\/vid\/[^/]+/i.test(request.url?.pathname || '');
    // Separate ad manifests must not discard the active program ladder. DAI
    // program manifests are served from an ad domain too, but their /vid/ ID
    // is a reliable title boundary and should still reset stale state.
    if (request.isAd && !hasContentIdentity) return;

    const streamKey = deriveStreamKey(url, 'manifest');
    if (!streamKey || streamKey === activeStreamKey) return;
    if (streamKey === getStreamSession().key) {
      activeStreamKey = streamKey;
      return;
    }
    const requestedUrl = new URL(url, window.location.origin);
    const isKnownVariant = getRepresentations().some(rep => {
      const variantUrl = rep.request?.variantUrl || rep.variantUrl;
      if (!variantUrl) return false;
      const knownUrl = new URL(variantUrl, requestedUrl);
      return knownUrl.origin === requestedUrl.origin && knownUrl.pathname === requestedUrl.pathname;
    });
    if (isKnownVariant) {
      activeStreamKey = getStreamSession().key;
      return;
    }
    activeStreamKey = streamKey;
    clearRepresentations();
    resetInferredFallbackState();
    recordedPlaybackCheckpoints.clear();
    recovery.reset();
    xhrInferenceProbes.clear();
    recordPlaybackCheckpoint('stream_reset', { streamKey });
    window.postMessage({ type: 'PQI_STREAM_RESET', payload: { streamKey } }, '*');
  }

  function getResourceUrl(resource) {
    if (typeof resource === 'string') return resource;
    if (resource instanceof URL) return resource.toString();
    if (resource instanceof Request) return resource.url;
    return typeof resource?.url === 'string' ? resource.url : '';
  }

  function getRequestSignal(args) {
    return args[1]?.signal || args[0]?.signal || null;
  }

  function rewriteAnalyzeOptions(rewritePlan = {}, sequence = null) {
    if (!rewritePlan || rewritePlan.action === 'pass-through') return {};

    const targetHeight = Number.isFinite(Number.parseInt(rewritePlan.targetHeight, 10))
      ? Number.parseInt(rewritePlan.targetHeight, 10)
      : Number.parseInt(rewritePlan.target?.height, 10);

    const targetBitrateKbps = Number.isFinite(Number.parseInt(rewritePlan.targetBitrateKbps, 10))
      ? Number.parseInt(rewritePlan.targetBitrateKbps, 10)
      : Number.parseInt(
          (Number.isFinite(Number.parseInt(rewritePlan.target?.bandwidth, 10))
            ? rewritePlan.target.bandwidth / 1000
            : NaN),
          10
        );

    return {
      rewritten: true,
      targetHeight: Number.isFinite(targetHeight) ? targetHeight : undefined,
      targetBitrateKbps: Number.isFinite(targetBitrateKbps) ? targetBitrateKbps : undefined,
      targetSource: rewritePlan.targetSource || rewritePlan.source || 'inferred',
      source: rewritePlan.targetSource || rewritePlan.source || 'inferred',
      observationSequence: sequence
    };
  }

  function replaceResource(args, resource, newUrl) {
    if (typeof resource === 'string') {
      args[0] = newUrl;
    } else if (resource instanceof URL) {
      args[0] = new URL(newUrl);
    } else if (resource instanceof Request) {
      args[0] = new Request(newUrl, resource);
    }
  }

  function getInferredCandidates(plan) {
    return plan?.candidates?.length ? plan.candidates : [{
      url: plan.url,
      validationUrl: plan.validationUrl,
      strategy: plan.strategy,
      targetDirectory: plan.targetDirectory || null,
      profileId: plan.profileId || null
    }];
  }

  async function fetchValidatedInferredCandidate(thisArg, args, originalResource, plan) {
    const candidates = getInferredCandidates(plan);
    let lastResponse = null;
    let lastError = null;

    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      replaceResource(args, originalResource, candidate.url);
      let response;
      try {
        response = await observedFetch(
          thisArg,
          args,
          candidate.url,
          index + 1,
          candidates.length,
          'inferred_segment'
        );
      } catch (error) {
        if (isCancelledRequest(args, error)) throw error;
        lastError = error;
        continue;
      }
      lastResponse = response;
      if (!response.ok) continue;

      let validationSucceeded = true;
      if (candidate.validationUrl) {
        try {
          const signal = getRequestSignal(args);
          const validationResponse = await ORIGINAL_FETCH(candidate.validationUrl, {
            headers: { Range: 'bytes=0-1' },
            ...(signal ? { signal } : {})
          });
          validationSucceeded = validationResponse.ok;
        } catch (error) {
          if (isCancelledRequest(args, error)) throw error;
          validationSucceeded = false;
        }
      }

      if (validationSucceeded) {
        return { response, candidate };
      }
    }

    if (!lastResponse && lastError) throw lastError;
    return { response: lastResponse, candidate: null };
  }

  function isManifestResponse(response, url) {
    const contentType = response.headers?.get?.('content-type') || '';
    return isManifestUrl(url) || contentType.includes('dash+xml') || contentType.includes('mpegurl');
  }

  function shouldPrefetch(url) {
    const request = classifyMediaRequest(url);
    const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const isEncryptedParamountVod = request.url?.pathname.toLowerCase().includes('_cenc_precon_dash/');
    return isSegmentUrl(url) && !request.excluded && !request.isInitialization && !request.isLive &&
      !isHidden && !isEncryptedParamountVod;
  }

  async function inspectManifestResponse(response, url) {
    if (!isManifestResponse(response, url)) return response;

    const inspectionStartedAt = diagnosticNow();
    try {
      const text = await response.clone().text();
      parseManifest(text, url);
      recordDiagnosticEvent('manifest_inspection', {
        outcome: 'success',
        durationMs: Math.round((diagnosticNow() - inspectionStartedAt) * 10) / 10
      });
    } catch (error) {
      recordDiagnosticEvent('manifest_inspection', {
        outcome: 'error',
        durationMs: Math.round((diagnosticNow() - inspectionStartedAt) * 10) / 10,
        errorName: error?.name || 'Error'
      });
      console.warn('[PQI] Unable to inspect manifest; playback will continue unchanged.', error);
    }
    return response;
  }

  function getRequestMethod(args) {
    const resource = args[0];
    return String(args[1]?.method || resource?.method || 'GET').toUpperCase();
  }

  async function observedFetch(thisArg, args, urlInfo, attempt = 1, maxAttempts = 1, category = null) {
    const startedAt = diagnosticNow();
    const requestCategory = category || classifyMediaRequest(urlInfo).kind;
    try {
      const response = await ORIGINAL_FETCH.apply(thisArg, args);
      if (requestCategory !== 'unknown') {
        recordRequestAttempt({
          transport: 'fetch',
          category: requestCategory,
          url: urlInfo,
          method: getRequestMethod(args),
          attempt,
          maxAttempts,
          status: response.status,
          ok: response.ok,
          outcome: response.ok ? 'success' : 'http-error',
          durationMs: diagnosticNow() - startedAt
        });
      }
      return response;
    } catch (error) {
      if (requestCategory !== 'unknown') {
        const requestSignal = getRequestSignal(args);
        const cancelled = error?.name === 'AbortError' || requestSignal?.aborted;
        recordRequestAttempt({
          transport: 'fetch',
          category: requestCategory,
          url: urlInfo,
          method: getRequestMethod(args),
          attempt,
          maxAttempts,
          outcome: cancelled ? 'cancelled' : 'network-error',
          durationMs: diagnosticNow() - startedAt
        });
      }
      throw error;
    }
  }

  function validateInferredCandidate(candidate) {
    if (xhrInferenceProbes.has(candidate.streamKey)) return;

    // A tiny range request is sufficient to validate the inferred directory;
    // the player continues using its original segment while this is pending.
    const probe = (async () => {
      let lastStatus = null;
      for (const inferredCandidate of getInferredCandidates(candidate)) {
        const response = await ORIGINAL_FETCH(inferredCandidate.url, {
          headers: { Range: 'bytes=0-1' }
        });
        lastStatus = response.status;
        if (!response.ok) continue;

        recordInferredFallbackResult(candidate.streamKey, true, null, inferredCandidate);
        return;
      }

      recordInferredFallbackResult(candidate.streamKey, false);
      console.warn(`[PQI] Inferred XHR max-quality paths failed (${lastStatus || 'validation'}); keeping the original stream.`);
    })()
      .catch(error => {
        recordInferredFallbackResult(candidate.streamKey, false);
        console.warn('[PQI] Inferred XHR max-quality probe failed; keeping the original stream.', error);
      })
      .finally(() => xhrInferenceProbes.delete(candidate.streamKey));

    xhrInferenceProbes.set(candidate.streamKey, probe);
  }

  function inspectXhrManifest() {
    if (this._pqi_manifestParsed || this.readyState !== 4) return;

    const contentType = typeof this.getResponseHeader === 'function'
      ? (this.getResponseHeader('content-type') || '')
      : '';
    const isManifestResponse = (this._pqi_url && isManifestUrl(this._pqi_url)) ||
      contentType.includes('dash+xml') ||
      contentType.includes('mpegurl');
    if (!isManifestResponse) return;

    this._pqi_manifestParsed = true;
    try {
      parseManifest(this.responseText, this._pqi_url);
    } catch (error) {
      console.warn('[PQI] Unable to inspect XHR manifest; playback will continue unchanged.', error);
    }
  }

  async function fetchWithRetry(thisArg, args, isRetryable, urlInfo) {
    const config = getConfig();
    if (!isRetryable || config.enableRetries === false) {
      return observedFetch(thisArg, args, urlInfo);
    }

    const maxRetries = config.maxRetries ?? 3;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await observedFetch(thisArg, args, urlInfo, i + 1, maxRetries);
        const requestSignal = getRequestSignal(args);
        const retryableStatus = response.status === 408 || response.status === 429 || response.status >= 500;
        if (response.ok || requestSignal?.aborted || !retryableStatus || i === maxRetries - 1) {
          return response;
        }
        console.warn(`[PQI] Fetch failed (${response.status}), retrying ${i + 1}/${maxRetries}: ${urlInfo}`);
      } catch (err) {
        const requestSignal = getRequestSignal(args);
        if (err?.name === 'AbortError' || requestSignal?.aborted || i === maxRetries - 1) throw err;
        console.warn(`[PQI] Network error, retrying ${i + 1}/${maxRetries}: ${urlInfo}`, err);
      }
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, i)));
    }
  }

  function isCancelledRequest(args, error) {
    const requestSignal = getRequestSignal(args);
    return error?.name === 'AbortError' || requestSignal?.aborted;
  }

  window.fetch = async function (...args) {
    let [resource] = args;
    const originalResource = resource;
    const url = getResourceUrl(resource);
    const requestObservationSequence = ++observationSequence;
    resetForNewContent(url);

    let newUrl = url;
    let rewritePlan = null;

    const config = getConfig();

    if (url && isSegmentUrl(url)) {
      const request = classifyMediaRequest(url);
      const overrideStateKey = `${Boolean(config.forceMax)}|${Boolean(config.forcedId)}|${config.forcedHeight || 'none'}`;
      if (!request.excluded && !request.isInitialization && !recordedOverrideStates.has(overrideStateKey)) {
        recordedOverrideStates.add(overrideStateKey);
        recordDiagnosticEvent('override_state', {
          forceMax: Boolean(config.forceMax),
          hasForcedId: Boolean(config.forcedId),
          forcedHeight: config.forcedHeight || null,
          representationCount: getRepresentations().length
        });
      }
    }

    if (url && (config.forceMax || config.forcedId || config.forcedHeight)) {
      // Check if it's a Segment OR a Manifest (for playlist rewriting)
      if (isSegmentUrl(url) || isManifestUrl(url)) {

        rewritePlan = planRequest(url);
        if (rewritePlan?.action === 'pass-through' &&
            !recordedPassThroughReasons.has(rewritePlan.reason)) {
          recordedPassThroughReasons.add(rewritePlan.reason);
          recordDiagnosticEvent('rewrite_skipped', {
            reason: rewritePlan.reason,
            mediaRole: rewritePlan.mediaRole
          });
        }
        if (rewritePlan && rewritePlan.action !== 'pass-through') {
          newUrl = rewritePlan.url;
          replaceResource(args, resource, newUrl);
          recordDiagnosticEvent('rewrite_planned', {
            strategy: rewritePlan.strategy,
            action: rewritePlan.action,
            mediaRole: rewritePlan.mediaRole
          });
          recordStreamCheckpoint('rewrite_planned', rewritePlan);
        }
      }

      if (rewritePlan && rewritePlan.action !== 'pass-through') {
        try {
          const isInferredAttempt = rewritePlan.action === 'inferred-probe';
          if (shouldPrefetch(newUrl) && (!isInferredAttempt || !rewritePlan.needsValidation)) {
            maybePrefetchSegments(stripCMCD(newUrl), ORIGINAL_FETCH);
          }

          const inferredResult = isInferredAttempt && rewritePlan.needsValidation
            ? await fetchValidatedInferredCandidate(this, args, originalResource, rewritePlan)
            : null;
          const response = inferredResult
            ? inferredResult.response
            : await fetchWithRetry(this, args, true, newUrl);
          const successfulCandidate = inferredResult?.candidate || null;
          const inferredValidationSucceeded = !inferredResult || Boolean(successfulCandidate);

          if (response.ok && inferredValidationSucceeded) {
            const successfulUrl = successfulCandidate?.url || newUrl;
            recordDiagnosticEvent('rewrite_result', {
              outcome: 'success',
              strategy: successfulCandidate?.strategy || rewritePlan.strategy,
              mediaRole: rewritePlan.mediaRole
            });
            recordStreamCheckpoint('rewrite_succeeded', rewritePlan);
            if (isInferredAttempt) {
              recordInferredFallbackResult(
                rewritePlan.streamKey,
                true,
                rewritePlan.mediaRole,
                successfulCandidate
              );
            } else {
              recordAuthoritativeRewriteResult(rewritePlan, true);
            }
            recovery.recordRewriteSuccess(rewritePlan);
            analyzeUrl(successfulUrl, rewriteAnalyzeOptions(rewritePlan, requestObservationSequence));
            return inspectManifestResponse(response, successfulUrl);
          }

          if (isInferredAttempt) {
            recordInferredFallbackResult(rewritePlan.streamKey, false, rewritePlan.mediaRole);
            const failure = inferredValidationSucceeded ? response.status : 'companion media validation';
            console.warn(`[PQI] Inferred max-quality path failed (${failure}); using the original stream.`);
          } else {
            recordAuthoritativeRewriteResult(rewritePlan, false);
            console.warn(`[PQI] Authoritative ${rewritePlan.strategy} rewrite failed (${response.status}); using the original stream.`);
          }
          recordDiagnosticEvent('rewrite_result', {
            outcome: 'failure',
            strategy: rewritePlan.strategy,
            mediaRole: rewritePlan.mediaRole,
            status: response.status || null
          });
          recordStreamCheckpoint('rewrite_failed', rewritePlan, { status: response.status || null });

          // Once a rewritten initialization has reached MediaSource, returning
          // a segment from the original rendition can mix codec/encryption
          // state and trigger Paramount's generic playback error. Preserve the
          // failed response so the player can retry/reload coherently.
          if (!canFallbackToOriginal(rewritePlan)) {
            recovery.requestRecovery(rewritePlan, response.status || 'validation-failed');
            return response;
          }

          args[0] = originalResource;
          const fallbackResponse = await fetchWithRetry(this, args, true, url);
          if (fallbackResponse.ok) analyzeUrl(url, { observationSequence: requestObservationSequence });
          return fallbackResponse;

        } catch (err) {
          if (isCancelledRequest(args, err)) throw err;

          if (rewritePlan?.action === 'inferred-probe') {
            recordInferredFallbackResult(rewritePlan.streamKey, false, rewritePlan.mediaRole);
          } else if (rewritePlan) {
            recordAuthoritativeRewriteResult(rewritePlan, false);
          }

          if (!canFallbackToOriginal(rewritePlan)) {
            recovery.requestRecovery(rewritePlan, err?.name || 'network-error');
            throw err;
          }

          console.warn('[PQI] Network error during rewrite, reverting.', err);

          args[0] = originalResource;
          const fallbackResponse = await fetchWithRetry(this, args, true, url);
          if (fallbackResponse.ok) analyzeUrl(url, { observationSequence: requestObservationSequence });
          return fallbackResponse;
        }
      }

      // For untouched requests, still mirror manifest responses to the parser so
      // available quality tiers stay in sync with the player session.
      if (shouldPrefetch(url)) maybePrefetchSegments(stripCMCD(url), ORIGINAL_FETCH);
      const isRetryable = isSegmentUrl(url) || isManifestUrl(url);
      const response = await fetchWithRetry(this, args, isRetryable, url);
      if (response.ok) analyzeUrl(url, { observationSequence: requestObservationSequence });
      return inspectManifestResponse(response, url);
    }

    // Default path: If no forced quality is configured, or if the request
    // didn't match any criteria for rewriting, simply perform the request
    // and observe the response for manifests.
    const isRetryable = url && (isSegmentUrl(url) || isManifestUrl(url));
    if (url && isSegmentUrl(url) && shouldPrefetch(url)) {
      maybePrefetchSegments(stripCMCD(url), ORIGINAL_FETCH);
    }

    const response = await fetchWithRetry(this, args, isRetryable, url);
    if (response.ok) analyzeUrl(url, { observationSequence: requestObservationSequence });
    return inspectManifestResponse(response, url);
  };

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    // XMLHttpRequest instances can be reused. Do not let a prior rewrite or
    // completion suppress analysis for the next open/send cycle.
    this._pqi_rewritePlan = null;
    this._pqi_rewriteRecorded = false;
    this._pqi_originalUrl = null;
    this._pqi_plannedUrl = null;
    this._pqi_manifestParsed = false;
    this._pqi_observationSequence = ++observationSequence;
    this._pqi_diagnosticStartedAt = diagnosticNow();
    this._pqi_diagnosticRecorded = false;

    let finalUrl = url instanceof URL ? url.toString() : url;
    if (finalUrl && typeof finalUrl === 'string') {
      resetForNewContent(finalUrl);
      if (isSegmentUrl(finalUrl) || isManifestUrl(finalUrl)) {
        const originalUrl = finalUrl;
        const rewritePlan = planRequest(originalUrl);
        if (rewritePlan?.action === 'inferred-probe' && rewritePlan.needsValidation) {
          if (rewritePlan.mediaRole === 'initialization') {
            // XHR cannot be redirected after an asynchronous probe without
            // losing request headers. Keep both initialization and media on
            // the original representation for this stream.
            recordInferredFallbackResult(rewritePlan.streamKey, false);
          } else {
            validateInferredCandidate(rewritePlan);
          }
        } else if (rewritePlan && rewritePlan.action !== 'pass-through') {
          finalUrl = rewritePlan.url;
          this._pqi_rewritePlan = rewritePlan;
          recordDiagnosticEvent('rewrite_planned', {
            strategy: rewritePlan.strategy,
            action: rewritePlan.action,
            mediaRole: rewritePlan.mediaRole,
            transport: 'xhr'
          });
          recordStreamCheckpoint('rewrite_planned', rewritePlan, { transport: 'xhr' });
        }

        this._pqi_originalUrl = originalUrl;
        this._pqi_plannedUrl = finalUrl;
      }
      if (shouldPrefetch(finalUrl)) {
        maybePrefetchSegments(stripCMCD(finalUrl), ORIGINAL_FETCH);
      }
      this._pqi_url = finalUrl;
      this._pqi_manifestParsed = false;
      this.addEventListener('readystatechange', inspectXhrManifest);
      this.addEventListener('readystatechange', function () {
        if (this.readyState !== 4 || this._pqi_rewriteRecorded) return;
        this._pqi_rewriteRecorded = true;
        const succeeded = this.status >= 200 && this.status < 400;
        if (!this._pqi_rewritePlan) {
          if (succeeded) {
            analyzeUrl(this._pqi_originalUrl, {
              observationSequence: this._pqi_observationSequence
            });
          }
          return;
        }
        if (this._pqi_rewritePlan.action === 'inferred-probe') {
          recordInferredFallbackResult(
            this._pqi_rewritePlan.streamKey,
            succeeded,
            this._pqi_rewritePlan.mediaRole
          );
        } else {
          recordAuthoritativeRewriteResult(this._pqi_rewritePlan, succeeded);
        }
        recordDiagnosticEvent('rewrite_result', {
          outcome: succeeded ? 'success' : 'failure',
          strategy: this._pqi_rewritePlan.strategy,
          mediaRole: this._pqi_rewritePlan.mediaRole,
          status: this.status || null,
          transport: 'xhr'
        });
        recordStreamCheckpoint(succeeded ? 'rewrite_succeeded' : 'rewrite_failed', this._pqi_rewritePlan, {
          transport: 'xhr', status: this.status || null
        });
        if (!succeeded) {
          recovery.requestRecovery(this._pqi_rewritePlan, this.status || 'xhr-failed');
        }
        if (succeeded) {
          recovery.recordRewriteSuccess(this._pqi_rewritePlan);
          analyzeUrl(
            this._pqi_plannedUrl,
            rewriteAnalyzeOptions(this._pqi_rewritePlan, this._pqi_observationSequence)
          );
        }
      });
      this.addEventListener('readystatechange', function () {
        if (this.readyState !== 4 || this._pqi_diagnosticRecorded) return;
        this._pqi_diagnosticRecorded = true;
        const category = classifyMediaRequest(this._pqi_url).kind;
        if (category === 'unknown') return;
        recordRequestAttempt({
          transport: 'xhr',
          category,
          url: this._pqi_url,
          method,
          status: this.status,
          ok: this.status >= 200 && this.status < 400,
          outcome: this.status >= 200 && this.status < 400 ? 'success' : 'http-error',
          durationMs: diagnosticNow() - this._pqi_diagnosticStartedAt
        });
      });
    }
    return ORIGINAL_XHR_OPEN.apply(this, [method, finalUrl, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    return ORIGINAL_XHR_SEND.apply(this, args);
  };

  console.log('[PQI] Injected script active (v7.0).');
}
