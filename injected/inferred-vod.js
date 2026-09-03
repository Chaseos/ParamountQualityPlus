import { estimateResolutionFromBitrate } from './constants.js';
import { getConfig, getRepresentations } from './state.js';
import { classifyMediaRequest, deriveStreamKey } from './stream-model.js';

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
      const year = Number.parseInt(url.pathname.match(/\/intl_vms\/(\d{4})\//i)?.[1], 10);
      return Number.isFinite(year) && year <= 2021;
    },
    codecTier: '23', urlTier: '5400'
  },
  {
    id: 'legacy-mastered-c23',
    matches: ({ url, contentPrefix }) => url.hostname === LEGACY_CBS_VOD_HOST &&
      /(?:^|_)(?:FTR|VMASTER|PRORES)(?:_|$)|WOLF_OF_WALL_STREET/i.test(contentPrefix),
    codecTier: '23', urlTier: '5400'
  },
  { id: 'hd-c23', matches: ({ contentPrefix }) => /(?:^|_)HD(?:_|$)/i.test(contentPrefix), codecTier: '23', urlTier: '5400' },
  { id: 'survivor-c23', matches: ({ contentPrefix }) => /(?:^|_)SURVIVOR(?:_|$)/i.test(contentPrefix), codecTier: '23', urlTier: '5400' },
  { id: 'modern-c20', matches: () => true, codecTier: '20', urlTier: '5400' }
];

function createInferredFallbackState(streamKey = null) {
  return { streamKey, status: 'untested', targetDirectory: null };
}

let inferredFallbackState = createInferredFallbackState();
const rejectedAuthoritativePlans = new Set();
const committedRewriteStreams = new Set();

function getInferredRepresentationPlan(urlObj) {
  if (!PARAMOUNT_VOD_HOSTS.has(urlObj.hostname.toLowerCase()) ||
      !urlObj.pathname.toLowerCase().includes('_cenc_precon_dash/')) return null;

  const paramountMatch = urlObj.pathname.match(PARAMOUNT_VOD_REP_PATTERN);
  if (paramountMatch) {
    const [, contentPrefix, , currentHeightRaw, assetId, , segmentName] = paramountMatch;
    const profile = INFERENCE_PROFILES.find(item => item.matches({ url: urlObj, contentPrefix }));
    return {
      match: paramountMatch, profileId: profile.id, contentPrefix, assetId, segmentName,
      alreadyMax: Number.parseInt(currentHeightRaw, 10) >= INFERRED_MAX_HEIGHT,
      targetDirectory: `${contentPrefix}_c${profile.codecTier}_${INFERRED_MAX_HEIGHT}p_${assetId}_${profile.urlTier}`,
      alternateTargets: ['20', '23'].filter(codecTier => codecTier !== profile.codecTier).map(codecTier => ({
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
    match: legacyMatch, profileId: 'plain-4500', contentPrefix, assetId, segmentName,
    alreadyMax: false, targetDirectory: `${contentPrefix}_${assetId}_4500`
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
  if (!isInitialization && !request.cmcd.ot && !PARAMOUNT_VOD_REP_PATTERN.test(request.url.pathname)) return null;

  const representationPlan = getInferredRepresentationPlan(request.url);
  if (!representationPlan) return null;
  const { match, contentPrefix, assetId, segmentName, targetDirectory, profileId } = representationPlan;
  const representationDirectory = match[0].slice(1, match[0].lastIndexOf(`/${segmentName}`));
  const streamPrefix = request.url.pathname.slice(0, match.index);
  const streamKey = `${request.url.origin}${streamPrefix}/${contentPrefix}_${assetId}`;

  if (inferredFallbackState.streamKey !== streamKey) inferredFallbackState = createInferredFallbackState(streamKey);
  if (inferredFallbackState.status === 'rejected') return null;
  const topBitrate = Number.parseInt(request.cmcd.tb, 10);
  if (representationPlan.alreadyMax ||
      (inferredFallbackState.status !== 'validated' && !isInitialization &&
        topBitrate && Number.parseInt(estimateResolutionFromBitrate(topBitrate), 10) < INFERRED_MAX_HEIGHT)) return null;

  const targets = [{ targetDirectory, profileId }, ...(representationPlan.alternateTargets || [])];
  if (inferredFallbackState.status === 'validated' && inferredFallbackState.targetDirectory) {
    targets.sort((left, right) => Number(right.targetDirectory === inferredFallbackState.targetDirectory) -
      Number(left.targetDirectory === inferredFallbackState.targetDirectory));
  }
  const candidates = targets
    .filter((candidate, index, items) => items.findIndex(item => item.targetDirectory === candidate.targetDirectory) === index)
    .map(candidate => {
      const target = new URL(request.url);
      target.pathname = target.pathname.replace(`/${representationDirectory}/`, `/${candidate.targetDirectory}/`);
      let validationUrl = null;
      if (isInitialization) {
        const validation = new URL(target);
        validation.pathname = validation.pathname.replace(/\/init\.(?:m4s|m4v|mp4)$/i, '/seg_1.m4s');
        validationUrl = validation.toString();
      }
      return { ...candidate, url: target.toString(), validationUrl, strategy: `paramount-vod:${candidate.profileId}` };
    });
  const selectedCandidate = candidates[0];
  return {
    action: 'inferred-probe', url: selectedCandidate.url, validationUrl: selectedCandidate.validationUrl,
    candidates, originalUrl: url, streamKey, strategy: selectedCandidate.strategy,
    mediaRole: isInitialization ? 'initialization' : 'segment', targetHeight: INFERRED_MAX_HEIGHT,
    targetBitrateKbps: Number.isFinite(topBitrate) ? topBitrate : null, targetSource: 'inferred',
    needsValidation: inferredFallbackState.status !== 'validated', source: 'inferred'
  };
}

export function recordInferredFallbackResult(streamKey, succeeded, mediaRole = null, candidate = null) {
  if (inferredFallbackState.streamKey !== streamKey) return;
  if (!succeeded && committedRewriteStreams.has(streamKey)) return;
  inferredFallbackState.status = succeeded ? 'validated' : 'rejected';
  inferredFallbackState.targetDirectory = succeeded ? (candidate?.targetDirectory || null) : null;
  if (succeeded && mediaRole) committedRewriteStreams.add(streamKey);
}

export function recordAuthoritativeRewriteResult(plan, succeeded) {
  if (!plan?.rejectionKey) return;
  if (succeeded) {
    rejectedAuthoritativePlans.delete(plan.rejectionKey);
    if (plan.streamKey) committedRewriteStreams.add(plan.streamKey);
  } else if (!committedRewriteStreams.has(plan.streamKey)) {
    rejectedAuthoritativePlans.add(plan.rejectionKey);
  }
}

export function isAuthoritativePlanRejected(rejectionKey) {
  return rejectedAuthoritativePlans.has(rejectionKey);
}

export function canFallbackToOriginal(plan) {
  return !plan?.streamKey || !committedRewriteStreams.has(plan.streamKey);
}

export function resetInferredFallbackState() {
  inferredFallbackState = createInferredFallbackState();
  rejectedAuthoritativePlans.clear();
  committedRewriteStreams.clear();
}
