import { getConfig, setCodecSupport } from './state.js';
import { recordPlaybackCheckpoint } from './diagnostics.js';
import { catalogManifest, chooseCodecUnlock, chooseStartupSource, isDaiFailoverError } from './source-recovery-policy.js';
import { findPlayerError } from './source-recovery.js';
import { getVideoCodecFamily } from './stream-model.js';
import { readBoundedManifest } from './manifest-body.js';

// Adjusts the Paramount player's stream request before its first load, so an
// explicit quality choice starts on a stream that can deliver it instead of
// failing and recovering. Only CONTENT.millstone is ever changed; DRM, ads,
// tracking and resume parameters pass through untouched. Auto is never changed.
const SKIP_KEY = 'pqiStartupAdjustSkip';
const SKIP_TTL_MS = 120000;
const FALLBACK_RELOAD_DELAY_MS = 1500;
const safely = fn => { try { return fn(); } catch { return null; } };
const CATALOG_TIMEOUT_MS = 5000;

// The HEVC and Dolby Vision renditions above 1080p that a title's unfiltered
// catalog manifest (HLS or DASH) lists, highest first, each with its peak bitrate.
export function readUhdQualities(text) {
  const found = new Map();
  const add = (height, bandwidth, codecs) => {
    const family = getVideoCodecFamily(codecs);
    if (!Number.isInteger(height) || height <= 1080 || (family !== 'hevc' && family !== 'dolby-vision')) return;
    found.set(height, Math.max(found.get(height) || 0, Number.isFinite(bandwidth) ? bandwidth : 0));
  };
  if (String(text).trimStart().startsWith('#EXTM3U')) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
      add(Number.parseInt(line.match(/RESOLUTION=\d+x(\d+)/)?.[1], 10),
        Number.parseInt(line.match(/[:,]BANDWIDTH=(\d+)/)?.[1], 10), line.match(/CODECS="([^"]+)"/)?.[1]);
    }
  } else {
    const doc = new DOMParser().parseFromString(String(text), 'application/xml');
    for (const rep of Array.from(doc.getElementsByTagNameNS('*', 'Representation'))) {
      add(Number.parseInt(rep.getAttribute('height'), 10), Number.parseInt(rep.getAttribute('bandwidth'), 10),
        rep.getAttribute('codecs') || rep.parentNode?.getAttribute?.('codecs'));
    }
  }
  return [...found].map(([height, bandwidth]) => ({ height, bandwidth })).sort((a, b) => b.height - a.height);
}
const HEVC_UHD = 'video/mp4; codecs="hvc1.2.4.L150.90"';

// FairPlay (Safari) is confirmed to decode Paramount's HEVC and Dolby Vision
// renditions. PlayReady with hardware security (Edge on some Windows PCs) may
// as well and is accepted on its own report, unverified; a failed start falls
// back through the one-reload skip. Desktop Widevine reports no HEVC support.
const HEVC_KEY_SYSTEMS = [
  ['com.apple.fps', { initDataTypes: ['sinf', 'skd'], videoCapabilities: [{ contentType: HEVC_UHD }] }],
  ['com.microsoft.playready.recommendation',
    { initDataTypes: ['cenc'], videoCapabilities: [{ contentType: HEVC_UHD, robustness: '3000' }] }]
];
export async function probeHevcSupport(nav = globalThis.navigator, mediaSource = globalThis.MediaSource) {
  if (typeof nav?.requestMediaKeySystemAccess !== 'function') return false;
  for (const [keySystem, configuration] of HEVC_KEY_SYSTEMS) {
    try {
      await nav.requestMediaKeySystemAccess(keySystem, [configuration]);
      // PlayReady content plays through Media Source, which must take HEVC too.
      if (keySystem === 'com.apple.fps' || safely(() => mediaSource.isTypeSupported(HEVC_UHD)) === true) return true;
    } catch { /* This DRM is absent or cannot decode HEVC. */ }
  }
  return false;
}

