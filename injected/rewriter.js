import { getConfig, getRepresentations } from './state.js';
import {
  classifyMediaRequest,
  deriveStreamKey,
  getHlsTier,
  mergeRuntimeTelemetry,
  selectRepresentation
} from './stream-model.js';
import {
  canFallbackToOriginal,
  getInferredMaxCandidate,
  isAuthoritativePlanRejected,
  recordAuthoritativeRewriteResult,
  recordInferredFallbackResult,
  resetInferredFallbackState
} from './inferred-vod.js';

export {
  canFallbackToOriginal,
  getInferredMaxCandidate,
  recordAuthoritativeRewriteResult,
  recordInferredFallbackResult,
  resetInferredFallbackState
} from './inferred-vod.js';

function passThrough(url, reason = 'unsupported') {
  return { action: 'pass-through', url, originalUrl: url, source: null, reason };
}

function buildPlan(originalUrl, targetUrl, targetRep, strategy, source = 'manifest') {
  if (!targetUrl || targetUrl === originalUrl) return passThrough(originalUrl, 'already-target');

  const streamKey = targetRep?.streamKey || deriveStreamKey(originalUrl, targetRep?.family);
  const rejectionKey = `${streamKey || 'unknown'}|${strategy}|${targetRep?.id || targetUrl}`;
  if (isAuthoritativePlanRejected(rejectionKey)) return passThrough(originalUrl, 'rejected');

  return {
    action: 'authoritative-rewrite',
    url: targetUrl,
    originalUrl,
    target: targetRep,
    streamKey,
    strategy,
    rejectionKey,
    mediaRole: classifyMediaRequest(originalUrl).isInitialization ? 'initialization' : 'segment',
    source
  };
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

function getTemplatePath(template) {
  if (!template) return null;
  const value = String(template);
  try {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return new URL(value).pathname;
  } catch {
    // Fall back to treating malformed or relative templates as path text.
  }
  return value.split(/[?#]/, 1)[0];
}

function materializeTemplate(template, targetRep, segmentNumber) {
  const templatePath = getTemplatePath(template);
  if (!templatePath) return null;
  return templatePath
    .replace(/\$Number(?:%0\d+d)?\$/g, segmentNumber)
    .replace(/\$RepresentationID\$/g, targetRep.rawId || targetRep.request?.rawId || targetRep.id)
    .replace(/\$Bandwidth\$/g, targetRep.bandwidth || targetRep.dashTier || targetRep.request?.dashTier || '');
}

function getRepresentationVariants(representation) {
  return representation?.variants?.length ? representation.variants : [representation];
}

function getAllRepresentationVariants(representations) {
  return representations.flatMap(getRepresentationVariants).filter(Boolean);
}

function matchTemplate(urlPath, template) {
  const templatePath = getTemplatePath(template);
  if (!templatePath) return null;
  let pattern = templatePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  pattern = pattern
    .replace(/\\\$Number(?:%0\d+d)?\\\$/g, '(\\d+)')
    .replace(/\\\$RepresentationID\\\$/g, '[^/]+')
    .replace(/\\\$Bandwidth\\\$/g, '\\d+');
  return urlPath.match(new RegExp(`${pattern}$`));
}

function representationMatchesRequest(url, representation) {
  const requestUrl = classifyMediaRequest(url).url;
  if (!requestUrl || !representation) return false;
  const urlPath = requestUrl.pathname;
  const directory = urlPath.split('/').filter(Boolean).at(-2) || null;
  const pathId = representation.request?.pathId || representation.pathId;
  if (pathId && directory === pathId) return true;

  const requestHlsTier = getHlsTier(requestUrl);
  const representationHlsTier = String(representation.request?.hlsTier || representation.hlsTier || '');
  if (requestHlsTier && representationHlsTier && requestHlsTier === representationHlsTier) return true;

  const variantUrl = representation.request?.variantUrl || representation.variantUrl;
  if (variantUrl) {
    try {
      const variant = new URL(variantUrl, requestUrl);
      if (variant.origin === requestUrl.origin && variant.pathname === requestUrl.pathname) return true;
    } catch {
      // Fall through to template matching.
    }
  }

  return [
    representation.request?.initialization || representation.initialization,
    representation.request?.template || representation.template
  ].some(template => Boolean(matchTemplate(urlPath, template)));
}

function getParamountVodIdentity(value) {
  const path = getTemplatePath(value);
  if (!path) return null;

  for (const encodedSegment of path.split('/').filter(Boolean).reverse()) {
    let segment = encodedSegment;
    try {
      segment = decodeURIComponent(encodedSegment);
    } catch {
      // A malformed escape should not prevent checking the raw path segment.
    }
    const modernMatch = segment.match(/^(.+)_c\d+_\d{3,4}p_([^/_]+)_\d{2,6}$/i);
    if (modernMatch) return `${modernMatch[1]}|${modernMatch[2]}`;

    // Older catalog entries (including early NCIS seasons) use
    // TITLE_ASSETID_BITRATETIER without codec or height markers.
    const legacyMatch = segment.match(/^(.+)_([^/_]+)_\d{2,6}$/);
    if (legacyMatch) return `${legacyMatch[1]}|${legacyMatch[2]}`;
  }
  return null;
}

function getRepresentationVodIdentity(representation) {
  return [
    representation?.request?.pathId,
    representation?.pathId,
    representation?.request?.baseUrl,
    representation?.baseUrl,
    representation?.request?.initialization,
    representation?.initialization,
    representation?.request?.template,
    representation?.template
  ].map(getParamountVodIdentity).find(Boolean) || null;
}

function resolveParamountVodTarget(request, selectedVariants) {
  const hostname = request.url?.hostname.toLowerCase();
  const isParamountVodHost = hostname === 'vod.pplus.paramount.tech' ||
    hostname === 'vod-gcs-cedexis.cbsaavideo.com';
  if (request.isLive || !isParamountVodHost ||
      !request.url.pathname.includes('_cenc_precon_dash/')) return null;

  const requestIdentity = getParamountVodIdentity(request.url.pathname);
  if (!requestIdentity) return null;
  return selectedVariants.find(rep => getRepresentationVodIdentity(rep) === requestIdentity) || null;
}

function resolveCompatibleTarget(url, selectedRepresentation, representations) {
  if (!selectedRepresentation) return null;
  const allVariants = getAllRepresentationVariants(representations);
  const selectedVariants = getRepresentationVariants(selectedRepresentation);
  const matchingSources = allVariants.filter(rep => representationMatchesRequest(url, rep));
  const matchingCompatibilityKeys = new Set(
    matchingSources.map(rep => rep.compatibilityKey).filter(Boolean)
  );
  // A tier/path reused by multiple codec families is still ambiguous. Only
  // select a source family when every matching descriptor agrees.
  const source = matchingCompatibilityKeys.size <= 1 ? matchingSources[0] : null;

  if (source?.compatibilityKey) {
    const exactCompatibleTarget = selectedVariants.find(rep => rep.compatibilityKey === source.compatibilityKey);
    if (exactCompatibleTarget) return exactCompatibleTarget;
  }

  const request = classifyMediaRequest(url);
  // Some Paramount VOD MPDs split one title's video ladder across periods, so
  // the currently requested directory may not be present in the parsed ladder.
  // The directory still carries a stable title prefix and asset ID. Matching
  // both lets us use an authoritative selected path without weakening the
  // compatibility rules for live streams, ads, previews, or unrelated titles.
  const vodTarget = resolveParamountVodTarget(request, selectedVariants);
  if (vodTarget) return vodTarget;

  const compatibilityKeys = new Set(allVariants.map(rep => rep.compatibilityKey).filter(Boolean));
  // Once a manifest provides compatibility metadata, an unmatched request is
  // not safe to guess. This prevents unrelated MP4s and auxiliary media from
  // inheriting the active video's representation directory.
  if (!source && compatibilityKeys.size > 0) return null;
  if (compatibilityKeys.size > 1) return null;
  return selectedVariants[0] || selectedRepresentation;
}

export function retryRewriteUrl(url, targetRep) {
  const representations = getRepresentations();
  if (!targetRep) return url;

  const [urlPath, query] = url.split('?');
  for (const rep of getAllRepresentationVariants(representations)) {
    const templates = [
      {
        source: rep.request?.initialization || rep.initialization,
        target: targetRep.request?.initialization || targetRep.initialization
      },
      {
        source: rep.request?.template || rep.template,
        target: targetRep.request?.template || targetRep.template
      }
    ];

    for (const { source: template, target: targetTemplate } of templates) {
      if (!template || !targetTemplate) continue;

      const match = matchTemplate(urlPath, template);
      if (!match) continue;

      const segmentNumber = match[1] || urlPath.match(/(?:seg_|segment_)(\d+)/)?.[1] || '';
      const suffix = materializeTemplate(targetTemplate, targetRep, segmentNumber);
      return urlPath.slice(0, match.index) + suffix + (query ? `?${query}` : '');
    }
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
  if (!url || (!config.forceMax && !config.forcedId && !config.forcedHeight)) return passThrough(url, 'disabled');

  const request = classifyMediaRequest(url);
  if (request.excluded || request.kind === 'unknown') return passThrough(url, 'excluded');
  const canUseInferredFallback = config.forceMax && !config.forcedId && !config.forcedHeight &&
    options.allowInference !== false && request.kind === 'segment';

  const selectedRep = selectRepresentation(representations, config);
  if (!selectedRep) {
    if (canUseInferredFallback) return getInferredMaxCandidate(url, { config }) || passThrough(url, 'no-representation');
    return passThrough(url, 'no-representation');
  }

  const targetRep = resolveCompatibleTarget(url, selectedRep, representations);
  if (!targetRep) {
    const incompatiblePlan = passThrough(url, 'no-compatible-representation');
    // Some Paramount DAI manifests expose the quality ladder but omit enough
    // request metadata that the active source representation cannot be mapped
    // to a codec/period variant. The pre-week implementation still handled
    // these VOD paths by rewriting their representation directory. Preserve
    // the codec-safe default for generic streams, but let Force Max use the
    // validated c20/c23 Paramount fallback when this exact mapping is missing.
    if (canUseInferredFallback) {
      return getInferredMaxCandidate(url, { allowWithRepresentations: true, config }) || incompatiblePlan;
    }
    return incompatiblePlan;
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
  if (canUseInferredFallback &&
      ['rejected', 'unrecognized-family-request'].includes(authoritativePlan.reason)) {
    return getInferredMaxCandidate(url, { allowWithRepresentations: true, config }) || authoritativePlan;
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
