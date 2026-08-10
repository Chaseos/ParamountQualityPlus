import { estimateResolutionFromBitrate } from './constants.js';
import { getConfig, getRepresentations } from './state.js';
import {
  classifyMediaRequest,
  deriveStreamKey,
  mergeRuntimeTelemetry,
  selectRepresentation
} from './stream-model.js';

const PARAMOUNT_VOD_REP_PATTERN = /\/([^/?]+)_c(\d{2})_(\d{3,4})p_([^/?]+)_(\d{3,5})\/(seg_\d+\.m4s|init\.(?:m4s|m4v|mp4))(?=\?|$)/i;
const LEGACY_CBS_PLAIN_TIER_PATTERN = /\/([^/?]+)_(\d{5,})_(\d{3,5})\/(seg_\d+\.m4s|init\.(?:m4s|m4v|mp4))(?=\?|$)/i;
const LEGACY_CBS_VOD_HOST = 'vod-gcs-cedexis.cbsaavideo.com';
const PARAMOUNT_VOD_HOSTS = new Set([LEGACY_CBS_VOD_HOST, 'vod.pplus.paramount.tech']);
const LEGACY_CBS_PLAIN_SOURCE_TIERS = new Set(['110', '375', '750', '1500', '2100', '3000']);
const INFERRED_MAX_HEIGHT = 1080;

const INFERENCE_PROFILES = [
  {
    id: 'legacy-mastered-c23',
    matches: ({ url, contentPrefix }) => url.hostname === LEGACY_CBS_VOD_HOST &&
      /(?:^|_)(?:FTR|VMASTER|PRORES)(?:_|$)|WOLF_OF_WALL_STREET/i.test(contentPrefix),
    codecTier: '23',
    urlTier: '5400'
  },
  {
    id: 'hd-c23',
    matches: ({ contentPrefix }) => /(?:^|_)HD(?:_|$)/i.test(contentPrefix),
    codecTier: '23',
    urlTier: '5400'
  },
  {
    id: 'survivor-c23',
    matches: ({ contentPrefix }) => /(?:^|_)SURVIVOR(?:_|$)/i.test(contentPrefix),
    codecTier: '23',
    urlTier: '5400'
  },
  {
    id: 'modern-c20',
    matches: () => true,
    codecTier: '20',
    urlTier: '5400'
  }
];

let inferredFallbackState = {
  streamKey: null,
  status: 'untested',
  initializationCommitted: false
};
const rejectedAuthoritativePlans = new Set();

function passThrough(url, reason = 'unsupported') {
  return { action: 'pass-through', url, originalUrl: url, source: null, reason };
}

function buildPlan(originalUrl, targetUrl, targetRep, strategy, source = 'manifest') {
  if (!targetUrl || targetUrl === originalUrl) return passThrough(originalUrl, 'already-target');

  const streamKey = targetRep?.streamKey || deriveStreamKey(originalUrl, targetRep?.family);
  const rejectionKey = `${streamKey || 'unknown'}|${strategy}|${targetRep?.id || targetUrl}`;
  if (rejectedAuthoritativePlans.has(rejectionKey)) return passThrough(originalUrl, 'rejected');

  return {
    action: 'authoritative-rewrite',
    url: targetUrl,
    originalUrl,
    target: targetRep,
    streamKey,
    strategy,
    rejectionKey,
    source
  };
}

function getInferredRepresentationPlan(urlObj) {
  if (!PARAMOUNT_VOD_HOSTS.has(urlObj.hostname.toLowerCase()) ||
      !urlObj.pathname.toLowerCase().includes('_cenc_precon_dash/')) return null;

  const paramountMatch = urlObj.pathname.match(PARAMOUNT_VOD_REP_PATTERN);
  if (paramountMatch) {
    const [, contentPrefix, , currentHeightRaw, assetId, , segmentName] = paramountMatch;
    const profile = INFERENCE_PROFILES.find(item => item.matches({ url: urlObj, contentPrefix }));
    return {
      match: paramountMatch,
      profileId: profile.id,
      contentPrefix,
      assetId,
      segmentName,
      alreadyMax: parseInt(currentHeightRaw, 10) >= INFERRED_MAX_HEIGHT,
      targetDirectory: `${contentPrefix}_c${profile.codecTier}_${INFERRED_MAX_HEIGHT}p_${assetId}_${profile.urlTier}`
    };
  }

  const legacyMatch = urlObj.pathname.match(LEGACY_CBS_PLAIN_TIER_PATTERN);
  if (!legacyMatch) return null;
  const [, contentPrefix, assetId, currentTier, segmentName] = legacyMatch;
  if (!LEGACY_CBS_PLAIN_SOURCE_TIERS.has(currentTier)) return null;

  return {
    match: legacyMatch,
    profileId: 'plain-4500',
    contentPrefix,
    assetId,
    segmentName,
    alreadyMax: false,
    targetDirectory: `${contentPrefix}_${assetId}_4500`
  };
}

