import { clearRepresentations, getConfig, getRepresentations, getStreamSession } from './state.js';
import { isManifestUrl, isSegmentUrl, stripCMCD } from './url-utils.js';
import {
  planRequest,
  recordAuthoritativeRewriteResult,
  recordInferredFallbackResult,
  resetInferredFallbackState
} from './rewriter.js';
import { maybePrefetchSegments } from './prefetch.js';
import { classifyMediaRequest, deriveStreamKey } from './stream-model.js';

// Monkey-patch fetch/XMLHttpRequest to inspect and optionally rewrite network
// requests. This lets the extension force specific quality tiers while still
// falling back gracefully when a server rejects the override.
export function initNetworkHooks({ analyzeUrl, parseManifest }) {
  const ORIGINAL_FETCH = window.fetch;
  const ORIGINAL_XHR_OPEN = XMLHttpRequest.prototype.open;
  const ORIGINAL_XHR_SEND = XMLHttpRequest.prototype.send;
  let activeStreamKey = null;
  const xhrInferenceProbes = new Map();

  function resetForNewContent(url) {
    if (!isManifestUrl(url)) return;

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
    xhrInferenceProbes.clear();
  }

  function getResourceUrl(resource) {
    if (typeof resource === 'string') return resource;
    if (resource instanceof URL) return resource.toString();
    if (resource instanceof Request) return resource.url;
    return typeof resource?.url === 'string' ? resource.url : '';
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

  function isManifestResponse(response, url) {
    const contentType = response.headers?.get?.('content-type') || '';
    return isManifestUrl(url) || contentType.includes('dash+xml') || contentType.includes('mpegurl');
  }

  function shouldPrefetch(url) {
    const request = classifyMediaRequest(url);
    return isSegmentUrl(url) && !request.excluded && !request.isInitialization && !request.isLive;
  }

  async function inspectManifestResponse(response, url) {
    if (!isManifestResponse(response, url)) return response;

    try {
      const text = await response.clone().text();
      parseManifest(text, url);
    } catch (error) {
      console.warn('[PQI] Unable to inspect manifest; playback will continue unchanged.', error);
    }
    return response;
  }

  function validateInferredCandidate(candidate) {
    if (xhrInferenceProbes.has(candidate.streamKey)) return;

    // A tiny range request is sufficient to validate the inferred directory;
    // the player continues using its original segment while this is pending.
    const probe = ORIGINAL_FETCH(candidate.url, {
      headers: { Range: 'bytes=0-1' }
    })
      .then(response => {
        recordInferredFallbackResult(candidate.streamKey, response.ok, candidate.mediaRole);
        if (!response.ok) {
          console.warn(`[PQI] Inferred XHR max-quality path failed (${response.status}); keeping the original stream.`);
        }
      })
      .catch(error => {
        recordInferredFallbackResult(candidate.streamKey, false, candidate.mediaRole);
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
      return ORIGINAL_FETCH.apply(thisArg, args);
    }

    const maxRetries = config.maxRetries ?? 3;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await ORIGINAL_FETCH.apply(thisArg, args);
        const requestSignal = args[0]?.signal || args[1]?.signal;
        if (response.ok || requestSignal?.aborted || i === maxRetries - 1) {
          return response;
        }
        console.warn(`[PQI] Fetch failed (${response.status}), retrying ${i + 1}/${maxRetries}: ${urlInfo}`);
      } catch (err) {
        const requestSignal = args[0]?.signal || args[1]?.signal;
        if (err?.name === 'AbortError' || requestSignal?.aborted || i === maxRetries - 1) throw err;
        console.warn(`[PQI] Network error, retrying ${i + 1}/${maxRetries}: ${urlInfo}`, err);
      }
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, i)));
    }
  }

  window.fetch = async function (...args) {
    let [resource] = args;
    const originalResource = resource;
    const url = getResourceUrl(resource);
    resetForNewContent(url);

    let newUrl = url;
    let rewritePlan = null;

    const config = getConfig();

    if (url && (config.forceMax || config.forcedId)) {
      // Check if it's a Segment OR a Manifest (for playlist rewriting)
      if (isSegmentUrl(url) || isManifestUrl(url)) {

        rewritePlan = planRequest(url);
        if (rewritePlan && rewritePlan.action !== 'pass-through') {
          newUrl = rewritePlan.url;
          replaceResource(args, resource, newUrl);
          // A planned URL is not an observed quality. Keep reporting the
          // player's original request until the rewritten response succeeds.
          analyzeUrl(url);
        } else {
          analyzeUrl(url);
        }
      } else if (url) {
        analyzeUrl(url);
      }

      if (rewritePlan && rewritePlan.action !== 'pass-through') {
        try {
          const isInferredAttempt = rewritePlan.action === 'inferred-probe';
          if (shouldPrefetch(newUrl) && (!isInferredAttempt || !rewritePlan.needsValidation)) {
            maybePrefetchSegments(stripCMCD(newUrl), ORIGINAL_FETCH);
          }

          const response = isInferredAttempt && rewritePlan.needsValidation
            ? await ORIGINAL_FETCH.apply(this, args)
            : await fetchWithRetry(this, args, true, newUrl);

          if (response.ok) {
            if (isInferredAttempt) {
              recordInferredFallbackResult(rewritePlan.streamKey, true, rewritePlan.mediaRole);
            } else {
              recordAuthoritativeRewriteResult(rewritePlan, true);
            }
            analyzeUrl(newUrl, { rewritten: true });
            return inspectManifestResponse(response, newUrl);
          }

          if (isInferredAttempt) {
            recordInferredFallbackResult(rewritePlan.streamKey, false, rewritePlan.mediaRole);
            const outcome = rewritePlan.fallbackAllowed === false
              ? 'not mixing it with the original representation.'
              : 'using the original stream.';
            console.warn(`[PQI] Inferred max-quality path failed (${response.status}); ${outcome}`);
          } else {
            recordAuthoritativeRewriteResult(rewritePlan, false);
            console.warn(`[PQI] Authoritative ${rewritePlan.strategy} rewrite failed (${response.status}); using the original stream.`);
          }

          if (isInferredAttempt && rewritePlan.fallbackAllowed === false) return response;

          args[0] = originalResource;
          analyzeUrl(url);
          return fetchWithRetry(this, args, true, url);

        } catch (err) {
          if (rewritePlan?.action === 'inferred-probe') {
            recordInferredFallbackResult(rewritePlan.streamKey, false, rewritePlan.mediaRole);
          } else if (rewritePlan) {
            recordAuthoritativeRewriteResult(rewritePlan, false);
          }
          if (rewritePlan?.action === 'inferred-probe' && rewritePlan.fallbackAllowed === false) {
            console.warn('[PQI] Network error after committing the inferred initialization; not mixing representations.', err);
            throw err;
          }

          console.warn('[PQI] Network error during rewrite, reverting.', err);

          args[0] = originalResource;
          analyzeUrl(url);
          return fetchWithRetry(this, args, true, url);
        }
      }

      // For untouched requests, still mirror manifest responses to the parser so
      // available quality tiers stay in sync with the player session.
      if (shouldPrefetch(url)) maybePrefetchSegments(stripCMCD(url), ORIGINAL_FETCH);
      const isRetryable = isSegmentUrl(url) || isManifestUrl(url);
      const response = await fetchWithRetry(this, args, isRetryable, url);
      return inspectManifestResponse(response, url);
    }

    // Default path: If no forced quality is configured, or if the request
    // didn't match any criteria for rewriting, simply perform the request
    // and observe the response for manifests.
    const isRetryable = url && (isSegmentUrl(url) || isManifestUrl(url));
    if (url && isSegmentUrl(url)) {
      analyzeUrl(url);
      if (shouldPrefetch(url)) maybePrefetchSegments(stripCMCD(url), ORIGINAL_FETCH);
    }

    const response = await fetchWithRetry(this, args, isRetryable, url);
    return inspectManifestResponse(response, url);
  };

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
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
            recordInferredFallbackResult(rewritePlan.streamKey, false, rewritePlan.mediaRole);
          } else {
            validateInferredCandidate(rewritePlan);
          }
        } else if (rewritePlan && rewritePlan.action !== 'pass-through') {
          finalUrl = rewritePlan.url;
          this._pqi_rewritePlan = rewritePlan;
        }

        this._pqi_originalUrl = originalUrl;
        this._pqi_plannedUrl = finalUrl;
        analyzeUrl(originalUrl);
      }
      if (shouldPrefetch(finalUrl)) {
        maybePrefetchSegments(stripCMCD(finalUrl), ORIGINAL_FETCH);
      }
      this._pqi_url = finalUrl;
      this._pqi_manifestParsed = false;
      this.addEventListener('readystatechange', inspectXhrManifest);
      this.addEventListener('readystatechange', function () {
        if (this.readyState !== 4 || !this._pqi_rewritePlan || this._pqi_rewriteRecorded) return;
        this._pqi_rewriteRecorded = true;
        const succeeded = this.status >= 200 && this.status < 400;
        if (this._pqi_rewritePlan.action === 'inferred-probe') {
          recordInferredFallbackResult(
            this._pqi_rewritePlan.streamKey,
            succeeded,
            this._pqi_rewritePlan.mediaRole
          );
        } else {
          recordAuthoritativeRewriteResult(this._pqi_rewritePlan, succeeded);
        }
        analyzeUrl(
          succeeded ? this._pqi_plannedUrl : this._pqi_originalUrl,
          { rewritten: succeeded }
        );
      });
    }
    return ORIGINAL_XHR_OPEN.apply(this, [method, finalUrl, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    return ORIGINAL_XHR_SEND.apply(this, args);
  };

  console.log('[PQI] Injected script active (v7.0).');
}
