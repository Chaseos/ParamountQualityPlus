import { getParamountPackaging, isProgramManifest } from './stream-model.js';

export const normalizeKeyId = value => String(value || '').replace(/-/g, '').toLowerCase();

// PlayReady reports key IDs as little-endian GUIDs, so the same key can appear
// with its first three groups byte-swapped relative to the manifest's KID.
export function swapGuidKeyId(value) {
  const key = normalizeKeyId(value);
  if (!/^[0-9a-f]{32}$/.test(key)) return key;
  const flip = part => part.match(/../g).reverse().join('');
  return flip(key.slice(0, 8)) + flip(key.slice(8, 12)) + flip(key.slice(12, 16)) + key.slice(16);
}

// Statuses that mean a key was delivered but cannot be used for this output,
// as PlayReady reports for an HD key whose output protection is not met.
export const UNUSABLE_KEY_STATUSES = new Set(['output-restricted', 'output-downscaled', 'internal-error']);

// The selected HD video key is unavailable: either never delivered (Widevine
// reports it missing) or delivered but unusable here (PlayReady reports it
// restricted). Restricted keys only count when the player's key statuses name
// them and another key is usable, so a wholly failed license never qualifies.
// The statuses cover every key in the license, so restricted keys are kept
// apart from the missing ones: only the manifest can say which of them belongs
// to the selected rendition.
export function missingKeyFailure(error, keyStatuses = null) {
  const cause = error?.cause, restrictions = cause?.data?.[0];
  if (String(error?.code) !== '2103' || error.fatal !== true || cause?.code !== 4012 || cause.category !== 4 ||
      restrictions?.hasAppRestrictions !== false || !Array.isArray(restrictions.missingKeys) ||
      !Array.isArray(restrictions.restrictedKeyStatuses)) return null;
  const validKey = key => /^[0-9a-f]{32}$/.test(key);
  const restrictedStatuses = [...new Set(restrictions.restrictedKeyStatuses)];
  let restrictedKeys = [];
  if (restrictedStatuses.length) {
    if (!restrictedStatuses.every(status => UNUSABLE_KEY_STATUSES.has(status)) ||
        !keyStatuses || typeof keyStatuses !== 'object') return null;
    const entries = Object.entries(keyStatuses).map(([key, status]) => [normalizeKeyId(key), status]);
    restrictedKeys = [...new Set(entries.filter(([key, status]) => UNUSABLE_KEY_STATUSES.has(status) && validKey(key))
      .map(([key]) => key))];
    if (!restrictedKeys.length || !entries.some(([, status]) => status === 'usable')) return null;
  }
  const keys = [...new Set(restrictions.missingKeys.map(normalizeKeyId))];
  if ((!keys.length && !restrictedKeys.length) || !keys.every(validKey)) return null;
  return { keys, restrictedKeys, detail: { playerCode: '2103', shakaCode: 4012, category: 'manifest',
    missingKeyCount: restrictions.missingKeys.length, hasAppRestrictions: false,
    restrictedKeyStatuses: restrictedStatuses, restrictedKeyCount: restrictedKeys.length } };
}

