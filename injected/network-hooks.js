import { clearRepresentations, getConfig } from './state.js';
import { isManifestUrl, isSegmentUrl, stripCMCD } from './url-utils.js';
import {
  getInferredMaxCandidate,
  recordInferredFallbackResult,
  resetInferredFallbackState,
  resolveNextBestRepresentation,
  retryRewriteUrl
} from './rewriter.js';
import { maybePrefetchSegments } from './prefetch.js';

// Monkey-patch fetch/XMLHttpRequest to inspect and optionally rewrite network
// requests. This lets the extension force specific quality tiers while still
// falling back gracefully when a server rejects the override.
export function initNetworkHooks({ analyzeUrl, maybeRewriteUrl, parseManifest }) {
  const ORIGINAL_FETCH = window.fetch;
  const ORIGINAL_XHR_OPEN = XMLHttpRequest.prototype.open;
  const ORIGINAL_XHR_SEND = XMLHttpRequest.prototype.send;
  let activeContentId = null;
  const xhrInferenceProbes = new Map();

  function resetForNewContent(url) {
    if (!isManifestUrl(url)) return;

    let contentId = null;
    try {
      contentId = new URL(url, window.location.origin).pathname.match(/\/vid\/([^/]+)/i)?.[1] || null;
    } catch {
      return;
    }

    if (!contentId || contentId === activeContentId) return;
    activeContentId = contentId;
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
        recordInferredFallbackResult(candidate.streamKey, response.ok);
        if (!response.ok) {
          console.warn(`[PQI] Inferred XHR max-quality path failed (${response.status}); keeping the original stream.`);
        }
      })
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
      return ORIGINAL_FETCH.apply(thisArg, args);
    }

    const maxRetries = config.maxRetries ?? 3;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await ORIGINAL_FETCH.apply(thisArg, args);
        if (response.ok || i === maxRetries - 1) {
          return response;
        }
        console.warn(`[PQI] Fetch failed (${response.status}), retrying ${i + 1}/${maxRetries}: ${urlInfo}`);
      } catch (err) {
        if (i === maxRetries - 1) throw err;
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
    let attemptsMade = false;
    let inferredPlan = null;

    const config = getConfig();

    if (url && (config.forceMax || config.forcedId)) {
      // Check if it's a Segment OR a Manifest (for playlist rewriting)
      if (isSegmentUrl(url) || isManifestUrl(url)) {

        newUrl = maybeRewriteUrl(url);

        inferredPlan = newUrl === url && isSegmentUrl(url)
          ? getInferredMaxCandidate(url)
          : null;
        if (inferredPlan) {
          newUrl = inferredPlan.url;
        }
        
        if (newUrl !== url) {
          attemptsMade = true;
          replaceResource(args, resource, newUrl);
          // Keep reporting the observed stream until a speculative candidate
          // has actually succeeded, avoiding a brief false 1080p status.
          analyzeUrl(inferredPlan ? url : newUrl);
        } else {
          analyzeUrl(url);
        }
      } else if (url) {
        analyzeUrl(url);
      }

      if (attemptsMade) {
        try {
          const isInferredAttempt = inferredPlan?.url === newUrl;
          if (isSegmentUrl(newUrl) && (!isInferredAttempt || !inferredPlan.needsValidation)) {
            maybePrefetchSegments(stripCMCD(newUrl), ORIGINAL_FETCH);
          }

          const response = isInferredAttempt && inferredPlan.needsValidation
            ? await ORIGINAL_FETCH.apply(this, args)
            : await fetchWithRetry(this, args, true, newUrl);

          if (response.ok) {
            if (isInferredAttempt) {
              recordInferredFallbackResult(inferredPlan.streamKey, true);
              analyzeUrl(newUrl);
            }
            return inspectManifestResponse(response, newUrl);
          }

          if (isInferredAttempt) {
            recordInferredFallbackResult(inferredPlan.streamKey, false);
            console.warn(`[PQI] Inferred max-quality path failed (${response.status}); using the original stream.`);
            args[0] = originalResource;
            analyzeUrl(url);
            return fetchWithRetry(this, args, true, url);
          }

          console.warn(`[PQI] Force/Rewrite failed (${response.status}) on: ${newUrl}`);

          const nextBest = resolveNextBestRepresentation();

          if (nextBest && nextBest.height >= 720) {
            const fallbackUrl = retryRewriteUrl(url, nextBest);
            if (fallbackUrl !== url && fallbackUrl !== newUrl) {
              replaceResource(args, resource, fallbackUrl);

              const fbResponse = await fetchWithRetry(this, args, true, fallbackUrl);
              if (fbResponse.ok) {
                analyzeUrl(fallbackUrl);
                return fbResponse;
              }
              console.warn(`[PQI] Fallback failed (${fbResponse.status}) on: ${fallbackUrl}`);
            }
          }

          console.warn('[PQI] All forces failed, reverting to original.');
          args[0] = originalResource;
          analyzeUrl(url);
          return fetchWithRetry(this, args, true, url);

        } catch (err) {
          if (inferredPlan?.url === newUrl) {
            recordInferredFallbackResult(inferredPlan.streamKey, false);
          }
          console.warn('[PQI] Network error during rewrite, reverting.', err);
          args[0] = originalResource;
          analyzeUrl(url);
          return fetchWithRetry(this, args, true, url);
        }
      }

      // For untouched requests, still mirror manifest responses to the parser so
      // available quality tiers stay in sync with the player session.
      if (isSegmentUrl(url)) maybePrefetchSegments(stripCMCD(url), ORIGINAL_FETCH);
      const response = await fetchWithRetry(this, args, true, url);
      return inspectManifestResponse(response, url);
    }

    // Default path: If no forced quality is configured, or if the request
    // didn't match any criteria for rewriting, simply perform the request
    // and observe the response for manifests.
    const isRetryable = url && (isSegmentUrl(url) || isManifestUrl(url));
    if (url && isSegmentUrl(url)) {
      analyzeUrl(url);
      maybePrefetchSegments(stripCMCD(url), ORIGINAL_FETCH);
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
        finalUrl = maybeRewriteUrl(originalUrl);

        if (finalUrl === originalUrl && isSegmentUrl(originalUrl)) {
          const inferredPlan = getInferredMaxCandidate(originalUrl);
          if (inferredPlan?.needsValidation) {
            validateInferredCandidate(inferredPlan);
          } else if (inferredPlan) {
            finalUrl = inferredPlan.url;
          }
        }

        analyzeUrl(finalUrl);
      }
      if (isSegmentUrl(finalUrl)) {
        maybePrefetchSegments(stripCMCD(finalUrl), ORIGINAL_FETCH);
      }
      this._pqi_url = finalUrl;
      this._pqi_manifestParsed = false;
      this.addEventListener('readystatechange', inspectXhrManifest);
    }
    return ORIGINAL_XHR_OPEN.apply(this, [method, finalUrl, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    return ORIGINAL_XHR_SEND.apply(this, args);
  };

  console.log('[PQI] Injected script active (v7.0).');
}
