import { getConfig } from './state.js';
import { isManifestUrl, isSegmentUrl, stripCMCD } from './url-utils.js';
import { resolveNextBestRepresentation, retryRewriteUrl } from './rewriter.js';
import { maybePrefetchSegments } from './prefetch.js';

// Monkey-patch fetch/XMLHttpRequest to inspect and optionally rewrite network
// requests. This lets the extension force specific quality tiers while still
// falling back gracefully when a server rejects the override.
export function initNetworkHooks({ analyzeUrl, maybeRewriteUrl, parseManifest }) {
  const ORIGINAL_FETCH = window.fetch;
  const ORIGINAL_XHR_OPEN = XMLHttpRequest.prototype.open;
  const ORIGINAL_XHR_SEND = XMLHttpRequest.prototype.send;

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

    let url = '';
    if (typeof resource === 'string') {
      url = resource;
    } else if (resource instanceof Request) {
      url = resource.url;
    }

    if (url) {
      url = stripCMCD(url);
      if (url !== (typeof resource === 'string' ? resource : resource.url)) {
        if (typeof resource === 'string') args[0] = url;
        else if (resource instanceof Request) args[0] = new Request(url, resource);
      }
    }

    let newUrl = url;
    let attemptsMade = false;

    const config = getConfig();

    if (url && (config.forceMax || config.forcedId)) {
      // Check if it's a Segment OR a Manifest (for playlist rewriting)
      if (isSegmentUrl(url) || isManifestUrl(url)) {

        newUrl = maybeRewriteUrl(url);
        
        if (newUrl !== url) {
          attemptsMade = true;
          if (typeof resource === 'string') {
            args[0] = newUrl;
          } else if (resource instanceof Request) {
            args[0] = new Request(newUrl, resource);
          }
          analyzeUrl(newUrl);
        } else {
          analyzeUrl(url);
        }
      } else if (url) {
        analyzeUrl(url);
      }

      if (attemptsMade) {
        try {
          if (isSegmentUrl(newUrl)) maybePrefetchSegments(newUrl, ORIGINAL_FETCH);
          const response = await fetchWithRetry(this, args, true, newUrl);
          if (response.ok) {
            // Parse manifest responses to update live stats (e.g., PQI_ACTIVE_QUALITY)
            if (isManifestUrl(newUrl)) {
              const clone = response.clone();
              clone.text().then(text => {
                parseManifest(text, newUrl);
              }).catch(e => console.error('[PQI] Error reading rewritten manifest:', e));
            }
            return response;
          }

          console.warn(`[PQI] Force/Rewrite failed (${response.status}) on: ${newUrl}`);

          const nextBest = resolveNextBestRepresentation();

          if (nextBest && nextBest.height >= 720) {
            const fallbackUrl = retryRewriteUrl(url, nextBest);
            if (fallbackUrl !== url && fallbackUrl !== newUrl) {
              if (typeof resource === 'string') args[0] = fallbackUrl;
              else if (resource instanceof Request) args[0] = new Request(fallbackUrl, resource);

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
          if (typeof originalResource === 'string') analyzeUrl(originalResource);
          else if (originalResource instanceof Request) analyzeUrl(originalResource.url);
          const origUrl = typeof originalResource === 'string' ? originalResource : originalResource.url;
          return fetchWithRetry(this, args, true, origUrl);

        } catch (err) {
          console.warn('[PQI] Network error during rewrite, reverting.', err);
          args[0] = originalResource;
          if (typeof originalResource === 'string') analyzeUrl(originalResource);
          else if (originalResource instanceof Request) analyzeUrl(originalResource.url);
          const origUrl = typeof originalResource === 'string' ? originalResource : originalResource.url;
          return fetchWithRetry(this, args, true, origUrl);
        }
      }

      // For untouched requests, still mirror manifest responses to the parser so
      // available quality tiers stay in sync with the player session.
      if (isSegmentUrl(url)) maybePrefetchSegments(url, ORIGINAL_FETCH);
      const response = await fetchWithRetry(this, args, true, url);

      if (isManifestUrl(url)) {
        const clone = response.clone();
        clone.text().then(text => {
          parseManifest(text, url);
        }).catch(e => console.error('[PQI] Error reading manifest:', e));
      }

      return response;
    }

    // Default path: If no forced quality is configured, or if the request
    // didn't match any criteria for rewriting, simply perform the request
    // and observe the response for manifests.
    const isRetryable = url && (isSegmentUrl(url) || isManifestUrl(url));
    if (url && isSegmentUrl(url)) {
      analyzeUrl(url);
      maybePrefetchSegments(url, ORIGINAL_FETCH);
    }

    const response = await fetchWithRetry(this, args, isRetryable, url);

    if (isManifestUrl(url)) {
      const clone = response.clone();
      clone.text().then(text => {
        parseManifest(text, url);
      }).catch(e => console.error('[PQI] Error reading manifest:', e));
    }

    return response;
  };

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    let finalUrl = stripCMCD(url);
    if (finalUrl && typeof finalUrl === 'string') {
      if (isSegmentUrl(finalUrl) || isManifestUrl(finalUrl)) {
        finalUrl = maybeRewriteUrl(finalUrl);
        analyzeUrl(finalUrl);
      }
      if (isSegmentUrl(finalUrl)) {
        maybePrefetchSegments(finalUrl, ORIGINAL_FETCH);
      }
      this._pqi_url = finalUrl;
    }
    return ORIGINAL_XHR_OPEN.apply(this, [method, finalUrl, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this._pqi_url && isManifestUrl(this._pqi_url)) {
      this.addEventListener('load', () => {
        parseManifest(this.responseText, this._pqi_url);
      });
    }
    return ORIGINAL_XHR_SEND.apply(this, args);
  };

  console.log('[PQI] Injected script active (v7.0).');
}
