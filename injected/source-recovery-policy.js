import { getParamountPackaging, isProgramManifest } from './stream-model.js';

export const normalizeKeyId = value => String(value || '').replace(/-/g, '').toLowerCase();

export function missingKeyFailure(error) {
  const cause = error?.cause, restrictions = cause?.data?.[0];
  if (String(error?.code) !== '2103' || error.fatal !== true || cause?.code !== 4012 || cause.category !== 4 ||
      restrictions?.hasAppRestrictions !== false || !Array.isArray(restrictions.missingKeys) ||
      !restrictions.missingKeys.length || !Array.isArray(restrictions.restrictedKeyStatuses) ||
      restrictions.restrictedKeyStatuses.length) return null;
  const keys = [...new Set(restrictions.missingKeys.map(normalizeKeyId))];
  if (keys.some(key => !/^[0-9a-f]{32}$/.test(key))) return null;
  return { keys, detail: { playerCode: '2103', shakaCode: 4012, category: 'manifest',
    missingKeyCount: keys.length, hasAppRestrictions: false, restrictedKeyStatuses: [] } };
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

export function indexedProgramEvidence(representations, height, missingKeys) {
  const variants = representations.flatMap(rep => rep.variants?.length ? rep.variants : [rep]);
  const selected = variants.filter(rep => rep.height === height && rep.isContent && !rep.isAd &&
    rep.addressing?.type === 'single-file-indexed' && getParamountPackaging(rep.addressing.mediaUrl) === 'single-file');
  const paths = selected.map(rep => rep.addressing.mediaUrl);
  const keys = selected.flatMap(rep => {
    const declaration = rep.addressing.protection?.filter(item =>
      item.schemeIdUri === 'urn:mpeg:dash:mp4protection:2011' && item.defaultKID).at(-1);
    return (declaration?.defaultKID || '').trim().split(/\s+/).map(normalizeKeyId);
  });
  return { matched: Boolean(missingKeys.length && missingKeys.every(key => keys.includes(key))), paths };
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
    const catalog = new URL(catalogUrl);
    if (catalog.protocol !== 'https:' || catalog.username || catalog.password || catalog.hash ||
        !['vod.pplus.paramount.tech', 'vod-gcs-cedexis.cbsaavideo.com'].includes(catalog.hostname) ||
        !/\/[^/]+_cenc_(?:precon_)?dash\/stream\.mpd$/i.test(catalog.pathname)) return null;
    const asset = path => path.split('/').slice(0, -2).join('/');
    if (evidence.paths.some(path => asset(new URL(path).pathname) !== asset(catalog.pathname))) return null;
    return { sourceId: alternative, catalogUrl: catalog.href, targetHeight: selection.height, startup };
  } catch { return null; }
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
