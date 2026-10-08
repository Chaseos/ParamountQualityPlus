import { readDashRepresentations } from './manifest-parser.js';
import { readBoundedManifest } from './manifest-body.js';
import { getConfig, getRepresentations } from './state.js';
import { selectRepresentation } from './stream-model.js';
import { recordPlaybackCheckpoint } from './diagnostics.js';
import { recordSourceRecoveryReport, reportPath } from './diagnostic-report.js';
import { canRestoreProgramPause, chooseRecoverySource, createSourceRecoveryClock,
  indexedProgramEvidence, missingKeyFailure, programSession } from './source-recovery-policy.js';

const sdkEvents = ['ON_CREATE_PLAYER_SUCCESS', 'ON_RESOURCE_LOAD_STARTED', 'ON_RESOURCE_LOAD_COMPLETED',
  'ON_PLAYER_EVENT', 'ON_FATAL_ERROR', 'ON_DESTROY_PLAYER_SUCCESS'].map(type => `TagEvent.${type}`);
const safely = fn => { try { return fn(); } catch { return null; } };
const qualityKey = config => JSON.stringify([Boolean(config.forceMax), config.forcedHeight || null, config.forcedId || null]);
const SOURCE_RESUME_KEY = 'pqiSourceResume';

function consumeSourcePosition() {
  return safely(() => {
    const raw = window.sessionStorage.getItem(SOURCE_RESUME_KEY);
    window.sessionStorage.removeItem(SOURCE_RESUME_KEY);
    const saved = raw && JSON.parse(raw);
    return saved?.path === window.location.pathname && Number.isFinite(saved.time) && saved.time >= 0 &&
      typeof saved.paused === 'boolean' && Number.isFinite(saved.savedAt) &&
      Date.now() - saved.savedAt >= 0 && Date.now() - saved.savedAt < 120000 ? saved : null;
  });
}