export function programSession(value) {
  try {
    const url = new URL(value);
    if (!isProgramManifest(url) || !url.pathname.startsWith('/ondemand/dash/') ||
        !/\.mpd$/i.test(url.pathname) || url.username || url.password || url.hash) return null;
    const match = url.pathname.match(/\/content\/(\d+)\/vid\/([^/]+)\//);
    return match ? { sourceId: match[1], videoId: decodeURIComponent(match[2]), key: url.origin + url.pathname } : null;
  } catch { return null; }
}

// Every missing key must belong to the selected rendition. A license also
// reports keys for other renditions (a restricted 2160p key beside the HD one),
// so among restricted keys one that the selection declares is enough.
export function indexedProgramEvidence(representations, height, missingKeys, restrictedKeys = []) {
  const variants = representations.flatMap(rep => rep.variants?.length ? rep.variants : [rep]);
  const selected = variants.filter(rep => rep.height === height && rep.isContent && !rep.isAd &&
    rep.addressing?.type === 'single-file-indexed' && getParamountPackaging(rep.addressing.mediaUrl) === 'single-file');
  const paths = selected.map(rep => rep.addressing.mediaUrl);
  const keys = selected.flatMap(rep => {
    const declaration = rep.addressing.protection?.filter(item =>
      item.schemeIdUri === 'urn:mpeg:dash:mp4protection:2011' && item.defaultKID).at(-1);
    return (declaration?.defaultKID || '').trim().split(/\s+/).map(normalizeKeyId);
  });
  const declared = key => keys.includes(key) || keys.includes(swapGuidKeyId(key));
  return { matched: missingKeys.every(declared) && (missingKeys.length > 0 || restrictedKeys.some(declared)), paths };
}

const CATALOG_HOSTS = ['vod.pplus.paramount.tech', 'vod-gcs-cedexis.cbsaavideo.com'];

// A page-declared catalog manifest on one of Paramount's VOD hosts.
export function catalogManifest(value) {
  try {
    const catalog = new URL(value);
    if (catalog.protocol !== 'https:' || catalog.username || catalog.password || catalog.hash ||
        !CATALOG_HOSTS.includes(catalog.hostname) ||
        !/\/[^/]+_cenc_(?:precon_)?dash\/stream\.mpd$/i.test(catalog.pathname)) return null;
    return catalog;
  } catch { return null; }
}

// An explicit HD choice (Force Max, or a manual pick of at least 720p). Auto
// and SD picks leave Paramount's own playback untouched.
export function explicitHdSelection(config) {
  if (!config) return false;
  return config.forceMax === true || Number.parseInt(config.forcedHeight, 10) >= 720;
}

// Before the first load, play an explicit HD choice through the page-declared
// source when Paramount assigned a different one. Some assigned sources keep
// 720p and 1080p under a key desktop Widevine never receives, which otherwise
// shows an error and needs a second load to recover.
export function chooseStartupSource({ config, daiCmsId, declaredSourceId, isLive = false, skipped = false } = {}) {
  if (skipped) return { reason: 'previous-attempt-failed' };
  if (isLive) return { reason: 'live' };
  if (!explicitHdSelection(config)) return { reason: 'no-hd-selection' };
  const assigned = String(daiCmsId ?? ''), declared = String(declaredSourceId ?? '');
  if (!/^\d+$/.test(assigned)) return { reason: 'no-assigned-source' };
  if (!/^\d+$/.test(declared)) return { reason: 'no-declared-source' };
  if (assigned === declared) return { reason: 'already-declared' };
  return { sourceId: declared, assignedSourceId: assigned };
}

const VIDEO_CODEC_EXCLUSION = /^codec:(?:hvc1|hev1|dvh|dvhe)/i;

// Paramount asks its servers to drop HEVC, HDR10 and Dolby Vision renditions
// for every browser. Lift only those video exclusions, and only when this
// browser's DRM reports it can decode HEVC 2160p and the viewer chose more
// than Paramount's default. Audio and language exclusions stay as sent.
export function chooseCodecUnlock({ config, hevcSupported, daiExcl, streamingUrl, isLive = false, skipped = false } = {}) {
  if (skipped) return { reason: 'previous-attempt-failed' };
  if (isLive) return { reason: 'live' };
  if (!config?.forceMax && !(Number.parseInt(config?.forcedHeight, 10) > 1080)) return { reason: 'no-uhd-selection' };
  if (hevcSupported !== true) return { reason: 'hevc-unsupported' };
  const exclusions = String(daiExcl || '').split(',').map(item => item.trim()).filter(Boolean);
  const kept = exclusions.filter(item => !VIDEO_CODEC_EXCLUSION.test(item));
  const url = typeof streamingUrl === 'string'
    ? streamingUrl.replace(/\/v\((?:[a-z0-9.,-]*)\)(?=\/)/i, '') : streamingUrl;
  if (kept.length === exclusions.length && url === streamingUrl) return { reason: 'nothing-excluded' };
  return { daiExcl: kept.join(','), streamingUrl: url, removed: exclusions.filter(item => VIDEO_CODEC_EXCLUSION.test(item)) };
}

export function chooseRecoverySource(context) {
  const { session, selection, failure, sourceId, videoId, declaredSourceId, catalogUrl, evidence } = context;
  if (!session || session.sourceId !== String(sourceId) || session.videoId !== videoId ||
      !(selection?.height >= 720) || !failure || !evidence?.matched || !evidence.paths.length) return null;
  const startup = context.hasProgramPlayback === false && Number.isFinite(context.contentTime) &&
    context.contentTime >= 0 && context.contentTime <= 0.25;
  if (context.isAd !== false && !startup) return null;
  const alternative = String(declaredSourceId || '');
  if (!/^\d+$/.test(alternative) || alternative === String(sourceId)) return null;
  try {
    const catalog = catalogManifest(catalogUrl);
    if (!catalog) return null;
    const asset = path => path.split('/').slice(0, -2).join('/');
    if (evidence.paths.some(path => asset(new URL(path).pathname) !== asset(catalog.pathname))) return null;
    return { sourceId: alternative, catalogUrl: catalog.href, targetHeight: selection.height, startup };
  } catch { return null; }
}

// Smart Tag answers these DAI stream failures with its own failover loads,
// so they do not mean the alternative source failed.
const DAI_FAILOVER_CODES = new Set(['4200', '4201', '4202']);
export const isDaiFailoverError = error => DAI_FAILOVER_CODES.has(String(error?.code));

const samePath = (value, other) => {
  try {
    const url = new URL(value), expected = new URL(other);
    return url.origin === expected.origin && url.pathname === expected.pathname;
  } catch { return false; }
};

// The retried stream is either the alternative DAI source or Smart Tag's DAI
// failover, which plays the declared catalog manifest with no SSAI at all.
export function replacementSource(resource, candidate, videoId, catalogVideoId) {
  const ssai = resource?.ad?.ssai;
  if (ssai) return String(ssai.contentSourceId) === candidate.sourceId && ssai.videoId === videoId ? 'alternative' : null;
  if (catalogVideoId && catalogVideoId !== videoId) return null;
  return samePath(resource?.location?.mediaUrl, candidate.catalogUrl) ? 'catalog' : null;
}

export function canRestoreProgramPause(sample, candidate) {
  return sample.isAd === false && sample.adBreakInProgress !== true && sample.breakPending !== true &&
    sample.readyState === 4 && String(sample.sourceId || '') === candidate.sourceId &&
    Number.isFinite(sample.height) && Math.abs(sample.height - candidate.targetHeight) <= 16;
}

export function createSourceRecoveryClock(startAt) {
  let previousAt = startAt, previousWasAd = false, programMs = 0, adMs = 0;
  return (at, isAd) => {
    const now = Math.max(previousAt, at), delta = now - previousAt;
    if (previousWasAd) adMs += delta;
    else programMs += delta;
    previousAt = now; previousWasAd = isAd === true;
    const elapsedMs = now - startAt;
    return { elapsedMs, programMs, adMs, expired: programMs >= 40000 || elapsedMs >= 300000 };
  };
}
