import { createQualityMonitor } from './quality-monitor.js';
import { classifyMediaRequest, getParamountPackaging, selectRepresentation } from './stream-model.js';
import { extractResolutionFromPath } from './url-utils.js';
import { getPackageManifestCandidate } from './package-manifest.js';

const clean = value => { try { const u = new URL(value, window.location.href); return u.origin + u.pathname; } catch { return null; } };
const mappingPath = value => clean(value)?.replace(/\/seg_\d+\.m4s$/, '/seg_$Number$.m4s');

export function resolveRetrievedQuality(value, representations, range = null) {
  const request = classifyMediaRequest(value);
  if (!request.url || request.excluded || request.isLive || request.isInitialization || request.kind !== 'segment' ||
      !getParamountPackaging(request.url) || (request.cmcd.ot && request.cmcd.ot !== 'v')) return null;
  const variants = representations.flatMap(rep => rep.variants?.length ? rep.variants : [rep]);
  const url = request.url;
  const matches = variants.filter(rep => {
    if (rep.addressing?.mediaUrl) return clean(rep.addressing.mediaUrl) === clean(value);
    const pathId = rep.request?.pathId || rep.pathId;
    return pathId && url.pathname.split('/').at(-2) === pathId;
  });
  if (getParamountPackaging(url) === 'single-file') {
    // A successful init/index range is not evidence of retrieved video media.
    const start = Number(String(range || '').match(/^bytes=(\d+)-\d*$/i)?.[1]);
    if (!matches.length || !Number.isFinite(start) || matches.some(rep => !rep.addressing ||
        start <= Math.max(Number(rep.addressing.indexRange.split('-')[1]), Number(rep.addressing.initializationRange.split('-')[1])))) return null;
  } else if (range) return null;
  const heights = new Set(matches.map(rep => rep.height));
  if (heights.size > 1) return null;
  const height = heights.size === 1 ? [...heights][0] : Number.parseInt(extractResolutionFromPath(url.pathname), 10);
  return Number.isFinite(height) && height > 0 ? { height, url: clean(value), provenance: matches.length ? 'manifest-url' : 'explicit-path' } : null;
}

export function sampleProgramVideo(doc = document) {
  const candidates = Array.from(doc.querySelectorAll('video')).filter(video => {
    const rect = video.getBoundingClientRect();
    const style = window.getComputedStyle(video);
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
      rect.top < window.innerHeight && rect.left < window.innerWidth && style.opacity !== '0' && style.visibility !== 'hidden' && style.display !== 'none' &&
      Number(video.videoHeight) > 0;
  });
  const video = candidates.length === 1 ? candidates[0] : null;
  const eligible = Boolean(video && doc.visibilityState === 'visible' && video.player?.isAd === false &&
    !video.paused && !video.ended && !video.seeking && video.readyState >= 3 && Number.isFinite(video.duration));
  let bufferedEnd = null;
  if (eligible) for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) >= video.currentTime) {
      bufferedEnd = video.buffered.end(i); break;
    }
  }
  return { video, eligible, bufferedEnd, currentTime: video?.currentTime,
    decodedHeight: video?.videoHeight, playbackRate: video?.playbackRate };
}

