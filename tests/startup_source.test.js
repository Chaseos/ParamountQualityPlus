import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { TextDecoder, TextEncoder } from 'node:util';
import { adjustLoadParams, installStartupSource, probeHevcSupport, readUhdQualities } from '../injected/startup-source.js';
import { chooseCodecUnlock, chooseStartupSource, indexedProgramEvidence, missingKeyFailure,
  swapGuidKeyId } from '../injected/source-recovery-policy.js';
import { readDashRepresentations } from '../injected/manifest-parser.js';
import { setCodecSupport, setConfig } from '../injected/state.js';
import { getDiagnosticSnapshot, resetDiagnostics } from '../injected/diagnostics.js';
import { catalog, failure, hdKey, indexedXml, sdKey, url } from './fixtures/source-recovery.js';
import { filterIndexedDash } from '../injected/indexed-dash.js';

// Synthetic Millstone parameters shaped like the page's player configuration.
const exclusions = 'codec:ec-3,codec:atm,codec:hvc1*,codec:hvc1.2*,codec:dvh*,audio-lang:de,subtitle-lang:de';
const catalogPath = 'https://bakery.example.test/o(vod-drm)/a(ec-3,atm)/v(hvc,hdr10,dvh)/a(l(de))/asset/program_cenc_fmp4_dash/stream.mpd';
const params = () => ({ CONTENT: { contentId: 'episode', isLive: false, drm: { enabled: true }, globalResumeTime: 42,
  millstone: { streamingUrl: catalogPath, daiParams: { daiCmsId: '222', 'dai-excl': exclusions }, ruleIds: [1] } },
  AD: { keep: true } });
const forceMax = { forceMax: true, forcedId: null, forcedHeight: null };
const auto = { forceMax: false, forcedId: null, forcedHeight: null };

test('an explicit HD choice starts on the declared source; Auto, SD, live and repeat attempts do not', () => {
  expect(chooseStartupSource({ config: forceMax, daiCmsId: '222', declaredSourceId: 111 }))
    .toEqual({ sourceId: '111', assignedSourceId: '222' });
  expect(chooseStartupSource({ config: { forcedHeight: 720 }, daiCmsId: '222', declaredSourceId: '111' }).sourceId).toBe('111');
  for (const [change, reason] of [[{ config: auto }, 'no-hd-selection'], [{ config: { forcedHeight: 540 } }, 'no-hd-selection'],
    [{ isLive: true }, 'live'], [{ skipped: true }, 'previous-attempt-failed'], [{ declaredSourceId: '222' }, 'already-declared'],
    [{ declaredSourceId: undefined }, 'no-declared-source'], [{ daiCmsId: 'abc' }, 'no-assigned-source']])
    expect(chooseStartupSource({ config: forceMax, daiCmsId: '222', declaredSourceId: '111', ...change }).reason).toBe(reason);
});

test('codec exclusions are lifted only for a UHD choice on DRM that decodes HEVC, keeping audio and language filters', () => {
  const unlock = chooseCodecUnlock({ config: forceMax, hevcSupported: true, daiExcl: exclusions, streamingUrl: catalogPath });
  expect(unlock.daiExcl).toBe('codec:ec-3,codec:atm,audio-lang:de,subtitle-lang:de');
  expect(unlock.streamingUrl).toBe(catalogPath.replace('/v(hvc,hdr10,dvh)', ''));
  expect(unlock.removed).toEqual(['codec:hvc1*', 'codec:hvc1.2*', 'codec:dvh*']);
  expect(chooseCodecUnlock({ config: { forcedHeight: 2160 }, hevcSupported: true, daiExcl: exclusions }).removed).toHaveLength(3);
  for (const [change, reason] of [[{ hevcSupported: false }, 'hevc-unsupported'], [{ hevcSupported: null }, 'hevc-unsupported'],
    [{ config: auto }, 'no-uhd-selection'], [{ config: { forcedHeight: 1080 } }, 'no-uhd-selection'], [{ isLive: true }, 'live'],
    [{ skipped: true }, 'previous-attempt-failed'], [{ daiExcl: 'codec:ec-3', streamingUrl: 'https://x.test/a.mpd' }, 'nothing-excluded']])
    expect(chooseCodecUnlock({ config: forceMax, hevcSupported: true, daiExcl: exclusions, streamingUrl: catalogPath, ...change }).reason).toBe(reason);
});