export function getInferredMaxCandidate(url, options = {}) {
  const config = getConfig();
  if (!config.forceMax || config.forcedId ||
      (!options.allowWithRepresentations && getRepresentations().length > 0)) return null;

  const request = classifyMediaRequest(url);
  if (!request.url || request.excluded) return null;

  const isInitialization = request.isInitialization;
  if (!isInitialization && request.cmcd.ot !== 'v') return null;

  const representationPlan = getInferredRepresentationPlan(request.url);
  if (!representationPlan) return null;

  const { match, contentPrefix, assetId, segmentName, targetDirectory, profileId } = representationPlan;
  const representationDirectory = match[0].slice(1, match[0].lastIndexOf(`/${segmentName}`));
  const streamPrefix = request.url.pathname.slice(0, match.index);
  const streamKey = `${request.url.origin}${streamPrefix}/${contentPrefix}_${assetId}`;

  if (inferredFallbackState.streamKey !== streamKey) {
    inferredFallbackState = { streamKey, status: 'untested', initializationCommitted: false };
  }
  if (inferredFallbackState.status === 'rejected') return null;

  const topBitrate = parseInt(request.cmcd.tb, 10);
  if (representationPlan.alreadyMax ||
      (inferredFallbackState.status !== 'validated' && !isInitialization &&
        (!topBitrate || parseInt(estimateResolutionFromBitrate(topBitrate), 10) < INFERRED_MAX_HEIGHT))) return null;

  request.url.pathname = request.url.pathname.replace(`/${representationDirectory}/`, `/${targetDirectory}/`);
  return {
    action: 'inferred-probe',
    url: request.url.toString(),
    originalUrl: url,
    streamKey,
    strategy: `paramount-vod:${profileId}`,
    mediaRole: isInitialization ? 'initialization' : 'segment',
    fallbackAllowed: isInitialization || !inferredFallbackState.initializationCommitted,
    needsValidation: inferredFallbackState.status !== 'validated',
    source: 'inferred'
  };
}

export function recordInferredFallbackResult(streamKey, succeeded, mediaRole = 'segment') {
  if (inferredFallbackState.streamKey === streamKey) {
    inferredFallbackState.status = succeeded ? 'validated' : 'rejected';
    if (succeeded && mediaRole === 'initialization') {
      inferredFallbackState.initializationCommitted = true;
    }
  }
}

export function recordAuthoritativeRewriteResult(plan, succeeded) {
  if (!plan?.rejectionKey) return;
  if (succeeded) rejectedAuthoritativePlans.delete(plan.rejectionKey);
  else rejectedAuthoritativePlans.add(plan.rejectionKey);
}

export function resetInferredFallbackState() {
  inferredFallbackState = { streamKey: null, status: 'untested', initializationCommitted: false };
  rejectedAuthoritativePlans.clear();
}

function rewriteDaiPlaylist(url, targetRep) {
  const targetUrl = targetRep.request?.variantUrl || targetRep.variantUrl;
  if (!targetUrl || !classifyMediaRequest(url).isDaiPlaylist) return null;
  return mergeRuntimeTelemetry(targetUrl, url);
}

function rewriteTieredHls(url, targetRep) {
  const targetTier = targetRep.request?.hlsTier || targetRep.hlsTier;
  if (!targetTier) return null;

  const complex = url.match(/manifest_video_(\d+)_(\d+)_([a-zA-Z0-9]+)\.(mp4|ts|m4s)/);
  if (complex) {
    return url.replace(complex[0], `manifest_video_${targetTier}_${complex[2]}_${complex[3]}.${complex[4]}`);
  }

  const simple = url.match(/manifest_(\d+)_(\d+)\.(ts|mp4|m4s|m3u8)/);
  if (simple) {
    return url.replace(simple[0], `manifest_${targetTier}_${simple[2]}.${simple[3]}`);
  }

  const targetVariant = targetRep.request?.variantUrl || targetRep.variantUrl;
  if (targetVariant && /\.m3u8(?:$|\?)/i.test(url)) {
    return mergeRuntimeTelemetry(targetVariant, url);
  }
  return null;
}

function materializeTemplate(template, targetRep, segmentNumber) {
  if (!template) return null;
  return template
    .replace(/\$Number(?:%0\d+d)?\$/g, segmentNumber)
    .replace(/\$RepresentationID\$/g, targetRep.rawId || targetRep.request?.rawId || targetRep.id)
    .replace(/\$Bandwidth\$/g, targetRep.bandwidth || targetRep.dashTier || targetRep.request?.dashTier || '');
}

