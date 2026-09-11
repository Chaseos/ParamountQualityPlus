import { getConfig, getRepresentations } from './state.js';
import { selectRepresentation } from './stream-model.js';

const STORAGE_KEY = 'pqiFailureReport';
const MAX_BYTES = 128 * 1024;
let extensionVersion = 'unknown';
let manifest = null;
let requests = [];
const safely = fn => { try { return fn(); } catch { return null; } };
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const label = value => typeof value === 'string' && /^[\w .:+-]{1,100}$/.test(value) ? value : null;
const range = value => typeof value === 'string' && /^(?:bytes[= ])?\d+-\d*(?:\/\d+)?$/.test(value) ? value : null;
export const reportPath = value => safely(() => {
  if (typeof value !== 'string' || !value) return null;
  const url = new URL(value, window.location.href);
  return /^https?:$/.test(url.protocol) ? `${url.origin}${url.pathname}`.slice(0,1024) : null;
});
const numericFields = (object, fields) => Object.fromEntries(fields.map(key => [key, number(object?.[key])]));
const dimensions = object => ({ ...numericFields(object, ['width', 'height', 'bandwidth']),
  codecs: label(object?.codecs || object?.videoCodec) });

export function initReportMetadata() {
  extensionVersion = label(document.querySelector('script[data-pqi-version]')?.dataset.pqiVersion) || 'unknown';
}
export function resetReportContext() { manifest = null; requests = []; }
export function recordManifestReport(result) {
  safely(() => {
    const variants = result.representations.flatMap(rep => rep.variants?.length ? rep.variants : [rep]);
    manifest = {
      url: reportPath(result.url), strategy: 'indexed-manifest', reason: label(result.reason),
      selectedHeight: number(result.selectedHeight), representationCount: variants.length,
      truncated: variants.length > 80,
      representations: variants.slice(0,80).map(rep => ({
        ...dimensions(rep), nodeIndex: number(rep.manifestNodeIndex), period: label(rep.periodKey),
        addressing: label(rep.addressing?.type),
        path: reportPath(rep.addressing?.mediaUrl),
        initializationRange: range(rep.addressing?.initializationRange), indexRange: range(rep.addressing?.indexRange),
        protected: Boolean(rep.addressing?.protection?.length),
        retained: !result.selectedHeight || rep.height === result.selectedHeight
      }))
    };
  });
}
export function recordMediaReport(url, status, info = {}) {
  safely(() => {
    requests.push({ at: Date.now(), path: reportPath(url), finalPath: reportPath(info.finalUrl),
      status: number(status), outcome: label(info.outcome), transport: label(info.transport), range: range(info.range),
      contentRange: range(info.contentRange), cancelled: Boolean(info.cancelled) });
    if (requests.length > 40) requests.shift();
  });
}
function playerReport() {
  return Array.from(document.querySelectorAll('video')).slice(0,4).map(video => {
    const player = video.player;
    const shaka = safely(() => player.getAdapter('playback').player);
    const config = safely(() => shaka.getConfiguration());
    const keys = safely(() => shaka.getKeyStatuses());
    const keyStatuses = {};
    for (const value of Object.values(keys || {}).slice(0,100)) {
      const status = ['usable', 'expired', 'released', 'output-restricted', 'output-downscaled', 'status-pending', 'internal-error'].includes(value) ? value : 'unknown';
      keyStatuses[status] = (keyStatuses[status] || 0) + 1;
    }
    const tracks = safely(() => shaka.getVariantTracks());
    const parsed = safely(() => shaka.getManifest());
    const restrictionFields = ['minWidth','maxWidth','minHeight','maxHeight','minPixels','maxPixels','minBandwidth','maxBandwidth','maxChannelsCount'];
    return {
      decodedWidth: number(video.videoWidth), decodedHeight: number(video.videoHeight),
      currentTime: number(video.currentTime), paused: Boolean(video.paused), seeking: Boolean(video.seeking),
      readyState: number(video.readyState), nativeError: number(video.error?.code),
      isAd: typeof player?.isAd === 'boolean' ? player.isAd : null,
      resource: reportPath(safely(() => player.resource.location.mediaUrl)),
      playerAvailable: Boolean(shaka), keyStatuses,
      resourceAbr: safely(() => ({ ...numericFields(player.resource.playback.abr, ['maxHeight','minBitrate','maxBitrate']),
        maxCategory: label(player.resource.playback.abr.maxCategory) })),
      restrictions: config ? numericFields(config.restrictions, restrictionFields) : null,
      abrRestrictions: config ? numericFields(config.abr?.restrictions, restrictionFields) : null,
      tracks: Array.isArray(tracks) ? tracks.slice(0,40).map(track => ({ ...dimensions(track), active: Boolean(track.active) })) : null,
      variants: Array.isArray(parsed?.variants) ? parsed.variants.slice(0,40).map(variant => ({
        ...dimensions(variant.video), allowedByApplication: variant.allowedByApplication === true,
        allowedByKeySystem: variant.allowedByKeySystem === true
      })) : null
    };
  });
}
// Deliberately do not serialize arbitrary event payloads, player configuration,
// DRM objects, or headers. Those can contain credentials or license material.
function eventReport(event) {
  const detail = event.detail || {};
  const result = {};
  for (const key of ['checkpoint','reason','strategy','outcome','transport','category']) result[key] = label(detail[key]);
  for (const key of ['status','selectedHeight','targetHeight','retrievedHeight','decodedHeight','failureCount','shakaCode']) result[key] = number(detail[key]);
  if (detail.url) result.path = reportPath(detail.url);
  return { at: number(event.timestamp), type: label(event.type), detail: result };
}
export function createDiagnosticReport(snapshot = {}) {
  return safely(() => {
    const config = getConfig();
    const target = selectRepresentation(getRepresentations(), config);
    return {
      schemaVersion: 1, extensionVersion, capturedAt: Date.now(), page: reportPath(window.location.href),
      browser: navigator.userAgent.slice(0,300),
      selection: { mode: config.forceMax ? 'highest' : config.forcedHeight || config.forcedId ? 'manual' : 'auto',
        requestedHeight: number(config.forcedHeight), effectiveHeight: number(target?.height) },
      manifest, mediaRequests: requests.slice(), players: playerReport(),
      events: (snapshot.recentEvents || []).slice(-60).map(eventReport)
    };
  });
}
export function persistDiagnosticReport(snapshot, failure = {}) {
  return safely(() => {
    const report = createDiagnosticReport(snapshot);
    if (!report) return false;
    report.failure = {
      playerCode: label(failure.playerCode), shakaCode: number(failure.shakaCode), category: label(failure.category),
      selectedHeight: number(failure.selectedHeight), hasAppRestrictions: failure.hasAppRestrictions === true,
      missingKeyCount: number(failure.missingKeyCount),
      restrictedKeyStatuses: (Array.isArray(failure.restrictedKeyStatuses) ? failure.restrictedKeyStatuses : [])
        .filter(value => ['output-restricted','internal-error'].includes(value)).slice(0,10)
    };
    let text = JSON.stringify(report);
    if (new Blob([text]).size > MAX_BYTES) {
      report.events = []; report.mediaRequests = []; report.truncated = true;
      text = JSON.stringify(report);
    }
    if (new Blob([text]).size > MAX_BYTES) return false;
    window.sessionStorage.setItem(STORAGE_KEY, text);
    return true;
  });
}
export function exportDiagnosticReport(snapshot) {
  const previousFailure = safely(() => {
    const text = window.sessionStorage.getItem(STORAGE_KEY);
    return text && text.length <= MAX_BYTES && JSON.parse(text).schemaVersion === 1 ? JSON.parse(text) : null;
  });
  return { current: createDiagnosticReport(snapshot), previousFailure,
    previousFailureMatchesPage: Boolean(previousFailure && previousFailure.page === reportPath(window.location.href)) };
}