test('load parameters change only in Millstone, without mutating the page objects', () => {
  const original = params(), snapshot = JSON.stringify(original);
  const result = adjustLoadParams(original, { config: forceMax, declaredSourceId: '111', hevcSupported: false, sourcePreference: true });
  expect(JSON.stringify(original)).toBe(snapshot);
  expect(result.changes).toEqual({ source: { from: '222', to: '111', catalog: false } });
  expect(result.params.CONTENT.millstone.daiParams).toEqual({ daiCmsId: '111', 'dai-excl': exclusions });
  expect(result.params.CONTENT.millstone.streamingUrl).toBe(catalogPath);
  const { millstone: _m, ...rest } = result.params.CONTENT, { millstone: _o, ...originalRest } = original.CONTENT;
  expect(rest).toEqual(originalRest);
  expect(result.params.AD).toBe(original.AD);
  expect(result.params.CONTENT.millstone.ruleIds).toBe(original.CONTENT.millstone.ruleIds);
});

test('Auto and non-preferring browsers keep the page parameters object itself', () => {
  const original = params();
  expect(adjustLoadParams(original, { config: auto, declaredSourceId: '111', hevcSupported: true, sourcePreference: true }).params).toBe(original);
  expect(adjustLoadParams(original, { config: forceMax, declaredSourceId: '111', hevcSupported: false, sourcePreference: false }).params).toBe(original);
  expect(adjustLoadParams({ CONTENT: { isLive: true } }, { config: forceMax, sourcePreference: true }).changes).toBeNull();
});

test('Safari-style unlock keeps the assigned source and drops only video exclusions', () => {
  const result = adjustLoadParams(params(), { config: forceMax, declaredSourceId: '111', hevcSupported: true, sourcePreference: false });
  expect(result.params.CONTENT.millstone.daiParams.daiCmsId).toBe('222');
  expect(result.params.CONTENT.millstone.daiParams['dai-excl']).not.toMatch(/hvc1|dvh/);
  expect(result.params.CONTENT.millstone.streamingUrl).not.toContain('/v(');
});

test('a PlayReady-restricted HD key qualifies only when its key ID is named and another key is usable', () => {
  const restricted = { ...failure, cause: { ...failure.cause, data: [{ missingKeys: [], hasAppRestrictions: false,
    restrictedKeyStatuses: ['output-restricted'] }] } };
  expect(missingKeyFailure(restricted)).toBeNull();
  expect(missingKeyFailure(restricted, { [hdKey]: 'output-restricted', [sdKey]: 'usable' }))
    .toMatchObject({ keys: [], restrictedKeys: [hdKey], detail: { restrictedKeyStatuses: ['output-restricted'], restrictedKeyCount: 1 } });
  expect(missingKeyFailure(restricted, { [hdKey]: 'output-restricted', [sdKey]: 'expired' })).toBeNull();
  const unknown = { ...restricted, cause: { ...restricted.cause, data: [{ ...restricted.cause.data[0], restrictedKeyStatuses: ['released'] }] } };
  expect(missingKeyFailure(unknown, { [hdKey]: 'released', [sdKey]: 'usable' })).toBeNull();
  expect(missingKeyFailure(failure, {})).toMatchObject({ keys: [hdKey], restrictedKeys: [] });
});