function consumeSkip(storage, path, now) {
  return safely(() => {
    const raw = storage.getItem(SKIP_KEY);
    if (!raw) return false;
    storage.removeItem(SKIP_KEY);
    const saved = JSON.parse(raw);
    return saved?.path === path && Number.isFinite(saved.at) && now - saved.at >= 0 && now - saved.at < SKIP_TTL_MS;
  }) === true;
}

// Pure transformation, exported for tests: returns the params to load and a
// summary of what changed, or the original params when nothing applies.
export function adjustLoadParams(params, { config, declaredSourceId, declaredCatalogUrl, hevcSupported, sourcePreference, skipped }) {
  const content = params?.CONTENT, millstone = content?.millstone, daiParams = millstone?.daiParams;
  if (!content || !millstone || !daiParams || typeof daiParams !== 'object') return { params, changes: null, reasons: ['no-millstone'] };
  const isLive = content.isLive === true;
  const reasons = [];
  let nextDai = daiParams, nextUrl = millstone.streamingUrl;
  const changes = {};
  if (sourcePreference) {
    const source = chooseStartupSource({ config, daiCmsId: daiParams.daiCmsId, declaredSourceId, isLive, skipped });
    if (source.sourceId) {
      nextDai = { ...nextDai, daiCmsId: source.sourceId };
      // Smart Tag's DAI failover plays Millstone's streamingUrl. Point it at
      // the declared source's catalog once known, as source recovery does, so a
      // failover does not land back on the assigned source's package.
      const catalog = catalogManifest(declaredCatalogUrl);
      if (catalog) nextUrl = catalog.href;
      changes.source = { from: source.assignedSourceId, to: source.sourceId, catalog: Boolean(catalog) };
    } else reasons.push(`source:${source.reason}`);
  }
  const unlock = chooseCodecUnlock({ config, hevcSupported, daiExcl: daiParams['dai-excl'], streamingUrl: nextUrl, isLive, skipped });
  if (unlock.removed) {
    if (typeof daiParams['dai-excl'] === 'string') nextDai = { ...nextDai, 'dai-excl': unlock.daiExcl };
    nextUrl = unlock.streamingUrl;
    changes.codecUnlock = { removed: unlock.removed };
  } else reasons.push(`codec:${unlock.reason}`);
  if (!changes.source && !changes.codecUnlock) return { params, changes: null, reasons };
  return {
    params: { ...params, CONTENT: { ...content, millstone: { ...millstone, streamingUrl: nextUrl, daiParams: nextDai } } },
    changes, reasons
  };
}

// What an adjustment does to the stream itself. The failover catalog is left
// out: it only matters if Smart Tag later fails over.
const streamSignature = changes => `${changes?.source?.to || ''}|${changes?.codecUnlock ? 'unlock' : ''}`;

