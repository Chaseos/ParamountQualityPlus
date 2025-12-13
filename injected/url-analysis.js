import { estimateResolutionFromBitrate } from './constants.js';
import { extractResolutionFromPath, isSegmentUrl } from './url-utils.js';
import { getRepresentations } from './state.js';

// Inspect requested media segment URLs, infer their resolution/bitrate, and
// surface the data to the extension UI via postMessage for live telemetry.
export function analyzeUrl(url) {
  try {
    if (!isSegmentUrl(url)) return;

    const urlObj = new URL(url, window.location.origin);
    const pathname = urlObj.pathname;

    const cmcdParam = urlObj.searchParams.get('CMCD');
    if (cmcdParam && (cmcdParam.includes('ot=a') || cmcdParam.includes('ot%3Da'))) {
      return;
    }
    if (pathname.includes('_aac_') || pathname.includes('/audio/') || pathname.includes('_audio_')) {
      return;
    }

    const availableRepresentations = getRepresentations();
    const resolutionMatch = extractResolutionFromPath(pathname);
    let resolution = resolutionMatch;
    let isEstimated = false;
    let exactBandwidth = null;

    if (resolution && availableRepresentations.length > 0) {
      const numericRes = parseInt(resolution);
      const match = availableRepresentations.find(r => r.height === numericRes);
      if (match) {
        if (match.dashTier) {
          exactBandwidth = parseInt(match.dashTier) * 1000;
        } else {
          exactBandwidth = match.bandwidth;
        }
        isEstimated = false;
      }
    }

    let bitrate = null;
    let maxBitrate = null;

    if (cmcdParam) {
      const pairs = cmcdParam.split(',');
      pairs.forEach(pair => {
        const [key, value] = pair.split('=');
        if (key === 'br') bitrate = parseInt(value, 10);
        if (key === 'tb') maxBitrate = parseInt(value, 10);
      });
    }

    let requestedTier = null;
    if (!resolution) {
      const dashTierMatch = pathname.match(/_(\d{3,5})\/seg_/);
      if (dashTierMatch) {
        requestedTier = parseInt(dashTierMatch[1], 10);
        resolution = estimateResolutionFromBitrate(requestedTier);
        isEstimated = true;
      }

      // --- Google DAI Fallback ---
      // If we still have no resolution, check if the URL contains a known DAI ID
      if (!resolution && availableRepresentations.length > 0) {
        // Look for any ID in the URL that matches a quality's daiId
        const match = availableRepresentations.find(r => r.daiId && pathname.includes(r.daiId));
        if (match) {
          resolution = match.height + 'p';
          exactBandwidth = match.bandwidth;
          isEstimated = false;
        }
      }
      // --- End Google DAI Fallback ---
    }

    if (!resolution && bitrate) {
      resolution = estimateResolutionFromBitrate(bitrate);
      isEstimated = true;
    }

    if (resolution || bitrate || exactBandwidth) {
      let finalBitrate = bitrate;
      if (exactBandwidth) {
        finalBitrate = Math.round(exactBandwidth / 1000);
      } else if (requestedTier) {
        finalBitrate = requestedTier;
      }

      window.postMessage({
        type: 'PARAMOUNT_QUALITY_DATA',
        payload: {
          resolution,
          isEstimated,
          bitrate: finalBitrate,
          maxBitrate,
          timestamp: Date.now()
        }
      }, '*');
    }
  } catch (e) {
    console.error('[PQI] Error analyzing URL:', e);
  }
}
