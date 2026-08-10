const DAI_VARIANT_PATTERN = /\/variant\/([^/]+)\/bandwidth\/(\d+)\.m3u8/i;

const EXCLUDED_PATH_MARKERS = [
  '/audio/', '_audio_', '_aac_', '/subtitles/', '/subtitle/', '.vtt',
  '/thumbnails/', '/thumbnail/', '/thumb', '.jpg', '.jpeg', '.png',
  '/measurements/', '/measurement/'
];

const AD_PATH_MARKERS = [
  'doubleclick', 'googlevideo', '/video_ads/', '/ads/', '/ad/', '_ads_', '_ad_',
  '/dai/', '_dai_', 'dclk'
];

export function isAdReference(value) {
  const lower = String(value || '').toLowerCase();
  return AD_PATH_MARKERS.some(marker => lower.includes(marker));
}

export function isExcludedReference(value) {
  const lower = String(value || '').toLowerCase();
  return EXCLUDED_PATH_MARKERS.some(marker => lower.includes(marker));
}

export function toUrl(value, base = window.location.origin) {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

export function parseCmcd(url) {
  const urlObj = url instanceof URL ? url : toUrl(url);
  const raw = urlObj?.searchParams.get('CMCD');
  if (!raw) return {};

  return Object.fromEntries(raw.split(',').map(pair => {
    const separator = pair.indexOf('=');
    return separator === -1
      ? [pair, true]
      : [pair.slice(0, separator), pair.slice(separator + 1).replace(/^"|"$/g, '')];
  }));
}

export function classifyMediaRequest(url) {
  const urlObj = url instanceof URL ? url : toUrl(url);
  if (!urlObj) return { kind: 'unknown', excluded: true, isAd: false, url: null };

  const lower = urlObj.toString().toLowerCase();
  const cmcd = parseCmcd(urlObj);
  const isAudio = cmcd.ot === 'a' || isExcludedReference(lower);
  const isDaiPlaylist = DAI_VARIANT_PATTERN.test(urlObj.pathname);
  const isAd = !isDaiPlaylist && isAdReference(lower);
  const isManifest = /\.(?:mpd|m3u8)(?:$|\?)/i.test(urlObj.toString());
  const isSegment = /\.(?:m4s|m4v|mp4|ts)(?:$|\?)/i.test(urlObj.toString());
  const filename = urlObj.pathname.slice(urlObj.pathname.lastIndexOf('/') + 1);
  const isInitialization = /(?:^|[_-])init(?:[_-][^.]*)?\.(?:m4s|m4v|mp4)$/i.test(filename);
  const isLive = cmcd.st === 'l' ||
    /\/out\/v1\/|\/linear\/hls\/pa\/event\//i.test(urlObj.pathname);

  return {
    url: urlObj,
    cmcd,
    kind: isManifest ? 'manifest' : (isSegment ? 'segment' : 'unknown'),
    excluded: isAudio || isAd,
    isAd,
    isAudio,
    isInitialization,
    isLive,
    isDaiPlaylist
  };
}

export function deriveStreamKey(url, family = 'unknown') {
  const urlObj = url instanceof URL ? url : toUrl(url);
  if (!urlObj) return null;

  const path = urlObj.pathname;
  const dai = path.match(/\/event\/([^/]+)\/stream\/([^/]+)/i);
  if (dai) return `${urlObj.origin}/event/${dai[1]}/stream/${dai[2]}`;

  const liveDash = path.match(/\/out\/v1\/([^/]+)/i);
  if (liveDash) return `${urlObj.origin}/out/v1/${liveDash[1]}`;

  const contentId = path.match(/\/vid\/([^/]+)/i);
  if (contentId) return `${urlObj.origin}/vid/${contentId[1]}`;

  const vodRoot = path.match(/^(.*?_cenc_precon_dash)\//i);
  if (vodRoot) return `${urlObj.origin}${vodRoot[1]}`;

  const directory = path.slice(0, Math.max(0, path.lastIndexOf('/')));
  return `${urlObj.origin}${directory}`;
}

export function resolveVariantUrl(variantUrl, manifestUrl) {
  if (!variantUrl) return null;
  return toUrl(variantUrl, manifestUrl || window.location.href)?.toString() || variantUrl;
}

export function getDeliveryFamily({ variantUrl, hlsTier, template, pathId, rawId } = {}) {
  if (variantUrl && DAI_VARIANT_PATTERN.test(variantUrl)) return 'google-dai-hls';
  if (variantUrl || hlsTier) return hlsTier ? 'tiered-hls' : 'hls';
  if (template || pathId || rawId) return 'dash';
  return 'unknown';
}

export function normalizeRepresentations(representations, context = {}) {
  return representations
    .map(rep => {
      const family = rep.family || getDeliveryFamily(rep);
      const streamKey = rep.streamKey || context.streamKey || deriveStreamKey(context.manifestUrl, family);
      return {
        ...rep,
        family,
        streamKey,
        mediaType: rep.mediaType || 'video',
        source: rep.source || 'manifest',
        request: rep.request || {
          variantUrl: rep.variantUrl || null,
          daiId: rep.daiId || null,
          hlsTier: rep.hlsTier || null,
          template: rep.template || null,
          baseUrl: rep.baseUrl || null,
          rawId: rep.rawId || null,
          pathId: rep.pathId || null,
          dashTier: rep.dashTier || null
        }
      };
    })
    .filter(rep => rep.mediaType === 'video')
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
}

export function selectRepresentation(representations, config) {
  if (!representations.length) return null;
  if (config.forcedId || config.forcedHeight) {
    const forcedHeight = parseInt(config.forcedHeight, 10);
    const exactId = representations.find(rep => rep.id === config.forcedId);
    if (exactId && (!Number.isFinite(forcedHeight) || exactId.height === forcedHeight)) return exactId;
    if (Number.isFinite(forcedHeight)) {
      return representations.find(rep => rep.height === forcedHeight) || null;
    }
    return null;
  }
  return config.forceMax ? representations[0] : null;
}

export function mergeRuntimeTelemetry(targetUrl, currentUrl) {
  const target = toUrl(targetUrl, currentUrl);
  const current = toUrl(currentUrl);
  if (!target || !current) return targetUrl;

  const cmcd = current.searchParams.get('CMCD');
  if (cmcd && !target.searchParams.has('CMCD')) target.searchParams.set('CMCD', cmcd);
  return target.toString();
}

export function getDaiVariantParts(url) {
  const urlObj = url instanceof URL ? url : toUrl(url);
  const match = urlObj?.pathname.match(DAI_VARIANT_PATTERN);
  return match ? { id: match[1], bandwidth: match[2] } : null;
}