test('a restricted key of another rendition does not defeat the selected HD key proof', () => {
  const uhdKey = 'ffffffffffffffffffffffffffffffff';
  const restricted = { ...failure, cause: { ...failure.cause, data: [{ missingKeys: [], hasAppRestrictions: false,
    restrictedKeyStatuses: ['output-restricted', 'output-downscaled'] }] } };
  const found = missingKeyFailure(restricted, { [hdKey]: 'output-downscaled', [uhdKey]: 'output-restricted', [sdKey]: 'usable', '00': 'internal-error' });
  expect(found).toMatchObject({ keys: [], restrictedKeys: [hdKey, uhdKey] });
  const reps = readDashRepresentations(indexedXml, url);
  expect(indexedProgramEvidence(reps, 1080, found.keys, found.restrictedKeys).matched).toBe(true);
  // Restricted keys that the selection does not declare prove nothing.
  expect(indexedProgramEvidence(reps, 1080, [], [uhdKey]).matched).toBe(false);
  expect(indexedProgramEvidence(reps, 1080, [], []).matched).toBe(false);
  // A missing key outside the selection still rejects the proof.
  expect(indexedProgramEvidence(reps, 1080, [sdKey], [hdKey]).matched).toBe(false);
});

test('PlayReady little-endian key IDs still prove the selected HD representation', () => {
  expect(swapGuidKeyId('00112233-4455-6677-8899-aabbccddeeff')).toBe('33221100554477668899aabbccddeeff');
  expect(swapGuidKeyId(swapGuidKeyId(hdKey))).toBe(hdKey);
  const reps = readDashRepresentations(indexedXml, url);
  expect(indexedProgramEvidence(reps, 1080, [swapGuidKeyId(hdKey)]).matched).toBe(true);
  expect(indexedProgramEvidence(reps, 1080, [swapGuidKeyId(sdKey)]).matched).toBe(false);
});

test('HEVC and Dolby Vision rows are hidden only when the browser is known not to decode them', () => {
  const mixed = indexedXml.replace('</AdaptationSet>', `</AdaptationSet><AdaptationSet contentType="video">
<Representation id="uhd" height="2160" width="3840" bandwidth="16000000" codecs="hvc1.2.4.L150.90">
<BaseURL>https://vod.pplus.paramount.tech/intl_vms/example/asset/indexed_cenc_fmp4_dash/program_2160p.mp4</BaseURL>
<SegmentBase indexRange="100-199"><Initialization range="0-99"/></SegmentBase></Representation>
<Representation id="dv" height="2160" width="3840" bandwidth="15000000" codecs="dvhe.05.06">
<BaseURL>https://vod.pplus.paramount.tech/intl_vms/example/asset/indexed_cenc_fmp4_dash/program_dv_2160p.mp4</BaseURL>
<SegmentBase indexRange="100-199"><Initialization range="0-99"/></SegmentBase></Representation></AdaptationSet>`);
  setCodecSupport({ hevc: null });
  expect(readDashRepresentations(mixed, url).map(rep => rep.height)).toEqual([2160, 1080, 540]);
  setCodecSupport({ hevc: true });
  expect(readDashRepresentations(mixed, url)[0].height).toBe(2160);
  setCodecSupport({ hevc: false });
  expect(readDashRepresentations(mixed, url).map(rep => rep.height)).toEqual([1080, 540]);
  const hevcOnly = mixed.replace(/codecs="avc1\.640028"/g, 'codecs="hvc1.2.4.L120.90"');
  expect(readDashRepresentations(hevcOnly, url).length).toBe(3);
  setCodecSupport({ hevc: null });
});

test('a missing streamingUrl with nothing to lift is not reported as an unlock', () => {
  expect(chooseCodecUnlock({ config: forceMax, hevcSupported: true, daiExcl: 'codec:ec-3' }).reason).toBe('nothing-excluded');
  expect(adjustLoadParams({ CONTENT: { millstone: { daiParams: { daiCmsId: '222', 'dai-excl': 'codec:ec-3' } } } },
    { config: forceMax, declaredSourceId: '222', hevcSupported: true, sourcePreference: true }).changes).toBeNull();
});

test('the declared catalog becomes the failover URL when Smart Tag already knows it', () => {
  const result = adjustLoadParams(params(), { config: forceMax, declaredSourceId: '111', declaredCatalogUrl: catalog,
    hevcSupported: false, sourcePreference: true });
  expect(result.params.CONTENT.millstone.streamingUrl).toBe(new URL(catalog).href);
  expect(result.changes.source.catalog).toBe(true);
  const untrusted = adjustLoadParams(params(), { config: forceMax, declaredSourceId: '111',
    declaredCatalogUrl: 'https://elsewhere.test/a_cenc_dash/stream.mpd', hevcSupported: false, sourcePreference: true });
  expect(untrusted.params.CONTENT.millstone.streamingUrl).toBe(catalogPath);
});

