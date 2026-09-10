import { readDashRepresentations } from './manifest-parser.js';
import { classifyMediaRequest, getParamountPackaging, mergeRuntimeTelemetry, selectRepresentation } from './stream-model.js';

const children = (node, name) => Array.from(node?.children || []).filter(child => child.localName === name);
const integer = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : NaN;
};

export function getPackageManifestCandidate(value) {
  const request = classifyMediaRequest(value);
  const url = request.url;
  const packaging = getParamountPackaging(url);
  if (!url || url.protocol !== 'https:' || url.username || url.password || !packaging || request.excluded ||
      request.isLive || request.isInitialization || request.kind !== 'segment' ||
      (request.cmcd.ot && request.cmcd.ot !== 'v')) return null;
  // A package name is sufficient to locate its MPD, but not to establish that
  // an arbitrary audio/init MP4 is a successful program-video observation.
  if (packaging === 'single-file' && !/_[0-9]{3,4}p_[^/]+\.mp4$/i.test(url.pathname)) return null;
  if (packaging === 'segmented' && (!/\/seg_\d+\.m4s$/i.test(url.pathname) ||
      (request.cmcd.ot !== 'v' && !/_\d{3,4}p_[^/]+\/seg_/i.test(url.pathname)))) return null;
  const roots = [...url.pathname.matchAll(/\/[^/]+_cenc_(?:precon|fmp4)_dash\//ig)];
  if (roots.length !== 1) return null;
  const root = roots[0];
  const packageUrl = url.origin + url.pathname.slice(0, root.index + root[0].length);
  return { packageUrl, manifestUrl: packageUrl + 'stream.mpd', packaging };
}

function fingerprint(node) {
  return [node.namespaceURI, node.localName,
    Array.from(node.attributes).map(a => [a.namespaceURI, a.localName, a.value]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    Array.from(node.children).map(fingerprint), node.children.length ? '' : node.textContent.trim()];
}

function describeTemplate(rep, manifestUrl, packageUrl) {
  const ancestry = [];
  for (let node = rep; node?.nodeType === 1; node = node.parentNode) ancestry.unshift(node);
  let base = manifestUrl;
  const attrs = {};
  const media = {};
  const protection = [];
  let hasKeyIdentity = false;
  let timeline = null;
  for (const node of ancestry) {
    const bases = children(node, 'BaseURL');
    const templates = children(node, 'SegmentTemplate');
    if (bases.length > 1 || templates.length > 1 || children(node, 'SegmentBase').length || children(node, 'SegmentList').length) return null;
    if (bases.length) base = new URL(bases[0].textContent.trim(), base).href;
    for (const name of ['codecs', 'mimeType', 'frameRate', 'sar']) if (node.hasAttribute(name)) media[name] = node.getAttribute(name);
    const protections = children(node, 'ContentProtection');
    protection.push(...protections.map(fingerprint));
    hasKeyIdentity ||= protections.some(item => item.getAttribute('schemeIdUri') === 'urn:mpeg:dash:mp4protection:2011' &&
      Boolean(item.getAttributeNS('urn:mpeg:cenc:2013', 'default_KID')));
    if (templates.length) {
      for (const attr of templates[0].attributes) attrs[attr.name] = attr.value;
      const timelines = children(templates[0], 'SegmentTimeline');
      if (timelines.length > 1) return null;
      if (timelines.length) timeline = timelines[0];
    }
  }
  if (!timeline || !hasKeyIdentity || !media.codecs || media.mimeType !== 'video/mp4' || !attrs.initialization || !attrs.media) return null;
  const materialize = value => new URL(value.replace(/\$RepresentationID\$/g, rep.getAttribute('id'))
    .replace(/\$Bandwidth\$/g, rep.getAttribute('bandwidth')), base).href;
  const template = materialize(attrs.media);
  const initialization = materialize(attrs.initialization);
  // Support the already-used numbered segment structure, not arbitrary DASH
  // addressing. Encoding a template must not silently change its meaning.
  if (!template.startsWith(packageUrl) || !initialization.startsWith(packageUrl) ||
      !/\/seg_\$Number\$\.m4s$/.test(template) || !/\/init\.(?:m4s|m4v|mp4)$/.test(initialization) ||
      /\$/.test(initialization) || template.split('$').length !== 3 ||
      template.slice(0, template.lastIndexOf('/')) !== initialization.slice(0, initialization.lastIndexOf('/'))) return null;
  const startNumber = integer(attrs.startNumber, 1);
  const timescale = integer(attrs.timescale, 1);
  const offset = integer(attrs.presentationTimeOffset, 0);
  if (!(startNumber >= 0) || !(timescale > 0) || !Number.isFinite(offset)) return null;
  let number = startNumber;
  let time = 0;
  const runs = [];
  for (const entry of children(timeline, 'S')) {
    const start = integer(entry.getAttribute('t'), time);
    const duration = integer(entry.getAttribute('d'), NaN);
    const count = integer(entry.getAttribute('r'), 0) + 1;
    if (!(duration > 0) || !(count > 0) || !(start >= time) ||
        !Number.isSafeInteger(start + duration * count) || !Number.isSafeInteger(number + count)) return null;
    runs.push({ number, count, start, duration });
    number += count;
    time = start + duration * count;
  }
  if (!runs.length) return null;
  return { template, initialization, startNumber, endNumber: number - 1,
    compatibility: JSON.stringify({ media, protection, timescale, offset, runs,
      initializationFile: initialization.slice(initialization.lastIndexOf('/') + 1) }) };
}

export function readPackageManifest(text, candidate, observedUrl) {
  if (text.includes('<!DOCTYPE')) return null;
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.documentElement?.localName !== 'MPD' || doc.querySelector('parsererror') ||
      doc.documentElement.getAttribute('type') !== 'static') return null;
  const ladder = readDashRepresentations(text, candidate.manifestUrl);
  const variants = ladder.flatMap(rep => rep.variants?.length ? rep.variants : [rep]);
  if (!variants.length) return null;
  if (candidate.packaging === 'single-file') {
    const observed = new URL(observedUrl, candidate.packageUrl);
    const matches = variants.filter(rep => rep.addressing && new URL(rep.addressing.mediaUrl).origin === observed.origin &&
      new URL(rep.addressing.mediaUrl).pathname === observed.pathname);
    return matches.length === 1 && ladder.every(rep => rep.indexedManifestEligible)
      ? { ...candidate, source: 'package-manifest', variants: [], diagnosticOnly: true } : null;
  }
  const nodes = Array.from(doc.getElementsByTagNameNS('*', 'Representation'));
  const periods = Array.from(doc.getElementsByTagNameNS('*', 'Period'));
  const described = variants.map(rep => {
    const node = nodes[rep.manifestNodeIndex];
    let period = node;
    while (period && period.localName !== 'Period') period = period.parentElement;
    return { ...rep, source: 'package-manifest', packagePeriodIndex: periods.indexOf(period),
      packageAddressing: describeTemplate(node, candidate.manifestUrl, candidate.packageUrl) };
  });
  const result = { ...candidate, source: 'package-manifest', variants: described };
  return matchPackageSource(result, observedUrl) ? result : null;
}

function matchPackageSource(manifest, value) {
  const request = classifyMediaRequest(value);
  if (request.excluded || request.isLive || request.isInitialization) return null;
  const url = request.url;
  const number = Number(url?.pathname.match(/\/seg_(\d+)\.m4s$/)?.[1]);
  if (!Number.isSafeInteger(number)) return null;
  const matches = manifest.variants.filter(rep => {
    const a = rep.packageAddressing;
    if (!a || number < a.startNumber || number > a.endNumber) return false;
    const declared = new URL(a.template.replace('$Number$', String(number)));
    return declared.origin === url.origin && declared.pathname === url.pathname;
  });
  return matches.length === 1 ? { source: matches[0], number } : null;
}

export function selectPackageTarget(manifest, url, config, authoritativeRepresentations) {
  if (manifest.diagnosticOnly) return null;
  const matched = matchPackageSource(manifest, url);
  if (!matched) return null;
  const { source, number } = matched;
  const compatible = manifest.variants.filter(rep => rep.packagePeriodIndex === source.packagePeriodIndex && rep.packageAddressing &&
    rep.packageAddressing.compatibility === source.packageAddressing.compatibility);
  const requested = selectRepresentation(authoritativeRepresentations, config);
  const height = Number(config.forcedHeight) || requested?.height;
  if ((config.forcedId || config.forcedHeight) && !height) return null;
  const candidates = compatible.filter(rep => height ? rep.height === height : config.forceMax)
    .sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  const target = candidates[0];
  if (!target || target.height === source.height) return null;
  return { target, url: mergeRuntimeTelemetry(target.packageAddressing.template.replace('$Number$', String(number)), url) };
}
