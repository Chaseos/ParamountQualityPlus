import { estimateResolutionFromBitrate } from './constants.js';
import { extractResolutionFromPath, isSegmentUrl } from './url-utils.js';
import { getRepresentations } from './state.js';
import { classifyMediaRequest } from './stream-model.js';


// Inspect requested media segment URLs, infer their resolution/bitrate, and
// surface the data to the extension UI via postMessage for live telemetry.
export function analyzeUrl(url, options = {}) {
  try {
    if (!isSegmentUrl(url)) return;

    const request = classifyMediaRequest(url);
    if (!request.url || request.excluded) return;
    const urlObj = request.url;
    const pathname = urlObj.pathname;

    const cmcdParam = urlObj.searchParams.get('CMCD');

    const availableRepresentations = getRepresentations();
    const resolutionMatch = extractResolutionFromPath(pathname);
    let resolution = resolutionMatch;
    let isEstimated = false;
    let exactBandwidth = null;
    let source = 'inferred';

    if (resolution && availableRepresentations.length > 0) {
      const numericRes = parseInt(resolution);
      const match = availableRepresentations.find(r => r.height === numericRes);
      if (match) {
        exactBandwidth = match.bandwidth || (match.dashTier ? parseInt(match.dashTier, 10) * 1000 : null);
        isEstimated = false;
        source = 'manifest';
      }
    }

    let bitrate = null;
    let maxBitrate = null;

    if (cmcdParam) {
      bitrate = parseInt(request.cmcd.br, 10) || null;
      maxBitrate = parseInt(request.cmcd.tb, 10) || null;
    }

    // Detect manifest_video pattern for stats mapping
    const hlsTierMatch = pathname.match(/manifest(?:_video)?_(\d+)[_\/]/);

    const dashTierMatch = pathname.match(/_(\d{3,5})\/seg_/);
    const requestedTier = dashTierMatch ? parseInt(dashTierMatch[1], 10) : null;
    if (!resolution) {
      if (dashTierMatch) {
        const match = availableRepresentations.find(r => r.dashTier === dashTierMatch[1]);
        if (match) {
          resolution = match.height + 'p';
          isEstimated = false;
          exactBandwidth = match.bandwidth;
          source = 'manifest';
        } else {
          resolution = estimateResolutionFromBitrate(requestedTier);
          isEstimated = true;
        }
      }

      // --- Hybrid HLS/DASH manifest_video Mapping ---
      if (!resolution && hlsTierMatch) {
        const tier = hlsTierMatch[1];
        const match = availableRepresentations.find(r => r.hlsTier === tier || r.rawId === tier);
        if (match) {
          resolution = match.height + 'p';
          exactBandwidth = match.bandwidth;
          isEstimated = false;
          source = 'manifest';
        }
      }

      // --- Google DAI Fallback ---
      if (!resolution && availableRepresentations.length > 0) {
        const match = availableRepresentations.find(r => r.daiId && pathname.includes(r.daiId));
        if (match) {
          resolution = match.height + 'p';
          exactBandwidth = match.bandwidth;
          isEstimated = false;
          source = 'manifest';
        }
      }
    }

    if (!resolution && bitrate) {
      resolution = estimateResolutionFromBitrate(bitrate);
      isEstimated = true;
    }

    if (resolution || bitrate || exactBandwidth) {
      let finalBitrate = bitrate;
      // CMCD belongs to the player's original request and intentionally stays
      // unchanged on a rewritten URL. Once that rewrite succeeds, report the
      // target representation instead of the now-stale CMCD `br` value.
      if (options.rewritten && exactBandwidth) {
        finalBitrate = Math.round(exactBandwidth / 1000);
      } else if (options.rewritten && requestedTier) {
        finalBitrate = requestedTier;
      } else if (!finalBitrate && exactBandwidth) {
        finalBitrate = Math.round(exactBandwidth / 1000);
      } else if (!finalBitrate && requestedTier) {
        finalBitrate = requestedTier;
      }

      window.postMessage({
        type: 'PARAMOUNT_QUALITY_DATA',
        payload: {
          resolution,
          isEstimated,
          bitrate: finalBitrate,
          maxBitrate,
          source,
          timestamp: Date.now()
        }
      }, '*');
    }
  } catch (e) {
    console.error('[PQI] Error analyzing URL:', e);
  }
}

// For testing
export function resetAnalysisState() {
  // Logic removed
}