function findPlayerError(value, seen = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return null;
  seen.add(value);
  if (value.fatal === true && typeof value.code !== 'undefined') return value;
  for (const name of ['error', 'detail', 'cause', 'data', 'playerEvent', 'originalError', 'original']) {
    for (const child of Array.isArray(value[name]) ? value[name] : [value[name]]) {
      const found = findPlayerError(child, seen, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function sourceRecoverySupported(userAgent = navigator.userAgent) {
  return /(?:Chrome|Chromium|Edg|Firefox|OPR)\//.test(userAgent) && !/Android|iPhone|iPad|iPod/.test(userAgent);
}

// SDK integration stays here; transport hooks supply the original manifest and
// fetch function. No license, media-range, or global message interception.
export function createSourceRecovery({ fetch, onAttempt, onFailure, recoverOriginal,
  enabled = sourceRecoverySupported(), now = () => performance.now() }) {
  const manifests = new Map(), probes = new Map(), attempts = new Set(), played = new WeakMap();
  let page = window.location.pathname, videoId = null, generation = 0, disposed = false;
  let tag = null, lastPlayer = null, lastSnapshot = null, timer = null, pending = null;
  let indexedContext = false;
  let staged = enabled ? consumeSourcePosition() : null;
  const restoreClock = staged ? createSourceRecoveryClock(now()) : null;
  let resume = staged ? { time: staged.time, paused: staged.paused } : null;
  const activeVideo = () => {
    const videos = Array.from(document.querySelectorAll('video')).filter(video =>
      video.player && video.getBoundingClientRect().width > 0);
    return videos.length === 1 ? videos[0] : null;
  };
  const selection = job => {
    const config = getConfig();
    if (!config.forceMax && !config.forcedHeight && !config.forcedId) return null;
    const representations = getRepresentations();
    const height = selectRepresentation(representations, config)?.height;
    // The network reset briefly clears the ladder while the replacement loads.
    const effective = height || (job && !representations.length
      ? Number(config.forcedHeight) || (qualityKey(config) === job.configKey ? job.targetHeight : null) : null);
    return effective ? { height: effective } : null;
  };
  const log = (outcome, detail = {}) => {
    recordSourceRecoveryReport(outcome, detail);
    recordPlaybackCheckpoint('source_recovery', { outcome, ...detail });
  };
  const snapshot = player => {
    const video = Array.from(document.querySelectorAll('video')).find(v => v.player === player);
    const contentTime = safely(() => tag.API.PLAYER.contentTime);
    const id = player?.resource?.ad?.ssai?.videoId, url = player?.resource?.location?.mediaUrl;
    const identity = `${id}|${programSession(url)?.key || ''}`;
    let history = player ? played.get(player) : null;
    if (player && history?.identity !== identity) { history = { identity, advanced: false }; played.set(player, history); }
    if (id === videoId && player?.isAd === false && video?.readyState >= 3 && contentTime > 0.25) history.advanced = true;
    return { player, isAd: typeof player?.isAd === 'boolean' ? player.isAd : null,
      sourceId: player?.resource?.ad?.ssai?.contentSourceId,
      videoId: id, url, contentTime, paused: video?.paused, hasProgramPlayback: history?.advanced ?? null };
  };
  const detachTag = () => {
    if (tag) sdkEvents.forEach(type => safely(() => tag.eventDispatcher.removeEventListener(type, onTag)));
    tag = null; lastPlayer = null; lastSnapshot = null;
  };
  const stopMonitoring = () => { clearInterval(timer); timer = null; detachTag(); };
  const cancel = () => {
    if (!pending) return;
    pending.cancelled = true; pending.controller.abort(); pending.clearPause?.(); pending = null;
  };
  const reset = () => {
    cancel(); generation++; manifests.clear(); probes.clear(); attempts.clear(); resume = null; staged = null;
    videoId = null; indexedContext = false; page = window.location.pathname;
    stopMonitoring();
  };
  const sync = () => {
    if (page !== window.location.pathname) reset();
  };
  const sample = () => {
    sync();
    if (!tag || (!staged && !selection(pending))) return;
    const player = activeVideo()?.player || safely(() => tag.controller.playerManager.playerAdapter.adaptedPlayerInstance);
    if (!player) return;
    const current = snapshot(player);
    if (current.videoId !== videoId) return;
    lastPlayer = player;
    if (current.sourceId && current.videoId) lastSnapshot = current;
    if (pending) return;
    const video = activeVideo();
    const ad = safely(() => player.getAdapter('ad'));
    const programReady = video && current.isAd === false && video.readyState >= 3 &&
      ad?.adBreakInProgress !== true && ad?.breakPending !== true;
    if (staged) {
      const saved = staged, target = selection(), config = getConfig();
      const restoreFailed = reason => {
        if (staged !== saved) return;
        staged = null; resume = null;
        recordPlaybackCheckpoint('indexed_position_restore_failed', { reason });
        if (!indexedContext && !pending) stopMonitoring();
      };
      const correctFrame = target ? Math.abs(video?.videoHeight - target.height) <= 16
        : !config.forceMax && !config.forcedHeight && !config.forcedId;
      // The stored handoff must be fresh when consumed, but its active deadline
      // excludes confirmed ads just like source recovery does.
      if (restoreClock(now(), current.isAd === true || ad?.adBreakInProgress === true).expired) {
        restoreFailed('handoff-timeout');
        if (!indexedContext) return;
      } else if (programReady && correctFrame && video.readyState === 4 && Number.isFinite(current.contentTime)) {
        // The replacement can contain a different ad schedule and duration.
        // Seek in program time through the SDK so required ads remain intact.
        if (Math.abs(current.contentTime - saved.time) > 2) {
          if (!saved.seekRequested && typeof tag.API.PLAYER.seek === 'function') {
            saved.seekRequested = true;
            try { Promise.resolve(tag.API.PLAYER.seek(saved.time)).catch(() => restoreFailed('sdk-seek-failed')); }
            catch { restoreFailed('sdk-seek-failed'); }
          }
          return;
        }
        if (saved.paused && !video.paused) { video.pause(); safely(() => tag.API.PLAYER.pause()); }
        else if (!saved.paused && video.paused && !saved.playRequested) {
          saved.playRequested = true;
          try { Promise.resolve(tag.API.PLAYER.play()).catch(() => restoreFailed('sdk-play-failed')); }
          catch { restoreFailed('sdk-play-failed'); }
        }
        if (video.paused !== saved.paused) return;
        staged = null;
        recordPlaybackCheckpoint('indexed_position_restored', { contentTime: current.contentTime, paused: saved.paused });
      } else return;
      if (!indexedContext) { resume = null; stopMonitoring(); return; }
    }
    if (!resume && current.sourceId) {
      // Loading players report time 0 and paused even when resuming autoplay.
      // Until a program frame is ready, retain the SDK's requested position and
      // play intent rather than treating that temporary state as a user pause.
      const content = safely(() => tag.params.CONTENT);
      const time = !programReady && Number.isFinite(content?.globalResumeTime)
        ? content.globalResumeTime : current.contentTime;
      const paused = !programReady && typeof content?.autoplay === 'boolean' ? !content.autoplay : current.paused === true;
      if (Number.isFinite(time)) resume = { time: Math.max(0, time), paused };
    }
    if (programReady && Number.isFinite(current.contentTime))
      resume = { time: Math.max(0, current.contentTime), paused: video.paused };
  };
  function onTag(event) {
    if (disposed) return;
    if (event.type === 'TagEvent.ON_DESTROY_PLAYER_SUCCESS' && pending?.phase === 'checking' &&
        lastPlayer === pending.context.player) pending.teardownConfirmed = true;
    const error = findPlayerError(event);
    if (error) handleError(error, activeVideo()?.player || lastPlayer);
    else sample();
  }
  const bindTag = () => {
    const tags = window.SmartTag?.list;
    if (tags?.length !== 1 || !tags[0]?.eventDispatcher || typeof tags[0].tagEventsHandler !== 'function') return;
    if (tag === tags[0]) return;
    detachTag(); tag = tags[0];
    try { tag.tagEventsHandler(onTag, sdkEvents); }
    catch { detachTag(); return; }
    sample();
    if (tag && !timer) timer = window.setInterval(sample, 500);
  };
  const observeManifest = result => {
    if (!enabled || disposed) return;
    sync();
    const session = programSession(result.url);
    if (!session) return;
    if (videoId && videoId !== session.videoId) reset();
    videoId = session.videoId;
    indexedContext = result.supported === true;
    if (result.supported) {
      manifests.set(session.key, result.representations);
      while (manifests.size > 4) manifests.delete(manifests.keys().next().value);
      bindTag();
    } else if (staged) bindTag();
    else if (!pending) stopMonitoring();
  };
  const valid = job => {
    sync();
    const currentId = activeVideo()?.player?.resource?.ad?.ssai?.videoId;
    if (currentId && currentId !== job.context.videoId) { reset(); return false; }
    if (pending === job && !job.cancelled && selection(job)?.height !== job.targetHeight) {
      log('cancelled', { reason: 'selection-changed' }); cancel(); return false;
    }
    return !disposed && !job.cancelled && job.generation === generation && pending === job &&
      window.SmartTag?.list?.length === 1 && window.SmartTag.list[0] === job.tag &&
      videoId === job.context.videoId && selection(job)?.height === job.targetHeight;
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const proof = async job => {
    const session = job.context.session;
    if (!manifests.has(session.key) && !probes.has(session.key) && typeof fetch === 'function') {
      let probeStatus = null;
      const work = (async () => {
        const response = await fetch(job.context.url, { signal: job.controller.signal, credentials: 'omit', redirect: 'error' });
        probeStatus = response.status;
        if (!response.ok || response.redirected || programSession(response.url)?.key !== session.key) throw new Error('response-rejected');
        const text = await readBoundedManifest(response, job.controller.signal);
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        if (doc.documentElement?.localName !== 'MPD' || doc.getElementsByTagNameNS('*', 'parsererror').length ||
            doc.documentElement.getAttribute('type') === 'dynamic' || /<!DOCTYPE/i.test(text)) throw new Error('unsupported-manifest');
        const reps = readDashRepresentations(text, response.url);
        if (!reps.length || reps.some(rep => !rep.indexedManifestEligible)) throw new Error('unsupported-manifest');
        if (valid(job)) {
          manifests.set(session.key, reps);
          log('manifest-proof', { reason: 'observed-session-manifest', url: reportPath(response.url) });
        }
      })();
      let timeout;
      const deadline = new Promise((_, reject) => {
        timeout = setTimeout(() => { reject(new Error('manifest-timeout')); job.controller.abort(); }, 5000);
      });
      const cancelled = new Promise((_, reject) => job.controller.signal.addEventListener('abort',
        () => reject(new Error('cancelled')), { once: true }));
      probes.set(session.key, Promise.race([work, deadline, cancelled]).catch(error => {
        const reasons = ['response-rejected', 'unsupported-manifest', 'manifest-too-large', 'unsupported-body', 'manifest-timeout', 'cancelled'];
        if (!job.cancelled) log('manifest-unavailable', {
          reason: reasons.includes(error.message) ? error.message : 'manifest-fetch-failed', status: probeStatus
        });
      }).finally(() => clearTimeout(timeout)));
    }
    await probes.get(session.key);
    return indexedProgramEvidence(manifests.get(session.key) || [], job.targetHeight, job.failure.keys);
  };
  const installPause = job => {
    let video = null, frame = null, poll = null;
    const clear = () => {
      document.removeEventListener('playing', playing, true);
      if (video && frame !== null) video.cancelVideoFrameCallback?.(frame);
      clearTimeout(poll);
    };
    const check = () => {
      frame = null;
      if (!valid(job) || activeVideo() !== video) return;
      const player = video.player, ad = safely(() => player.getAdapter('ad'));
      if (canRestoreProgramPause({ isAd: player.isAd, adBreakInProgress: ad?.adBreakInProgress,
        breakPending: ad?.breakPending, readyState: video.readyState, height: video.videoHeight,
        sourceId: player.resource?.ad?.ssai?.contentSourceId }, job.candidate)) {
        clear(); video.pause(); safely(() => job.tag.API.PLAYER.pause()); job.pauseRestored = true;
        log('pause-restored', { selectedHeight: job.targetHeight, contentTime: safely(() => job.tag.API.PLAYER.contentTime) });
      } else if (video.requestVideoFrameCallback) frame = video.requestVideoFrameCallback(check);
      else poll = setTimeout(check, 100);
    };
    function playing(event) {
      if (event.target?.tagName !== 'VIDEO' || String(event.target.player?.resource?.ad?.ssai?.contentSourceId) !== job.candidate.sourceId) return;
      if (video && frame !== null) video.cancelVideoFrameCallback?.(frame);
      clearTimeout(poll); video = event.target;
      if (video.requestVideoFrameCallback) frame = video.requestVideoFrameCallback(check);
      else check();
    }
    document.addEventListener('playing', playing, true);
    job.clearPause = clear;
  };
  const recover = async job => {
    try {
      const evidence = await proof(job);
      if (!valid(job)) return;
      job.candidate = chooseRecoverySource({ ...job.context, evidence });
      if (!job.candidate) throw new Error('unproven-source');
      if (job.candidate.startup) {
        const started = now();
        const attached = () => Array.from(document.querySelectorAll('video')).some(video => video.player === job.context.player);
        while (!job.teardownConfirmed && attached()) {
          if (!valid(job)) return;
          if (now() - started >= 5000) throw new Error('player-teardown-timeout');
          await sleep(50);
        }
        if (activeVideo() && activeVideo().player !== job.context.player) throw new Error('player-changed');
      } else if (activeVideo()?.player !== job.context.player || job.context.player.isAd !== false) {
        throw new Error('player-changed');
      }
      if (!valid(job)) return;
      const current = job.tag.params.CONTENT;
      if (!current?.millstone || !job.tag.API.VIDEO?.load || !Number.isFinite(job.resume.time)) throw new Error('unsupported-resource');
      const content = { ...current, globalResumeTime: job.resume.time, autoplay: true,
        millstone: { ...current.millstone, streamingUrl: job.candidate.catalogUrl,
          daiParams: { ...current.millstone.daiParams, daiCmsId: job.candidate.sourceId } } };
      job.phase = 'retrying';
      onAttempt();
      log('started', { sourceId: String(job.context.sourceId), alternativeSourceId: job.candidate.sourceId,
        selectedHeight: job.targetHeight, contentTime: job.resume.time, paused: job.resume.paused,
        url: reportPath(job.candidate.catalogUrl), startup: job.candidate.startup });
      if (job.resume.paused) installPause(job);
      let loadState = 'pending';
      Promise.resolve(job.tag.API.VIDEO.load({ CONTENT: content })).then(() => { loadState = 'loaded'; }, () => { loadState = 'failed'; });
      const clock = createSourceRecoveryClock(now());
      let firstTime = null, wasAd = false;
      while (valid(job)) {
        if (loadState === 'failed' || job.alternativeFailed) throw new Error('sdk-load-failed');
        const video = activeVideo(), player = video?.player;
        const sameSource = String(player?.resource?.ad?.ssai?.contentSourceId) === job.candidate.sourceId &&
          player?.resource?.ad?.ssai?.videoId === job.context.videoId;
        const isAd = sameSource && player.isAd === true;
        const elapsed = clock(now(), isAd);
        if (isAd !== wasAd) { wasAd = isAd; log('ad-wait', { active: isAd, ...elapsed }); }
        if (elapsed.expired) throw new Error('playback-timeout');
        if (loadState === 'loaded' && sameSource && player.isAd === false && video.readyState === 4 &&
            Math.abs(video.videoHeight - job.targetHeight) <= 16) {
          if ((job.resume.paused && video.paused && job.pauseRestored) ||
              (!job.resume.paused && !video.paused && firstTime !== null && video.currentTime - firstTime >= 3)) {
            log('recovered', { selectedHeight: job.targetHeight, decodedHeight: video.videoHeight,
              contentTime: safely(() => job.tag.API.PLAYER.contentTime), paused: video.paused });
            job.clearPause?.(); pending = null; resume = null; stopMonitoring(); return;
          }
          if (firstTime === null) firstTime = video.currentTime;
        } else firstTime = null;
        await sleep(250);
      }
    } catch (error) {
      if (!valid(job)) return;
      const reasons = ['unproven-source', 'player-teardown-timeout', 'player-changed', 'unsupported-resource', 'sdk-load-failed', 'playback-timeout'];
      log('failed', { reason: reasons.includes(error.message) ? error.message : 'sdk-unavailable', selectedHeight: job.targetHeight });
      // Unproven ad failures are left with the site. A failed, validated retry
      // returns to the original stream using the existing once-only mechanism.
      if (error.message !== 'player-changed' && (job.phase === 'retrying' || job.context.isAd === false)) recoverOriginal(job.failure.detail);
    } finally {
      job.clearPause?.(); job.controller.abort();
      if (pending === job) pending = null;
    }
  };
  function handleError(error, player) {
    if (!enabled || disposed) return false;
    sync(); bindTag();
    if (!tag) return false;
    const live = snapshot(player || activeVideo()?.player || lastPlayer);
    const context = live.sourceId ? live : lastSnapshot;
    if (!context) return false;
    if (pending?.phase === 'retrying' && error?.fatal === true && context.videoId === pending.context.videoId &&
        String(context.sourceId) === pending.candidate.sourceId) {
      pending.alternativeFailed = true; return true;
    }
    const failure = missingKeyFailure(error);
    if (!failure) return false;
    if (pending) return context.videoId === pending.context.videoId;
    const selected = selection();
    if (!(selected?.height >= 720)) return false;
    const session = programSession(context.url);
    if (!session || session.videoId !== videoId || session.sourceId !== String(context.sourceId) || session.videoId !== context.videoId) return false;
    if (context.isAd !== false && !(context.hasProgramPlayback === false && context.contentTime >= 0 && context.contentTime <= 0.25)) return false;
    if (!resume && !Number.isFinite(context.contentTime)) return false;
    const declaredSourceId = safely(() => tag.model.TagConstants.ADOPS_ID.CMSID);
    if (!/^\d+$/.test(String(declaredSourceId || '')) || String(declaredSourceId) === String(context.sourceId)) return false;
    const key = `${generation}|${selected.height}`;
    if (attempts.has(key)) return false;
    attempts.add(key);
    const saved = resume || { time: Math.max(0, context.contentTime), paused: context.paused === true };
    pending = { tag, context: { ...context, session, selection: selected, failure,
      declaredSourceId, catalogUrl: safely(() => tag.model.apiMetadata.streamingUrl) },
      failure, resume: saved, targetHeight: selected.height, configKey: qualityKey(getConfig()),
      generation, controller: new AbortController(), phase: 'checking', cancelled: false };
    onFailure(failure.detail);
    void recover(pending);
    return true;
  }
  const changed = event => {
    if (event.source === window && event.data?.type === 'PQI_ORIGINAL_STREAM_RECOVERY') { cancel(); return; }
    if (event.source !== window || event.data?.type !== 'PQI_CONFIG') return;
    if (pending && selection(pending)?.height !== pending.targetHeight) { log('cancelled', { reason: 'selection-changed' }); cancel(); }
    if (tag) sample();
  };
  const dispose = () => { reset(); disposed = true; window.removeEventListener('message', changed); };
  const stagePosition = () => {
    if (!enabled || disposed) return;
    sync();
    const video = activeVideo(), current = video ? snapshot(video.player) : null;
    if (!current || current.isAd !== false || current.videoId !== videoId || !Number.isFinite(current.contentTime)) return;
    safely(() => window.sessionStorage.setItem(SOURCE_RESUME_KEY, JSON.stringify({
      path: page, time: Math.max(0, current.contentTime), paused: video.paused, savedAt: Date.now()
    })));
  };
  if (enabled) {
    window.addEventListener('message', changed);
    window.addEventListener('pagehide', dispose, { once: true });
  }
  return { observeManifest, handleError, stagePosition, sync, dispose, busy: () => Boolean(pending) };
}