export function installStartupSource({ sourcePreference, storage = safely(() => window.sessionStorage),
  now = () => Date.now(), hevcProbe = probeHevcSupport(), reload = () => window.location.reload(),
  stagePosition = () => {}, fetchCatalog = null } = {}) {
  let hevcSupported = null;
  const path = window.location.pathname;
  const skipped = storage ? consumeSkip(storage, path, now()) : false;
  if (skipped) recordPlaybackCheckpoint('startup_adjustment', { outcome: 'skipped', reason: 'previous-attempt-failed' });
  const wrappedTags = new WeakSet();
  const knownTags = [];
  // Per tag, the Millstone the page supplied and the one this module stored
  // in its place, so a later Auto choice can put the page's own one back.
  const storedMillstone = new WeakMap();
  // Per tag, the page's own content of the last load and the adjustment that
  // load was started with.
  const loaded = new WeakMap();
  let adjusted = null, watching = null, confirmTimer = null, originalRecovery = false, reloadRequested = false;

  const evaluate = (params, tag, config = getConfig()) => {
    const declaredSourceId = safely(() => tag.model.TagConstants.ADOPS_ID.CMSID);
    const declaredCatalogUrl = safely(() => tag.model.apiMetadata.streamingUrl);
    return adjustLoadParams(params, { config, declaredSourceId, declaredCatalogUrl, hevcSupported,
      sourcePreference, skipped });
  };
  // Auto leaves Paramount's request alone, so its stream has no HEVC renditions
  // to list. Read the title's unfiltered catalog (a request of this module's
  // own, never the player's) and tell the popup which heights a pick would
  // really add after a reload. Nothing is offered if that cannot be read.
  let offeredCatalog = '';
  const offer = qualities => window.postMessage({ type: 'PQI_UNLOCKABLE_QUALITIES', payload: { qualities } }, '*');
  const publishUnlockable = tag => {
    const last = loaded.get(tag);
    const unlocked = last && !last.signature.endsWith('|unlock')
      ? evaluate({ CONTENT: last.content }, tag, { forcedHeight: 2160 }) : null;
    const catalog = unlocked?.changes?.codecUnlock ? safely(() => {
      const url = new URL(unlocked.params.CONTENT.millstone.streamingUrl);
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
    }) : null;
    const key = (typeof fetchCatalog === 'function' && catalog) || '';
    if (key === offeredCatalog) return;
    offeredCatalog = key;
    offer([]);
    if (!key) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
    Promise.resolve().then(() => fetchCatalog(key, { credentials: 'omit', signal: controller.signal }))
      .then(async response => response?.ok ? readUhdQualities(await readBoundedManifest(response, controller.signal)) : [])
      .catch(() => [])
      .then(qualities => {
        clearTimeout(timer);
        if (offeredCatalog !== key || !qualities.length) return;
        recordPlaybackCheckpoint('startup_adjustment', { outcome: 'offered', maxHeight: qualities[0].height });
        offer(qualities);
      });
  };
  const adjust = (params, tag, record = true) => {
    const result = evaluate(params, tag);
    if (record && params?.CONTENT?.millstone) {
      loaded.set(tag, { content: params.CONTENT, signature: streamSignature(result.changes) });
      publishUnlockable(tag);
    }
    if (!result.changes) {
      if (record && !result.reasons.includes('no-millstone'))
        recordPlaybackCheckpoint('startup_adjustment', { outcome: 'unchanged', reasons: result.reasons.join(',') });
      return params;
    }
    // Only a load the player is about to start is watched for failure; a
    // background refresh of the stored params (catalog arrival, a quality
    // change during playback) only keeps the watched record current.
    if (record) {
      adjusted = { at: now(), changes: result.changes };
      recordPlaybackCheckpoint('startup_adjustment', { outcome: 'applied',
        sourceFrom: result.changes.source?.from || null, sourceTo: result.changes.source?.to || null,
        failoverCatalog: result.changes.source?.catalog ?? null, codecUnlock: Boolean(result.changes.codecUnlock) });
      watch(tag);
    } else if (adjusted) adjusted = { ...adjusted, changes: result.changes };
    return result.params;
  };

  // The page hands Millstone to SmartTag.create and its first load carries
  // none, so Smart Tag reads it from the tag's stored params. Adjust those in
  // place, always starting from the page's own Millstone: a choice that no
  // longer qualifies (such as Auto) restores it unchanged.
  const adjustStoredParams = (tag, record = true) => {
    const content = safely(() => tag.params.CONTENT);
    if (!content?.millstone) return;
    const saved = storedMillstone.get(tag);
    const base = saved && content.millstone === saved.applied ? saved.original : content.millstone;
    const next = adjust({ CONTENT: { ...content, millstone: base } }, tag, record).CONTENT.millstone;
    if (next === content.millstone) return;
    safely(() => { content.millstone = next; });
    storedMillstone.set(tag, next === base ? null : { original: base, applied: next });
  };

  // Smart Tag reports fatal errors either as a player error or as its own
  // { fatalError: { code } } payload; read the code from whichever is present.
  const fatalCode = event => {
    const error = findPlayerError(event), data = event?.data;
    const code = error?.code ?? data?.fatalError?.code ?? data?.error?.code ?? data?.code ?? null;
    return code == null ? null : String(code);
  };
  // A failure of the adjusted stream before its program plays turns the
  // adjustment off for one reload of this page, which then behaves exactly as
  // it would without it (including the existing recovery and Auto fallback).
  const programPlaying = () => Array.from(document.querySelectorAll('video')).some(video =>
    video.player?.isAd === false && video.readyState >= 3 && video.currentTime > 0.5 && !video.paused);
  const onTag = event => {
    if (!adjusted || event?.type !== 'TagEvent.ON_FATAL_ERROR') return;
    const code = fatalCode(event);
    // Smart Tag answers DAI stream errors with its own failover load.
    if (isDaiFailoverError({ code })) return;
    if (programPlaying()) { unwatch(); adjusted = null; return; }
    safely(() => storage?.setItem(SKIP_KEY, JSON.stringify({ path, at: now() })));
    recordPlaybackCheckpoint('startup_adjustment', { outcome: 'failed', code });
    const failed = adjusted;
    adjusted = null;
    unwatch();
    setTimeout(() => {
      if (!originalRecovery && failed && window.location.pathname === path) reload();
    }, FALLBACK_RELOAD_DELAY_MS);
  };
  const unwatch = () => {
    clearInterval(confirmTimer);
    confirmTimer = null;
    if (!watching) return;
    safely(() => watching.eventDispatcher.removeEventListener('TagEvent.ON_FATAL_ERROR', onTag));
    watching = null;
  };
  // Watch until the program plays, or for as long as a failure would still be
  // attributed to this adjustment.
  const watch = tag => {
    if (watching === tag || typeof tag?.tagEventsHandler !== 'function') return;
    unwatch();
    watching = tag;
    safely(() => tag.tagEventsHandler(onTag, ['TagEvent.ON_FATAL_ERROR']));
    const started = now();
    confirmTimer = setInterval(() => {
      if (watching !== tag) { unwatch(); return; }
      if (programPlaying() || now() - started >= SKIP_TTL_MS) { unwatch(); adjusted = null; return; }
      // The declared catalog arrives with Smart Tag's metadata after the
      // first adjustment; point the failover at it as soon as it is known.
      if (adjusted?.changes?.source && !adjusted.changes.source.catalog &&
          catalogManifest(safely(() => tag.model.apiMetadata.streamingUrl))) adjustStoredParams(tag, false);
    }, 1000);
  };
  // A stream keeps the source and codec list it was created with. When a new
  // selection calls for a different adjustment than the playing stream got
  // (Auto after an unlocked start, or the reverse), only a new page load can
  // apply it, so ask the content script for one with the position staged.
  const reloadIfStreamOutdated = tag => {
    const last = loaded.get(tag);
    if (!last || reloadRequested || streamSignature(evaluate({ CONTENT: last.content }, tag).changes) === last.signature) return;
    reloadRequested = true;
    safely(stagePosition);
    recordPlaybackCheckpoint('startup_adjustment', { outcome: 'reload', reason: 'selection-changed' });
    window.postMessage({ type: 'PQI_STARTUP_RELOAD', payload: { config: getConfig() } }, '*');
  };
  window.addEventListener('message', event => {
    if (event.source !== window) return;
    if (event.data?.type === 'PQI_ORIGINAL_STREAM_RECOVERY') originalRecovery = true;
    // Smart Tag's own in-page reloads read the stored params directly, so a
    // quality change (Auto in particular) updates them right away.
    else if (event.data?.type === 'PQI_CONFIG') for (const tag of knownTags) {
      adjustStoredParams(tag, false);
      reloadIfStreamOutdated(tag);
    }
  });
  window.addEventListener('pagehide', unwatch);
  // FairPlay support settles asynchronously. If it arrives after the page's
  // first (queued) load call, adjust the stored params again before playback.
  Promise.resolve(hevcProbe).then(value => { hevcSupported = value === true; }, () => { hevcSupported = false; })
    .then(() => {
      setCodecSupport({ hevc: hevcSupported });
      if (!hevcSupported) return;
      if (!programPlaying()) for (const tag of knownTags) adjustStoredParams(tag);
      for (const tag of knownTags) publishUnlockable(tag);
    });

  const wrappedVideos = new WeakSet();
  const wrapLoad = (video, tag) => {
    if (!video || typeof video !== 'object' || wrappedVideos.has(video) || typeof video.load !== 'function') return video;
    wrappedVideos.add(video);
    const load = video.load;
    // The page's own call must go through whatever happens in here: a failed
    // adjustment loads the page's params, and a read-only load is left alone.
    safely(() => {
      video.load = function pqiLoad(params, ...rest) {
        const next = safely(() => {
          if (params?.CONTENT?.millstone) return adjust(params, tag);
          adjustStoredParams(tag);
          return params;
        });
        return load.call(this, next ?? params, ...rest);
      };
    });
    return video;
  };
  const findDescriptor = (object, name) => {
    for (let owner = object; owner; owner = Object.getPrototypeOf(owner)) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (descriptor) return descriptor;
    }
    return null;
  };
  // Wrap a getter (or value) so whatever it returns passes through `wrap`.
  const interpose = (object, name, wrap) => {
    const descriptor = findDescriptor(object, name);
    if (!descriptor) return false;
    if (typeof descriptor.get !== 'function') { safely(() => wrap(descriptor.value)); return true; }
    const get = descriptor.get;
    return safely(() => Object.defineProperty(object, name, {
      configurable: true, enumerable: descriptor.enumerable,
      get() {
        const value = get.call(this);
        safely(() => wrap(value));
        return value;
      }
    })) !== null;
  };
  // Smart Tag's tag.API getter returns an object it replaces during setup, and
  // API.VIDEO builds a new object on every access. Both getters are wrapped so
  // the load the page calls is always the adjusted one.
  const wrappedApis = new WeakSet();
  const wrapApi = (api, tag) => {
    if (!api || typeof api !== 'object' || wrappedApis.has(api)) return api;
    wrappedApis.add(api);
    interpose(api, 'VIDEO', video => wrapLoad(video, tag));
    return api;
  };
  const wrapTag = tag => {
    if (!tag || typeof tag !== 'object' || wrappedTags.has(tag)) return;
    wrappedTags.add(tag);
    knownTags.push(tag);
    interpose(tag, 'API', api => wrapApi(api, tag));
  };
  const wrapSmartTag = smartTag => {
    if (!smartTag || typeof smartTag !== 'object' || smartTag.__pqiStartupWrapped) return;
    const create = smartTag.create;
    if (typeof create !== 'function') return;
    safely(() => Object.defineProperty(smartTag, '__pqiStartupWrapped', { value: true }));
    // The page calls VIDEO.load right after create, before the tag is ready,
    // and Smart Tag queues it. The new tag is listed synchronously, so wrap it
    // before create returns to the page.
    const wrapListed = () => safely(() => { for (const listed of smartTag.list || []) wrapTag(listed); });
    safely(() => {
      smartTag.create = function pqiCreate(...args) {
        const result = create.apply(this, args);
        wrapListed();
        return result;
      };
    });
    wrapListed();
  };

  // Smart Tag loads after this module. Observe its global assignment so the
  // wrapper is in place before the page creates its player.
  const existing = Object.getOwnPropertyDescriptor(window, 'SmartTag');
  if (existing && !existing.configurable) return;
  let value = window.SmartTag;
  safely(() => wrapSmartTag(value));
  try {
    Object.defineProperty(window, 'SmartTag', {
      configurable: true, enumerable: true,
      get: () => value,
      set: next => { value = next; safely(() => wrapSmartTag(next)); }
    });
  } catch { /* The page owns the global; leave its behavior unchanged. */ }
}
