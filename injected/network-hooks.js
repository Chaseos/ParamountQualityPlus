import { getConfig } from './state.js';
import { isManifestUrl, isSegmentUrl } from './url-utils.js';
import { resolveNextBestRepresentation, retryRewriteUrl } from './rewriter.js';

// Monkey-patch fetch/XMLHttpRequest to inspect and optionally rewrite network
// requests. This lets the extension force specific quality tiers while still
// falling back gracefully when a server rejects the override.
export function initNetworkHooks({ analyzeUrl, maybeRewriteUrl, parseManifest }) {
  const ORIGINAL_FETCH = window.fetch;
  const ORIGINAL_XHR_OPEN = XMLHttpRequest.prototype.open;
  const ORIGINAL_XHR_SEND = XMLHttpRequest.prototype.send;

  window.fetch = async function (...args) {
    let [resource] = args;
    const originalResource = resource;

    let url = '';
    if (typeof resource === 'string') {
      url = resource;
    } else if (resource instanceof Request) {
      url = resource.url;
    }

    let newUrl = url;
    let attemptsMade = false;

    const config = getConfig();
    if (url && (config.forceMax || config.forcedId) && isSegmentUrl(url)) {
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
        const response = await ORIGINAL_FETCH.apply(this, args);
        if (response.ok) return response;

        console.warn(`[PQI] Force/Rewrite failed (${response.status}) on: ${newUrl}`);

        const nextBest = resolveNextBestRepresentation();

        if (nextBest && nextBest.height >= 720) {
          const fallbackUrl = retryRewriteUrl(url, nextBest);
          if (fallbackUrl !== url && fallbackUrl !== newUrl) {
            if (typeof resource === 'string') args[0] = fallbackUrl;
            else if (resource instanceof Request) args[0] = new Request(fallbackUrl, resource);

            const fbResponse = await ORIGINAL_FETCH.apply(this, args);
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
        return ORIGINAL_FETCH.apply(this, args);

      } catch (err) {
        console.warn('[PQI] Network error during rewrite, reverting.', err);
        args[0] = originalResource;
        if (typeof originalResource === 'string') analyzeUrl(originalResource);
        else if (originalResource instanceof Request) analyzeUrl(originalResource.url);
        return ORIGINAL_FETCH.apply(this, args);
      }
    }

    // For untouched requests, still mirror manifest responses to the parser so
    // available quality tiers stay in sync with the player session.
    const response = await ORIGINAL_FETCH.apply(this, args);

    if (isManifestUrl(url)) {
      const clone = response.clone();
      clone.text().then(text => {
        parseManifest(text, url);
      }).catch(e => console.error('[PQI] Error reading manifest:', e));
    }

    return response;
  };

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    let finalUrl = url;
    if (url && typeof url === 'string' && isSegmentUrl(url)) {
      finalUrl = maybeRewriteUrl(url);
      analyzeUrl(finalUrl);
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
