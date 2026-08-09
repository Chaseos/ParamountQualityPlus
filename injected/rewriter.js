import { getConfig, getRepresentations } from './state.js';
import { estimateResolutionFromBitrate } from './constants.js';

const PARAMOUNT_VOD_REP_PATTERN = /\/([^/?]+)_c(\d{2})_(\d{3,4})p_([^/?]+)_(\d{3,5})\/(seg_\d+\.m4s|init\.m4v)(?=\?|$)/i;
const LEGACY_CBS_PLAIN_TIER_PATTERN = /\/([^/?]+)_(\d{5,})_(\d{3,5})\/(seg_\d+\.m4s|init\.m4v)(?=\?|$)/i;
const DEFAULT_INFERRED_MAX_CODEC_TIER = '20';
const LEGACY_CBS_VOD_HOST = 'vod-gcs-cedexis.cbsaavideo.com';
const LEGACY_CBS_INFERRED_MAX_CODEC_TIER = '23';
const LEGACY_CBS_PLAIN_MAX_URL_TIER = '4500';
const LEGACY_CBS_PLAIN_SOURCE_TIERS = new Set(['110', '375', '750', '1500', '2100', '3000']);
const PARAMOUNT_VOD_HOSTS = new Set([
  LEGACY_CBS_VOD_HOST,
  'vod.pplus.paramount.tech'
]);
const INFERRED_MAX_HEIGHT = 1080;
const INFERRED_MAX_URL_TIER = '5400';

let inferredFallbackState = {
  streamKey: null,
  status: 'untested'
};

function parseCmcd(urlObj) {
  const raw = urlObj.searchParams.get('CMCD');
  if (!raw) return {};

  const values = {};
  for (const pair of raw.split(',')) {
    const separator = pair.indexOf('=');
    if (separator === -1) {
      values[pair] = true;
    } else {
      values[pair.slice(0, separator)] = pair.slice(separator + 1).replace(/^"|"$/g, '');
    }
  }
  return values;
}

function isExcludedFromInference(urlObj, cmcd) {
  const lower = urlObj.toString().toLowerCase();
  return cmcd.ot !== 'v' ||
    lower.includes('_aac_') ||
    lower.includes('/audio/') ||
    lower.includes('_audio_') ||
    lower.includes('googlevideo') ||
    lower.includes('doubleclick') ||
    lower.includes('/dai/') ||
    lower.includes('/ads/') ||
    lower.includes('/measurements/') ||
    lower.includes('/thumb') ||
    lower.includes('.vtt') ||
    lower.includes('.jpg');
}

function getInferredMaxCodecTier(urlObj, contentPrefix) {
  const isLegacyNamedAsset = urlObj.hostname.toLowerCase() === LEGACY_CBS_VOD_HOST &&
    !/^\d+$/.test(contentPrefix);
  const isHdPipeline = /(?:^|_)HD(?:_|$)/i.test(contentPrefix);
  return isLegacyNamedAsset || isHdPipeline
    ? LEGACY_CBS_INFERRED_MAX_CODEC_TIER
    : DEFAULT_INFERRED_MAX_CODEC_TIER;
}

function getInferredRepresentationPlan(urlObj) {
  const isVerifiedParamountVod = PARAMOUNT_VOD_HOSTS.has(urlObj.hostname.toLowerCase()) &&
    urlObj.pathname.toLowerCase().includes('_cenc_precon_dash/');
  if (!isVerifiedParamountVod) return null;

  const paramountMatch = urlObj.pathname.match(PARAMOUNT_VOD_REP_PATTERN);
  if (paramountMatch) {
    const [, contentPrefix, , currentHeightRaw, assetId, , segmentName] = paramountMatch;
    const maxCodecTier = getInferredMaxCodecTier(urlObj, contentPrefix);
    return {
      match: paramountMatch,
      contentPrefix,
      assetId,
      segmentName,
      alreadyMax: parseInt(currentHeightRaw, 10) >= INFERRED_MAX_HEIGHT,
      targetDirectory: `${contentPrefix}_c${maxCodecTier}_${INFERRED_MAX_HEIGHT}p_${assetId}_${INFERRED_MAX_URL_TIER}`
    };
  }

  const legacyMatch = urlObj.pathname.match(LEGACY_CBS_PLAIN_TIER_PATTERN);
  if (!legacyMatch) return null;

  const [, contentPrefix, assetId, currentTier, segmentName] = legacyMatch;
  if (!LEGACY_CBS_PLAIN_SOURCE_TIERS.has(currentTier)) return null;

  return {
    match: legacyMatch,
    contentPrefix,
    assetId,
    segmentName,
    alreadyMax: false,
    targetDirectory: `${contentPrefix}_${assetId}_${LEGACY_CBS_PLAIN_MAX_URL_TIER}`
  };
}

