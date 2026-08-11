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
    id: 'legacy-catalog-c23',
    matches: ({ url }) => {
      if (url.hostname !== LEGACY_CBS_VOD_HOST) return false;
      // Older catalog assets use c23 on this shared host; newer releases on
      // the same host can use c20. The inferred request is still validated.
      const year = Number.parseInt(url.pathname.match(/\/intl_vms\/(\d{4})\//i)?.[1], 10);
      return Number.isFinite(year) && year <= 2021;
    },
    codecTier: '23',
    urlTier: '5400'
  },
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

function createInferredFallbackState(streamKey = null) {
  return { streamKey, status: 'untested', targetDirectory: null };
}

let inferredFallbackState = createInferredFallbackState();
const rejectedAuthoritativePlans = new Set();
const committedRewriteStreams = new Set();

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
    mediaRole: classifyMediaRequest(originalUrl).isInitialization ? 'initialization' : 'segment',
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
      targetDirectory: `${contentPrefix}_c${profile.codecTier}_${INFERRED_MAX_HEIGHT}p_${assetId}_${profile.urlTier}`,
      alternateTargets: ['20', '23']
        .filter(codecTier => codecTier !== profile.codecTier)
        .map(codecTier => ({
          profileId: `validated-c${codecTier}`,
          targetDirectory: `${contentPrefix}_c${codecTier}_${INFERRED_MAX_HEIGHT}p_${assetId}_${profile.urlTier}`
        }))
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
  const config = options.config || getConfig();
  if (!config.forceMax || config.forcedId || config.forcedHeight ||
      (!options.allowWithRepresentations && getRepresentations().length > 0)) return null;

  const request = classifyMediaRequest(url);
  if (!request.url || request.excluded) return null;

  const isInitialization = request.isInitialization;
  if (!isInitialization && request.cmcd.ot && request.cmcd.ot !== 'v') return null;

  const representationPlan = getInferredRepresentationPlan(request.url);
  if (!representationPlan) return null;

  const { match, contentPrefix, assetId, segmentName, targetDirectory, profileId } = representationPlan;
  const representationDirectory = match[0].slice(1, match[0].lastIndexOf(`/${segmentName}`));
  const streamPrefix = request.url.pathname.slice(0, match.index);
  const streamKey = `${request.url.origin}${streamPrefix}/${contentPrefix}_${assetId}`;

  if (inferredFallbackState.streamKey !== streamKey) {
    inferredFallbackState = createInferredFallbackState(streamKey);
  }
  if (inferredFallbackState.status === 'rejected') return null;

  const topBitrate = parseInt(request.cmcd.tb, 10);
  if (representationPlan.alreadyMax ||
      (inferredFallbackState.status !== 'validated' && !isInitialization &&
        topBitrate && parseInt(estimateResolutionFromBitrate(topBitrate), 10) < INFERRED_MAX_HEIGHT)) return null;

  const targets = [
    { targetDirectory, profileId },
    ...(representationPlan.alternateTargets || [])
  ];
  if (inferredFallbackState.status === 'validated' && inferredFallbackState.targetDirectory) {
    targets.sort((left, right) =>
      Number(right.targetDirectory === inferredFallbackState.targetDirectory) -
      Number(left.targetDirectory === inferredFallbackState.targetDirectory));
  }

  const candidates = targets
    .filter((candidate, index, items) =>
      items.findIndex(item => item.targetDirectory === candidate.targetDirectory) === index)
    .map(candidate => {
      const target = new URL(request.url);
      target.pathname = target.pathname.replace(
        `/${representationDirectory}/`,
        `/${candidate.targetDirectory}/`
      );
      let validationUrl = null;
      if (isInitialization) {
        const validation = new URL(target);
        validation.pathname = validation.pathname.replace(/\/init\.(?:m4s|m4v|mp4)$/i, '/seg_1.m4s');
        validationUrl = validation.toString();
      }
      return {
        ...candidate,
        url: target.toString(),
        validationUrl,
        strategy: `paramount-vod:${candidate.profileId}`
      };
    });
  const selectedCandidate = candidates[0];
  return {
    action: 'inferred-probe',
    url: selectedCandidate.url,
    validationUrl: selectedCandidate.validationUrl,
    candidates,
    originalUrl: url,
    streamKey,
    strategy: selectedCandidate.strategy,
    mediaRole: isInitialization ? 'initialization' : 'segment',
    targetHeight: INFERRED_MAX_HEIGHT,
    targetBitrateKbps: Number.isFinite(topBitrate) ? topBitrate : null,
    targetSource: 'inferred',
    needsValidation: inferredFallbackState.status !== 'validated',
    source: 'inferred'
  };
}

export function recordInferredFallbackResult(streamKey, succeeded, mediaRole = null, candidate = null) {
  if (inferredFallbackState.streamKey === streamKey) {
    if (!succeeded && committedRewriteStreams.has(streamKey)) return;
    inferredFallbackState.status = succeeded ? 'validated' : 'rejected';
    inferredFallbackState.targetDirectory = succeeded ? (candidate?.targetDirectory || null) : null;
    // A background XHR probe validates a path but does not deliver rewritten
    // media. Commit only after fetch/XHR reports an actual media role.
    if (succeeded && mediaRole) committedRewriteStreams.add(streamKey);
  }
}

export function recordAuthoritativeRewriteResult(plan, succeeded) {
  if (!plan?.rejectionKey) return;
  if (succeeded) {
    rejectedAuthoritativePlans.delete(plan.rejectionKey);
    if (plan.streamKey) committedRewriteStreams.add(plan.streamKey);
  }
  else if (!committedRewriteStreams.has(plan.streamKey)) rejectedAuthoritativePlans.add(plan.rejectionKey);
}

export function canFallbackToOriginal(plan) {
  return !plan?.streamKey || !committedRewriteStreams.has(plan.streamKey);
}

export function resetInferredFallbackState() {
  inferredFallbackState = createInferredFallbackState();
  rejectedAuthoritativePlans.clear();
  committedRewriteStreams.clear();
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

function resolveCompatibleTarget(url, selectedRepresentation, representations) {
  if (!selectedRepresentation) return null;
  const allVariants = getAllRepresentationVariants(representations);
  const selectedVariants = getRepresentationVariants(selectedRepresentation);
  const source = allVariants.find(rep => representationMatchesRequest(url, rep));

  if (source?.compatibilityKey) {
    return selectedVariants.find(rep => rep.compatibilityKey === source.compatibilityKey) || null;
  }

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