export function retryRewriteUrl(url, targetRep) {
  const representations = getRepresentations();
  const targetTemplate = targetRep?.request?.template || targetRep?.template;
  if (!targetRep || !targetTemplate) return url;

  const [urlPath, query] = url.split('?');
  for (const rep of representations) {
    const template = rep.request?.template || rep.template;
    if (!template) continue;

    let pattern = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = pattern
      .replace(/\\\$Number(?:%0\d+d)?\\\$/g, '(\\d+)')
      .replace(/\\\$RepresentationID\\\$/g, '[^/]+')
      .replace(/\\\$Bandwidth\\\$/g, '\\d+');
    const match = urlPath.match(new RegExp(`${pattern}$`));
    if (!match) continue;

    const segmentNumber = match[1] || urlPath.match(/(?:seg_|segment_)(\d+)/)?.[1];
    const suffix = materializeTemplate(targetTemplate, targetRep, segmentNumber);
    return urlPath.slice(0, match.index) + suffix + (query ? `?${query}` : '');
  }
  return url;
}

function rewriteDash(url, targetRep) {
  const templated = retryRewriteUrl(url, targetRep);
  if (templated !== url) return templated;

  const targetRawId = targetRep.request?.rawId || targetRep.rawId;
  const liveId = url.match(/manifest_video_(\d+)_/);
  if (liveId && targetRawId && /^\d+$/.test(targetRawId)) {
    return url.replace(`manifest_video_${liveId[1]}_`, `manifest_video_${targetRawId}_`);
  }

  const targetPath = targetRep.request?.pathId || targetRep.pathId;
  const requestUrl = classifyMediaRequest(url).url;
  const pathParts = requestUrl?.pathname.split('/').filter(Boolean) || [];
  const currentDirectory = pathParts.length > 1 ? pathParts[pathParts.length - 2] : null;
  if (targetPath && currentDirectory && targetPath !== currentDirectory) {
    return url.replace(`/${currentDirectory}/`, `/${targetPath}/`);
  }

  const resolution = url.match(/_(\d{3,4})p_/i);
  const targetTier = targetRep.request?.dashTier || targetRep.dashTier;
  if (resolution && targetRep.height) {
    let rewritten = url.replace(`_${resolution[1]}p_`, `_${targetRep.height}p_`);
    const tier = rewritten.match(/_(\d{3,5})\/(?:seg_|init)/i);
    if (tier && targetTier) rewritten = rewritten.replace(`_${tier[1]}/`, `_${targetTier}/`);
    return rewritten;
  }

  const tier = url.match(/_(\d{3,5})\/(seg_\d+\.m4s)/i);
  return tier && targetTier ? url.replace(`_${tier[1]}/${tier[2]}`, `_${targetTier}/${tier[2]}`) : null;
}

export function planRequest(url, options = {}) {
  const config = options.config || getConfig();
  const representations = options.representations || getRepresentations();
  if (!url || (!config.forceMax && !config.forcedId)) return passThrough(url, 'disabled');

  const request = classifyMediaRequest(url);
  if (request.excluded || request.kind === 'unknown') return passThrough(url, 'excluded');

  const targetRep = selectRepresentation(representations, config);
  if (!targetRep) {
    if (options.allowInference !== false && request.kind === 'segment') {
      return getInferredMaxCandidate(url) || passThrough(url, 'no-representation');
    }
    return passThrough(url, 'no-representation');
  }

  const family = targetRep.family || targetRep.request?.family ||
    (targetRep.daiId ? 'google-dai-hls' : targetRep.hlsTier ? 'tiered-hls' : 'dash');

  // A DASH MPD describes the authoritative live/VOD ladder and must reach the
  // player unchanged. Only its initialization and media requests are eligible
  // for representation rewriting.
  if (family === 'dash' && request.kind === 'manifest') {
    return passThrough(url, 'dash-manifest-authoritative');
  }

  let targetUrl = null;
  let strategy = family;

  if (family === 'google-dai-hls') targetUrl = rewriteDaiPlaylist(url, targetRep);
  else if (family === 'tiered-hls' || family === 'hls') targetUrl = rewriteTieredHls(url, targetRep);
  else if (family === 'dash') targetUrl = rewriteDash(url, targetRep);

  const authoritativePlan = targetUrl
    ? buildPlan(url, targetUrl, targetRep, strategy)
    : passThrough(url, 'unrecognized-family-request');

  if (authoritativePlan.action !== 'pass-through') return authoritativePlan;

  // A nonempty manifest is not necessarily usable: malformed request
  // descriptors and a previously rejected authoritative rewrite should still
  // be able to use the verified Paramount VOD fallback in Force Max mode.
  if (config.forceMax && !config.forcedId && options.allowInference !== false && request.kind === 'segment' &&
      ['rejected', 'unrecognized-family-request'].includes(authoritativePlan.reason)) {
    return getInferredMaxCandidate(url, { allowWithRepresentations: true }) || authoritativePlan;
  }

  return authoritativePlan;
}

export function maybeRewriteUrl(url) {
  const plan = planRequest(url, { allowInference: false });
  return plan.action === 'authoritative-rewrite' ? plan.url : url;
}

export function resolveTargetRepresentation() {
  return selectRepresentation(getRepresentations(), getConfig());
}

export function resolveNextBestRepresentation() {
  const representations = getRepresentations();
  const target = resolveTargetRepresentation();
  const index = representations.indexOf(target);
  return index >= 0 ? representations[index + 1] : null;
}
