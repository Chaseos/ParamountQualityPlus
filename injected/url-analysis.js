import { estimateResolutionFromBitrate } from './constants.js';
import { extractResolutionFromPath, isSegmentUrl } from './url-utils.js';
import { getRepresentations } from './state.js';
import { classifyMediaRequest, deriveStreamKey } from './stream-model.js';

function matchRepresentationByBitrate(representations, bitrateKbps) {
  if (!bitrateKbps) return null;

  const bitrateBps = bitrateKbps * 1000;
  const candidates = representations
    .filter(rep => Number.isFinite(rep.bandwidth) && rep.bandwidth > 0)
    .map(rep => ({ rep, difference: Math.abs(rep.bandwidth - bitrateBps) }))
    .sort((a, b) => a.difference - b.difference);
  const closest = candidates[0];
  if (!closest) return null;

  // CMCD bitrate values are rounded and can differ slightly from the MPD's
  // BANDWIDTH value. Keep the match tight enough to avoid confusing adjacent
  // representations while still accepting normal rounding difference.
  const tolerance = Math.max(75000, closest.rep.bandwidth * 0.05);
  return closest.difference <= tolerance ? closest.rep : null;
}

function toNumber(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function analyzeUrl(url, options = {}) {
  try {
    if (!isSegmentUrl(url)) return;

    const request = classifyMediaRequest(url);
    if (!request.url || request.excluded) return;
    const urlObj = request.url;
    const pathname = urlObj.pathname;

    const targetHeight = toNumber(options.targetHeight);
    const targetBitrateKbps = toNumber(options.targetBitrateKbps);
    const targetSource = options.targetSource || options.source;

    const cmcdParam = urlObj.searchParams.get('CMCD');

    const availableRepresentations = getRepresentations();
    const resolutionMatch = extractResolutionFromPath(pathname);
    const pathResolution = toNumber(resolutionMatch);

    let resolution = null;
    let isEstimated = false;
    let exactBandwidth = null;
    let telemetryConflictsWithPath = false;
    let source = options.rewritten ? (targetSource || 'inferred') : 'inferred';

    // Use the rewrite target directly when available so the UI reflects the
    // negotiated representation rather than an older path segment.
    if (Number.isFinite(targetHeight)) {
      resolution = `${targetHeight}p`;
      exactBandwidth = Number.isFinite(targetBitrateKbps)
        ? targetBitrateKbps * 1000
        : null;
      isEstimated = false;
      source = targetSource || 'inferred';
    }

    let bitrate = null;
    let maxBitrate = null;

    if (cmcdParam) {
      bitrate = Number.parseInt(request.cmcd.br, 10) || null;
      maxBitrate = Number.parseInt(request.cmcd.tb, 10) || null;
    }

    const manifestMaxBandwidth = availableRepresentations.reduce((maximum, rep) =>
      Number.isFinite(rep.bandwidth) ? Math.max(maximum, rep.bandwidth) : maximum, 0);
    if (manifestMaxBandwidth > 0) {
      // Live CMCD `tb` is sometimes stale (or even drops to the current `br`)
      // after URL rewriting. The active manifest is the authoritative ladder.
      maxBitrate = Math.round(manifestMaxBandwidth / 1000);
    }

    const hlsTierMatch = pathname.match(/manifest(?:_video)?_(\d+)[_\/]/);
    const dashTierMatch = pathname.match(/_(\d{3,5})\/(?:seg_|init)/i);
    const requestedTier = dashTierMatch ? toNumber(dashTierMatch[1]) : null;

    if (!resolution && availableRepresentations.length > 0) {
      const bitrateMatch = bitrate ? matchRepresentationByBitrate(availableRepresentations, bitrate) : null;
      const pathMatch = pathResolution
        ? availableRepresentations.find(r => r.height === pathResolution)
        : null;
      // A representation directory is the media actually requested. CMCD can
      // lag during switches, so use bitrate matching only when the path does
      // not identify a known representation.
      telemetryConflictsWithPath = Boolean(pathMatch && bitrateMatch && bitrateMatch.height !== pathMatch.height);
      const manifestMatch = pathMatch || bitrateMatch;

      if (manifestMatch) {
        resolution = `${manifestMatch.height}p`;
        exactBandwidth = manifestMatch.bandwidth || (manifestMatch.dashTier ? toNumber(manifestMatch.dashTier) * 1000 : null);
        isEstimated = false;
        source = 'manifest';
      }
    }

    if (!resolution && resolutionMatch) {
      resolution = resolutionMatch;
      isEstimated = false;
    }

    if (!resolution && dashTierMatch) {
      const match = availableRepresentations.find(r => r.dashTier === dashTierMatch[1]);
      if (match) {
        resolution = match.height + 'p';
        exactBandwidth = match.bandwidth;
        isEstimated = false;
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

    // Fallback: use bitrate when no exact directory/manifest match exists.
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
      } else if (options.rewritten && Number.isFinite(targetBitrateKbps)) {
        finalBitrate = targetBitrateKbps;
      } else if (options.rewritten && requestedTier) {
        finalBitrate = requestedTier;
      } else if (telemetryConflictsWithPath && exactBandwidth) {
        finalBitrate = Math.round(exactBandwidth / 1000);
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
          streamKey: deriveStreamKey(urlObj),
          rewritten: options.rewritten === true,
          observationSequence: toNumber(options.observationSequence),
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