// Build a single conservative max-quality candidate for the Paramount VOD
// directory shape observed when a manifest has not populated representations.
// The candidate must still be validated by the network hook before it is reused.
export function getInferredMaxCandidate(url) {
  const config = getConfig();
  if (!config.forceMax || config.forcedId || getRepresentations().length > 0) return null;

  let urlObj;
  try {
    urlObj = new URL(url, window.location.origin);
  } catch {
    return null;
  }

  const cmcd = parseCmcd(urlObj);
  if (isExcludedFromInference(urlObj, cmcd)) return null;

  const representationPlan = getInferredRepresentationPlan(urlObj);
  if (!representationPlan) return null;

  const { match, contentPrefix, assetId, segmentName, alreadyMax, targetDirectory } = representationPlan;
  const topBitrate = parseInt(cmcd.tb, 10);
  if (!topBitrate || alreadyMax) return null;

  const estimatedMax = parseInt(estimateResolutionFromBitrate(topBitrate), 10);
  if (estimatedMax < INFERRED_MAX_HEIGHT) return null;

  const matchStart = match.index;
  const representationDirectory = match[0].slice(1, match[0].lastIndexOf(`/${segmentName}`));
  const streamPrefix = urlObj.pathname.slice(0, matchStart);
  const streamKey = `${urlObj.origin}${streamPrefix}/${contentPrefix}_${assetId}`;

  if (inferredFallbackState.streamKey !== streamKey) {
    inferredFallbackState = { streamKey, status: 'untested' };
  }
  if (inferredFallbackState.status === 'rejected') return null;

  urlObj.pathname = urlObj.pathname.replace(`/${representationDirectory}/`, `/${targetDirectory}/`);

  return {
    url: urlObj.toString(),
    streamKey,
    needsValidation: inferredFallbackState.status !== 'validated',
    source: 'inferred'
  };
}

export function recordInferredFallbackResult(streamKey, succeeded) {
  if (inferredFallbackState.streamKey !== streamKey) return;
  inferredFallbackState.status = succeeded ? 'validated' : 'rejected';
}

export function resetInferredFallbackState() {
  inferredFallbackState = { streamKey: null, status: 'untested' };
}

// Pick the representation the user requested (forcedId) or the highest tier
// when forceMax is enabled. Returns null if nothing is selected or known.
function resolveTargetRepresentation() {
  const config = getConfig();
  const availableRepresentations = getRepresentations();

  if (availableRepresentations.length === 0) return null;

  if (config.forcedId) {
    return availableRepresentations.find(r => r.id === config.forcedId) || null;
  }

  if (config.forceMax) {
    return availableRepresentations[0];
  }

  return null;
}

// Attempt a second pass rewrite using the DASH SegmentTemplate syntax so the
// extension can swap in a different representation ID/bandwidth while
// preserving the segment number from the original URL.
export function retryRewriteUrl(url, targetRep) {
  const availableRepresentations = getRepresentations();
  if (!targetRep || !targetRep.template) return url;

  for (const [index, rep] of availableRepresentations.entries()) {
    if (!rep.template) continue;

    let pattern = rep.template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = pattern.replace(/\\\$Number\\\$/g, '(\\d+)');
    pattern = pattern.replace(/\\\$RepresentationID\\\$/g, '[^/]+');
    pattern = pattern.replace(/\\\$Bandwidth\\\$/g, '\\d+');

    const regex = new RegExp(pattern + '$');

    const parts = url.split('?');
    const urlPath = parts[0];

    const match = urlPath.match(regex);
    if (match) {
      const simpleMatch = url.match(/seg_(\d+)\./) || url.match(/segment_(\d+)_/);
      const segmentNum = simpleMatch ? simpleMatch[1] : match[1];

      if (rep.id === targetRep.id) {
        return url;
      }

      const matchIndex = match.index;
      const urlPrefix = urlPath.substring(0, matchIndex);

      let newSuffix = targetRep.template;
      newSuffix = newSuffix.replace('$Number$', segmentNum);
      newSuffix = newSuffix.replace('$RepresentationID$', targetRep.id);

      if (targetRep.dashTier) {
        newSuffix = newSuffix.replace('$Bandwidth$', targetRep.dashTier);
      } else if (targetRep.bandwidth) {
        newSuffix = newSuffix.replace('$Bandwidth$', targetRep.bandwidth);
      }

      return urlPrefix + newSuffix + (parts[1] ? '?' + parts[1] : '');
    }
  }

  return url;
}

