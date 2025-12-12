import { getConfig, getRepresentations } from './state.js';

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

  const hlsMatch = url.match(/manifest_video_(\d+)_(\d+)_(\d+)\.mp4/);

  if (hlsMatch) {
    const currentTier = hlsMatch[1];
    const trackIndex = hlsMatch[2];
    const segmentNum = hlsMatch[3];

    const bestRep = availableRepresentations[0];

    if (config.forceMax && bestRep && bestRep.hlsTier !== undefined) {
      const targetTier = bestRep.hlsTier;

      if (targetTier !== currentTier) {
        return url.replace(
          `manifest_video_${currentTier}_${trackIndex}_${segmentNum}.mp4`,
          `manifest_video_${targetTier}_${trackIndex}_${segmentNum}.mp4`
        );
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