test('the indexed filter also drops HEVC and Dolby Vision nodes the ladder hid', () => {
  const mixed = indexedXml.replace('</AdaptationSet>', `</AdaptationSet><AdaptationSet contentType="video">
<Representation id="uhd" height="2160" width="3840" bandwidth="16000000" codecs="hvc1.2.4.L150.90">
<BaseURL>https://vod.pplus.paramount.tech/intl_vms/example/asset/indexed_cenc_fmp4_dash/program_2160p.mp4</BaseURL>
<SegmentBase indexRange="100-199"><Initialization range="0-99"/></SegmentBase></Representation></AdaptationSet>`);
  setCodecSupport({ hevc: false });
  const reps = readDashRepresentations(mixed, url);
  const filtered = filterIndexedDash(mixed, url, reps, forceMax);
  expect(filtered).toMatchObject({ supported: true, selectedHeight: 1080 });
  expect(filtered.text).not.toContain('hvc1');
  expect(filtered.text).toContain('program_1080p.mp4');
  setCodecSupport({ hevc: null });
  const kept = filterIndexedDash(mixed, url, readDashRepresentations(mixed, url), { forcedHeight: 1080 });
  expect(kept.text).not.toContain('hvc1');
});

test('HEVC support is taken from FairPlay, or from hardware PlayReady that Media Source can also play', async () => {
  const nav = accepted => ({ requestMediaKeySystemAccess: jest.fn(async (keySystem, [config]) => {
    if (!accepted.includes(keySystem)) throw new Error('NotSupportedError');
    return { keySystem, config };
  }) });
  const mse = supported => ({ isTypeSupported: () => supported });
  expect(await probeHevcSupport(nav(['com.apple.fps']), undefined)).toBe(true);
  const edge = nav(['com.microsoft.playready.recommendation', 'com.widevine.alpha']);
  expect(await probeHevcSupport(edge, mse(true))).toBe(true);
  expect(edge.requestMediaKeySystemAccess.mock.calls.at(-1)[1][0].videoCapabilities[0]).toMatchObject({ robustness: '3000' });
  expect(await probeHevcSupport(edge, mse(false))).toBe(false);
  expect(await probeHevcSupport(nav(['com.widevine.alpha']), mse(true))).toBe(false);
  expect(await probeHevcSupport({}, mse(true))).toBe(false);
});