// Apply quality overrides to an incoming media segment URL when configured to
// force a specific representation or highest available tier.
export function maybeRewriteUrl(url) {
  const availableRepresentations = getRepresentations();
  const config = getConfig();

  if (availableRepresentations.length === 0) return url;

  const adStrings = ['google', 'dai', 'doubleclick', 'video_ads', 'googlevideo', 'dclk', '/ad/', '_ad_', 'ads/'];
  const lowerUrl = url.toLowerCase();
  const isAd = adStrings.some(s => lowerUrl.includes(s));

  // Google DAI variant playlists (/variant/....m3u8) are the target of our quality switching
  // for live streams, so do NOT skip them even though they match 'google/dai'.
  const isDaiPlaylist = lowerUrl.includes('/variant/') && lowerUrl.includes('.m3u8');

  if (isAd && !isDaiPlaylist) {
    return url;
  }

  // --- Google DAI Live Stream Logic ---
  // We rewrite the Playlist URL itself, not the segments.

  if (config.forceMax || config.forcedId) {
    let targetRep = null;
    if (config.forcedId) {
      targetRep = availableRepresentations.find(r => r.id === config.forcedId);
    } else if (config.forceMax) {
      targetRep = availableRepresentations.find(r => r.height >= 1080) || availableRepresentations[0];
    }

    if (targetRep && targetRep.daiId) {
      // Check if this is a Variant Playlist URL (contains /variant/{ID}/)
      const idMatch = url.match(/\/variant\/([a-f0-9]{32})\//);
      if (idMatch) {
        const currentId = idMatch[1];
        if (currentId !== targetRep.daiId) {
          return url.replace(currentId, targetRep.daiId);
        }
      }
    }
  }
  // --- End DAI Logic ---

  // Allow 'init' or other alphanumeric strings in the 3rd group
  const hlsMatch = url.match(/manifest_video_(\d+)_(\d+)_([a-zA-Z0-9]+)\.(mp4|ts|m4s)/);
  const hlsMatchSimple = url.match(/manifest_(\d+)_(\d+)\.(ts|mp4|m4s)/);

  if (hlsMatch || hlsMatchSimple) {
    const match = hlsMatch || hlsMatchSimple;
    const isComplex = !!hlsMatch;
    const currentTier = match[1];
    const part2 = match[2];
    const part3 = isComplex ? match[3] : null;
    const ext = isComplex ? match[4] : match[3];

    if (config.forceMax || config.forcedId) {
      let targetTier = null;

      if (config.forcedId) {
        const targetRep = availableRepresentations.find(r => r.id === config.forcedId);
        if (targetRep) {
          if (targetRep.hlsTier) {
            targetTier = targetRep.hlsTier;
          } else if (targetRep.rawId && targetRep.rawId.length <= 2) {
            // Hybrid logic: Use numeric rawId as tier if it's a short string (1, 2, 8 etc)
            targetTier = targetRep.rawId;
          } else {
            // Cross-format fallback: try to find an HLS tier or rawId with the same height
            const matchRep = availableRepresentations.find(r => r.height === targetRep.height && (r.hlsTier || (r.rawId && r.rawId.length <= 2)));
            if (matchRep) {
              targetTier = matchRep.hlsTier || matchRep.rawId;
            }
          }
        }
      } else if (config.forceMax) {
        // Find best tier from any representation that has one
        const bestWithTier = availableRepresentations.find(r => r.hlsTier || (r.rawId && r.rawId.length <= 2));
        if (bestWithTier) targetTier = bestWithTier.hlsTier || bestWithTier.rawId;
      }

      if (targetTier && targetTier !== currentTier) {
        let newUrl;
        if (isComplex) {
          newUrl = url.replace(
            `manifest_video_${currentTier}_${part2}_${part3}.${ext}`,
            `manifest_video_${targetTier}_${part2}_${part3}.${ext}`
          );
        } else {
          newUrl = url.replace(
            `manifest_${currentTier}_${part2}.${ext}`,
            `manifest_${targetTier}_${part2}.${ext}`
          );
        }
        return newUrl;
      }
    }

    return url;
  }

  if (url.includes('_aac_') || url.includes('/audio/') || url.includes('_audio_')) {
    return url;
  }

  if (config.forceMax || config.forcedId) {
    let targetRep = null;
    if (config.forcedId) {
      targetRep = availableRepresentations.find(r => r.id === config.forcedId);
      if (!targetRep) {
        console.warn(`[PQI] ForcedID "${config.forcedId}" NOT FOUND.`);
        return url;
      }
    } else {
      targetRep = availableRepresentations[0];
    }

    if (!targetRep) return url;

    if (targetRep.template) {
      const rewritten = retryRewriteUrl(url, targetRep);
      if (rewritten !== url) {
        return rewritten;
      }
    }

    const resMatch = url.match(/_(\d{3,4}p)_/);
    if (resMatch) {
      const currentRes = resMatch[1];
      const targetRes = targetRep.height + 'p';

      if (currentRes !== targetRes) {
        let newUrl = url.replace(`_${currentRes}_`, `_${targetRes}_`);

        // --- DASH Strategy 1: Path Swap (Robust segment replacement) ---
        if (targetRep.pathId || targetRep.dashTier) {
          const currentIdSegmentMatch = url.match(/\/([^\/?]+)(?=\/[^\/]*?seg_)/i);
          if (currentIdSegmentMatch) {
            const currentIdSegment = currentIdSegmentMatch[1];
            const targetIdSegment = targetRep.pathId || targetRep.id;

            // Only swap if the target is a complex string (to avoid mangling or numeric IDs)
            if (targetIdSegment && targetIdSegment.includes('_') && !targetIdSegment.includes('$') && currentIdSegment !== targetIdSegment) {
              return url.replace(`/${currentIdSegment}/`, `/${targetIdSegment}/`);
            }
          }
        }

        // --- DASH Strategy 2: Targeted Bitrate Replacement (Fallback) ---
        if (targetRep.dashTier) {
          const bitrateMatch = url.match(/_(\d{3,5})\/seg_/);
          if (bitrateMatch) {
            const currentBitrate = bitrateMatch[1];
            if (currentBitrate !== targetRep.dashTier) {
              newUrl = newUrl.replace(`_${currentBitrate}/seg_`, `_${targetRep.dashTier}/seg_`);
            }
          }
        }
        return newUrl;
      }
    }

    const dashBitrateMatch = url.match(/_(\d{3,5})\/seg_(\d+)\.m4s/);
    if (dashBitrateMatch) {
      const currentBitrate = dashBitrateMatch[1];
      const segmentNum = dashBitrateMatch[2];

      if (targetRep.dashTier) {
        const targetBitrate = targetRep.dashTier;
        if (targetBitrate !== currentBitrate) {
          return url.replace(`_${currentBitrate}/seg_${segmentNum}.m4s`, `_${targetBitrate}/seg_${segmentNum}.m4s`);
        }
      }
    }

    return url;
  }

  if (config.forcedId) {
    const targetRep = availableRepresentations.find(r => r.id === config.forcedId);
    if (targetRep) {
      return retryRewriteUrl(url, targetRep);
    }
  }

  if (config.forceMax) {
    const bestRep = availableRepresentations.find(r => r.height >= 1080) || availableRepresentations[0];
    return retryRewriteUrl(url, bestRep);
  }

  return url;
}

// When a rewrite fails, this picks the next best option below the current max
// so the fallback still prioritizes high quality without being too aggressive.
export function resolveNextBestRepresentation() {
  const availableRepresentations = getRepresentations();
  const maxRep = availableRepresentations.find(r => r.height >= 1080) || availableRepresentations[0];
  const currentIndex = availableRepresentations.indexOf(maxRep);
  return availableRepresentations[currentIndex + 1];
}

export { resolveTargetRepresentation };