export function createQualityWatch({ discovery, getConfig, getRepresentations, record,
  now = () => performance.now(), samplePlayback = sampleProgramVideo }) {
  const monitor = createQualityMonitor();
  let session = 0;
  let manifestRevision = 0;
  let page = window.location.pathname;
  let packageUrl = null;
  let selection = null;
  let timer = null;
  let opportunity = null;
  let used = false;
  let active = false;
  const selectedHeight = () => {
    const config = getConfig();
    if (!config.forceMax && !config.forcedId && !config.forcedHeight) return null;
    const height = Number(config.forcedHeight) || selectRepresentation(getRepresentations(), config)?.height;
    return Number.isFinite(height) && height > 0 ? height : null;
  };
  const report = (outcome, state = monitor.snapshot(), detail = {}) => record('quality_monitor', {
    outcome, selectedHeight: state.targetHeight, retrievedHeights: state.observations.map(item => item.height),
    decodedHeight: state.decodedHeight, evidenceCount: state.observations.length,
    eligibleSeconds: state.eligibleSeconds, bufferBoundary: state.bufferBoundary,
    strategy: state.observations.at(-1)?.strategy || null,
    retrievalSources: state.observations.map(item => item.provenance),
    retrievedPath: state.observations.at(-1)?.url || null, packageUrl, ...detail
  });
  const sync = () => {
    if (window.location.pathname !== page) { page = window.location.pathname; session++; packageUrl = null; selection = null; }
    const height = selectedHeight();
    const key = `${session}|${packageUrl || ''}|${height || 'auto'}`;
    if (key !== selection) {
      selection = key; used = false; active = false; opportunity = null;
      monitor.configure(key, height);
    }
    if (height && packageUrl && !timer) timer = window.setInterval(tick, 2000);
    if ((!height || !packageUrl) && timer) { window.clearInterval(timer); timer = null; }
    return height;
  };
  function tick() {
    sync();
    const result = monitor.sample({ ...samplePlayback(), now: now() });
    if (!result.changed) return;
    report(result.status, result);
    if (!['retrieval-mismatch', 'decode-mismatch'].includes(result.status)) return;
    if (used || result.status === 'decode-mismatch') { report('unresolved', result, { reason: used ? 'correction-already-attempted' : 'target-retrieved' }); return; }
    used = true;
    const observation = result.observations.at(-1);
    const candidate = getPackageManifestCandidate(observation.url);
    if (candidate?.packaging !== 'segmented') { report('unresolved', result, { reason: 'indexed-or-unsupported' }); return; }
    opportunity = { observations: result.observations, packageUrl: candidate.packageUrl };
    discovery.observe(observation.url, discovery.capture());
    report('fallback-requested', result);
  }
  const capture = (url, sequence) => {
    sync();
    const candidate = getPackageManifestCandidate(url);
    if (candidate && candidate.packageUrl !== packageUrl) {
      packageUrl = candidate.packageUrl; sync();
    }
    return { epoch: monitor.capture(), startedAt: now(), sequence, originalUrl: url, selection };
  };
  const success = (token, finalUrl, { range = null, plannedUrl = token?.originalUrl, strategy = 'original' } = {}) => {
    sync();
    if (!token || token.selection !== selection || token.epoch !== monitor.capture()) return;
    const observation = resolveRetrievedQuality(finalUrl, getRepresentations(), range);
    if (!observation || !observation.url.startsWith(packageUrl || '\0')) return;
    monitor.observe({ ...token, ...observation, completedAt: now(), plannedUrl: clean(plannedUrl),
      originalUrl: clean(token.originalUrl), strategy, requestKey: `${observation.url}|${range || ''}` });
  };
  const override = (url, normal, allowed) => {
    sync();
    if (!allowed || !opportunity || getPackageManifestCandidate(url)?.packageUrl !== opportunity.packageUrl) return null;
    const candidate = discovery.plan(url, getConfig(), getRepresentations());
    if (!candidate) {
      const status = discovery.status(url);
      if (!active && ['rejected', 'validated'].includes(status)) {
        opportunity = null; report('unresolved', undefined, { reason: 'no-compatible-correction' });
      }
      return null;
    }
    if (!active && opportunity.observations.some(item => mappingPath(item.originalUrl) === mappingPath(url) &&
        mappingPath(item.plannedUrl) === mappingPath(candidate.url))) {
      opportunity = null; report('unresolved', undefined, { reason: 'identical-ineffective-mapping' }); return null;
    }
    if (!active) {
      active = true; report('fallback-activated', undefined, { strategy: candidate.strategy, targetPath: clean(candidate.url) });
      monitor.interrupt();
    }
    return candidate;
  };
  const failure = (token, detail) => {
    sync();
    if (!active || token?.selection !== selection || !opportunity || opportunity.failureReported) return;
    opportunity.failureReported = true;
    report('unresolved', undefined, { reason: 'corrective-request-failed', detail });
  };
  const authoritativeReceived = () => {
    active = false; opportunity = null;
    // Preserve the activation budget for this effective selection.
    const height = sync();
    monitor.configure(`${selection}|manifest:${++manifestRevision}`, height);
  };
  const reset = () => {
    session++; packageUrl = null; selection = null; sync(); monitor.interrupt();
  };
  const interrupt = () => {
    const result = monitor.interrupt();
    if (result.changed) report(result.status, result);
  };
  for (const event of ['seeking', 'pause', 'waiting', 'stalled', 'emptied']) {
    document.addEventListener(event, event => { if (event.target?.tagName === 'VIDEO') interrupt(); }, true);
  }
  document.addEventListener('visibilitychange', interrupt);
  window.addEventListener('message', event => { if (event.source === window && event.data?.type === 'PQI_CONFIG') sync(); });
  window.addEventListener('pagehide', reset);
  return { capture, success, failure, override, authoritativeReceived, reset };
}