describe('installed page hook', () => {
  let created, load, storage;
  const makeSmartTag = () => {
    load = jest.fn(async () => {});
    const handlers = new Map();
    // Like Smart Tag, every API.VIDEO access returns a new object with its own load.
    const api = Object.create({ get VIDEO() { return { load: (...args) => load(...args) }; } });
    const tag = { model: { TagConstants: { ADOPS_ID: { CMSID: '111' } } }, API: api,
      tagEventsHandler: (handler, types) => types.forEach(type => handlers.set(type, handler)),
      eventDispatcher: { removeEventListener: (type) => handlers.delete(type) }, handlers };
    created = tag;
    return { list: [], create(paramsVO) { tag.params = paramsVO; this.list.push(tag); return Promise.resolve({ msg: 'ready', tag }); } };
  };
  beforeEach(() => {
    globalThis.TextDecoder = TextDecoder;
    resetDiagnostics();
    delete window.SmartTag;
    storage = new Map();
    window.history.replaceState({}, '', '/shows/video/episode/');
    setConfig(forceMax);
  });
  afterEach(() => { delete window.SmartTag; setConfig(auto); jest.useRealTimers(); });
  const sessionStore = () => ({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key) });
  const checkpoints = () => getDiagnosticSnapshot().recentEvents.filter(e => e.detail.checkpoint === 'startup_adjustment').map(e => e.detail);

  test('wraps the first load after Smart Tag arrives and rewrites only the source', async () => {
    installStartupSource({ sourcePreference: true, storage: sessionStore(), hevcProbe: Promise.resolve(false) });
    window.SmartTag = makeSmartTag();
    const { tag } = await window.SmartTag.create({});
    await tag.API.VIDEO.load(params());
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0][0].CONTENT.millstone.daiParams.daiCmsId).toBe('111');
    expect(checkpoints().at(-1)).toMatchObject({ outcome: 'applied', sourceFrom: '222', sourceTo: '111', codecUnlock: false });
  });

  test('Millstone given to create is adjusted on the tag before its first load, which carries none', async () => {
    installStartupSource({ sourcePreference: true, storage: sessionStore(), hevcProbe: Promise.resolve(false) });
    window.SmartTag = makeSmartTag();
    const page = params();
    window.SmartTag.create(page);
    // The page loads immediately, before create settles.
    await created.API.VIDEO.load({ CONTENT: { autoplay: true } });
    expect(created.params.CONTENT.millstone.daiParams.daiCmsId).toBe('111');
    expect(created.params.CONTENT.globalResumeTime).toBe(42);
    expect(load.mock.calls[0][0]).toEqual({ CONTENT: { autoplay: true } });
    expect(checkpoints().filter(c => c.outcome === 'applied')).toHaveLength(1);
  });

  test('Auto passes the page parameters through unchanged', async () => {
    setConfig(auto);
    installStartupSource({ sourcePreference: true, storage: sessionStore(), hevcProbe: Promise.resolve(false) });
    window.SmartTag = makeSmartTag();
    const { tag } = await window.SmartTag.create({});
    const original = params();
    await tag.API.VIDEO.load(original);
    expect(load.mock.calls[0][0]).toBe(original);
    expect(checkpoints().at(-1)).toMatchObject({ outcome: 'unchanged' });
  });

  test('a fatal error before program playback turns the adjustment off for one reload', async () => {
    jest.useFakeTimers();
    const reload = jest.fn();
    const location = window.location;
    installStartupSource({ sourcePreference: true, storage: sessionStore(), hevcProbe: Promise.resolve(false), reload });
    window.SmartTag = makeSmartTag();
    const { tag } = await window.SmartTag.create({});
    await tag.API.VIDEO.load(params());
    created.handlers.get('TagEvent.ON_FATAL_ERROR')({ type: 'TagEvent.ON_FATAL_ERROR', data: { error: { code: '3304', fatal: true } } });
    expect(JSON.parse(storage.get('pqiStartupAdjustSkip'))).toMatchObject({ path: '/shows/video/episode/' });
    expect(checkpoints().at(-1)).toMatchObject({ outcome: 'failed', code: '3304' });
    await jest.advanceTimersByTimeAsync(2000);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(window.location).toBe(location);

    // The reloaded page consumes the flag and leaves the next load unchanged.
    resetDiagnostics();
    installStartupSource({ sourcePreference: true, storage: sessionStore(), hevcProbe: Promise.resolve(false), reload });
    window.SmartTag = makeSmartTag();
    const { tag: next } = await window.SmartTag.create({});
    await next.API.VIDEO.load(params());
    expect(load.mock.calls[0][0].CONTENT.millstone.daiParams.daiCmsId).toBe('222');
    expect(storage.has('pqiStartupAdjustSkip')).toBe(false);
  });

  test('Smart Tag DAI failover codes and original-stream recovery do not trigger the extra reload', async () => {
    jest.useFakeTimers();
    const reload = jest.fn();
    installStartupSource({ sourcePreference: true, storage: sessionStore(), hevcProbe: Promise.resolve(false), reload });
    window.SmartTag = makeSmartTag();
    const { tag } = await window.SmartTag.create({});
    await tag.API.VIDEO.load(params());
    created.handlers.get('TagEvent.ON_FATAL_ERROR')({ type: 'TagEvent.ON_FATAL_ERROR', data: { error: { code: '4201', fatal: true } } });
    expect(storage.has('pqiStartupAdjustSkip')).toBe(false);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'PQI_ORIGINAL_STREAM_RECOVERY' }, source: window }));
    created.handlers.get('TagEvent.ON_FATAL_ERROR')({ type: 'TagEvent.ON_FATAL_ERROR', data: { error: { code: '2103', fatal: true } } });
    await jest.advanceTimersByTimeAsync(2000);
    expect(storage.has('pqiStartupAdjustSkip')).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  test("Smart Tag's own fatalError payload is read for failover codes", async () => {
    jest.useFakeTimers();
    const reload = jest.fn();
    installStartupSource({ sourcePreference: true, storage: sessionStore(), hevcProbe: Promise.resolve(false), reload });
    window.SmartTag = makeSmartTag();
    const { tag } = await window.SmartTag.create({});
    await tag.API.VIDEO.load(params());
    created.handlers.get('TagEvent.ON_FATAL_ERROR')({ type: 'TagEvent.ON_FATAL_ERROR', data: { fatalError: { code: 4201 } } });
    await jest.advanceTimersByTimeAsync(2000);
    expect(storage.has('pqiStartupAdjustSkip')).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    created.handlers.get('TagEvent.ON_FATAL_ERROR')({ type: 'TagEvent.ON_FATAL_ERROR', data: { fatalError: { code: 3304 } } });
    expect(checkpoints().at(-1)).toMatchObject({ outcome: 'failed', code: '3304' });
    await jest.advanceTimersByTimeAsync(2000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('the stored failover URL moves to the declared catalog once Smart Tag reports it', async () => {
    jest.useFakeTimers();
    installStartupSource({ sourcePreference: true, storage: sessionStore(), hevcProbe: Promise.resolve(false) });
    window.SmartTag = makeSmartTag();
    window.SmartTag.create(params());
    await created.API.VIDEO.load({ CONTENT: {} });
    expect(created.params.CONTENT.millstone.streamingUrl).toBe(catalogPath);
    created.model.apiMetadata = { streamingUrl: catalog };
    await jest.advanceTimersByTimeAsync(1100);
    expect(created.params.CONTENT.millstone).toMatchObject({ streamingUrl: new URL(catalog).href, daiParams: { daiCmsId: '111' } });
  });

  test('a late FairPlay answer still unlocks the stored params before playback', async () => {
    let answer;
    installStartupSource({ sourcePreference: false, storage: sessionStore(), hevcProbe: new Promise(resolve => { answer = resolve; }) });
    window.SmartTag = makeSmartTag();
    window.SmartTag.create(params());
    await created.API.VIDEO.load({ CONTENT: {} });
    expect(created.params.CONTENT.millstone.daiParams['dai-excl']).toContain('hvc1');
    answer(true);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(created.params.CONTENT.millstone.daiParams['dai-excl']).not.toMatch(/hvc1|dvh/);
    expect(created.params.CONTENT.millstone.streamingUrl).not.toContain('/v(');
  });

  test("choosing Auto restores the page's own Millstone for Smart Tag's in-page reloads", async () => {
    installStartupSource({ sourcePreference: true, storage: sessionStore(), hevcProbe: Promise.resolve(false) });
    window.SmartTag = makeSmartTag();
    const page = params(), original = page.CONTENT.millstone;
    window.SmartTag.create(page);
    await created.API.VIDEO.load({ CONTENT: {} });
    expect(created.params.CONTENT.millstone.daiParams.daiCmsId).toBe('111');
    setConfig(auto);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'PQI_CONFIG', payload: auto }, source: window }));
    expect(created.params.CONTENT.millstone).toBe(original);
    setConfig(forceMax);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'PQI_CONFIG', payload: forceMax }, source: window }));
    expect(created.params.CONTENT.millstone.daiParams.daiCmsId).toBe('111');
  });

  const reloadRequests = spy => spy.mock.calls.map(([data]) => data).filter(data => data?.type === 'PQI_STARTUP_RELOAD');
  const choose = config => {
    setConfig(config);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'PQI_CONFIG', payload: config }, source: window }));
  };

  test('a selection that needs a different stream asks for one reload with the position staged', async () => {
    const stagePosition = jest.fn(), post = jest.spyOn(window, 'postMessage');
    installStartupSource({ sourcePreference: true, storage: sessionStore(), hevcProbe: Promise.resolve(false), stagePosition });
    window.SmartTag = makeSmartTag();
    window.SmartTag.create(params());
    choose({ forcedHeight: 720 });
    expect(reloadRequests(post)).toHaveLength(0);
    await created.API.VIDEO.load({ CONTENT: {} });
    // Another HD pick plays on the same declared source.
    choose({ forcedHeight: 1080 });
    expect(reloadRequests(post)).toHaveLength(0);
    choose(auto);
    expect(stagePosition).toHaveBeenCalledTimes(1);
    expect(reloadRequests(post)).toEqual([{ type: 'PQI_STARTUP_RELOAD', payload: { config: expect.objectContaining({ forceMax: false, forcedHeight: null }) } }]);
    expect(checkpoints().at(-1)).toMatchObject({ outcome: 'reload', reason: 'selection-changed' });
    choose(forceMax);
    expect(reloadRequests(post)).toHaveLength(1);
    post.mockRestore();
  });

  test('a stream started on Auto reloads when Force Max would unlock HEVC, in both load styles', async () => {
    for (const viaCreate of [true, false]) {
      setConfig(auto);
      const stagePosition = jest.fn(() => { throw new Error('unavailable'); }), post = jest.spyOn(window, 'postMessage');
      installStartupSource({ sourcePreference: false, storage: sessionStore(), hevcProbe: Promise.resolve(true), stagePosition });
      await Promise.resolve(); await Promise.resolve();
      window.SmartTag = makeSmartTag();
      if (viaCreate) { window.SmartTag.create(params()); await created.API.VIDEO.load({ CONTENT: {} }); }
      else { const { tag } = await window.SmartTag.create({}); await tag.API.VIDEO.load(params()); }
      choose({ forcedHeight: 1080 });
      expect(reloadRequests(post)).toHaveLength(0);
      choose(forceMax);
      expect(reloadRequests(post)).toHaveLength(1);
      post.mockRestore();
      delete window.SmartTag;
    }
  });

  const master = ['#EXTM3U',
    '#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=12000000,BANDWIDTH=16280000,RESOLUTION=3840x2160,CODECS="dvh1.05.06,ec-3"', 'a.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=15000000,RESOLUTION=3840x2160,CODECS="hvc1.2.4.L150.90"', 'b.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=8460000,RESOLUTION=2560x1440,CODECS="hvc1.2.4.L150.90"', 'c.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=6400000,RESOLUTION=1920x1080,CODECS="hvc1.2.4.L120.90"', 'd.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=2560x1440,CODECS="avc1.640032"', 'e.m3u8'].join('\n');
  const bodyOf = text => {
    let sent = false;
    return { ok: true, headers: { get: () => null }, body: { getReader: () => ({
      read: async () => sent ? { done: true } : (sent = true, { done: false, value: new TextEncoder().encode(text) }),
      cancel: async () => {}, releaseLock: () => {} }) } };
  };
  const offered = spy => spy.mock.calls.map(([data]) => data).filter(data => data?.type === 'PQI_UNLOCKABLE_QUALITIES').map(data => data.payload.qualities);
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));

  test('reads only HEVC and Dolby Vision renditions above 1080p from either manifest format', () => {
    expect(readUhdQualities(master)).toEqual([{ height: 2160, bandwidth: 16280000 }, { height: 1440, bandwidth: 8460000 }]);
    expect(readUhdQualities(`<MPD><Period><AdaptationSet codecs="hvc1.2.4.L150.90"><Representation height="2160" bandwidth="15000000"/>
      <Representation height="1080" bandwidth="6000000"/></AdaptationSet><AdaptationSet><Representation height="1440" bandwidth="9" codecs="avc1.640032"/>
      </AdaptationSet></Period></MPD>`)).toEqual([{ height: 2160, bandwidth: 15000000 }]);
    expect(readUhdQualities('not a manifest')).toEqual([]);
  });

  test("an Auto stream offers the title's real 4K renditions from its unfiltered catalog, untouched itself", async () => {
    setConfig(auto);
    const post = jest.spyOn(window, 'postMessage');
    const fetchCatalog = jest.fn(async () => bodyOf(master));
    installStartupSource({ sourcePreference: false, storage: sessionStore(), hevcProbe: Promise.resolve(true), fetchCatalog });
    await Promise.resolve(); await Promise.resolve();
    window.SmartTag = makeSmartTag();
    window.SmartTag.create(params());
    await created.API.VIDEO.load({ CONTENT: {} });
    await settle();
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
    expect(fetchCatalog.mock.calls[0]).toEqual([catalogPath.replace('/v(hvc,hdr10,dvh)', ''), expect.objectContaining({ credentials: 'omit' })]);
    expect(offered(post).at(-1)).toEqual([{ height: 2160, bandwidth: 16280000 }, { height: 1440, bandwidth: 8460000 }]);
    expect(created.params.CONTENT.millstone.daiParams['dai-excl']).toBe(exclusions);
    expect(created.params.CONTENT.millstone.streamingUrl).toBe(catalogPath);
    post.mockRestore();
  });

  test('nothing is offered without HEVC support, on an unlocked stream, for a 1080p title or a failed read', async () => {
    const cases = [
      { hevc: false, config: auto, fetchCatalog: jest.fn(async () => bodyOf(master)), fetched: 0 },
      { hevc: true, config: forceMax, fetchCatalog: jest.fn(async () => bodyOf(master)), fetched: 0 },
      { hevc: true, config: auto, fetchCatalog: jest.fn(async () => bodyOf(master.split('\n').slice(7).join('\n'))), fetched: 1 },
      { hevc: true, config: auto, fetchCatalog: jest.fn(async () => ({ ok: false, status: 403 })), fetched: 1 },
      { hevc: true, config: auto, fetchCatalog: jest.fn(async () => { throw new Error('offline'); }), fetched: 1 }
    ];
    for (const item of cases) {
      setConfig(item.config);
      const post = jest.spyOn(window, 'postMessage');
      installStartupSource({ sourcePreference: false, storage: sessionStore(), hevcProbe: Promise.resolve(item.hevc), fetchCatalog: item.fetchCatalog });
      await Promise.resolve(); await Promise.resolve();
      window.SmartTag = makeSmartTag();
      window.SmartTag.create(params());
      await created.API.VIDEO.load({ CONTENT: {} });
      await settle();
      expect(item.fetchCatalog).toHaveBeenCalledTimes(item.fetched);
      expect(offered(post).flat()).toEqual([]);
      post.mockRestore();
      delete window.SmartTag;
    }
  });

  test('a read-only Smart Tag or a failing adjustment never breaks the page', async () => {
    installStartupSource({ sourcePreference: true, storage: sessionStore(), hevcProbe: Promise.resolve(false) });
    const frozenLoad = jest.fn(async () => 'loaded');
    const frozenTag = { model: { TagConstants: { ADOPS_ID: { CMSID: '111' } } },
      API: Object.create({ get VIDEO() { return Object.freeze({ load: frozenLoad }); } }) };
    const frozen = Object.freeze({ list: [frozenTag], create: jest.fn(() => 'created') });
    expect(() => { window.SmartTag = frozen; }).not.toThrow();
    expect(window.SmartTag.create({})).toBe('created');
    await expect(frozenTag.API.VIDEO.load(params())).resolves.toBe('loaded');

    // A tag whose model throws on access still receives the page's own params.
    window.SmartTag = makeSmartTag();
    const { tag } = await window.SmartTag.create({});
    Object.defineProperty(tag, 'params', { get() { throw new Error('unavailable'); } });
    const page = { CONTENT: { autoplay: true } };
    await tag.API.VIDEO.load(page);
    expect(load).toHaveBeenLastCalledWith(page);
  });

  test('the startup watcher stops after its window even if playback never starts', async () => {
    jest.useFakeTimers();
    installStartupSource({ sourcePreference: true, storage: sessionStore(), hevcProbe: Promise.resolve(false) });
    window.SmartTag = makeSmartTag();
    const { tag } = await window.SmartTag.create({});
    await tag.API.VIDEO.load(params());
    expect(created.handlers.has('TagEvent.ON_FATAL_ERROR')).toBe(true);
    await jest.advanceTimersByTimeAsync(121000);
    expect(created.handlers.has('TagEvent.ON_FATAL_ERROR')).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });
});
