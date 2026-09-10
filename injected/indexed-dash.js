import { getParamountPackaging, selectRepresentation } from './stream-model.js';

const children = (node, name) => Array.from(node?.children || [])
  .filter(child => child.localName === name);
const validRange = value => {
  if (!/^\d+-\d+$/.test(value || '')) return false;
  const [start, end] = value.split('-').map(Number);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end;
};

// Resolve only the unambiguous indexed subset. Do not reinterpret directory
// BaseURLs, templates, multiple CDN alternatives, or unsupported addressing.
export function getIndexedAddressing(rep, manifestUrl) {
  const ancestry = [];
  for (let node = rep; node?.nodeType === 1; node = node.parentNode) ancestry.unshift(node);
  let mediaUrl = manifestUrl;
  let indexRange = null;
  let initialization = null;
  let timescale = null;
  let presentationTimeOffset = null;
  const protection = [];
  try {
    for (const node of ancestry) {
      const bases = children(node, 'BaseURL');
      if (bases.length > 1 || children(node, 'SegmentTemplate').length || children(node, 'SegmentList').length) return null;
      if (bases.length) mediaUrl = new URL(bases[0].textContent.trim(), mediaUrl).href;
      const segments = children(node, 'SegmentBase');
      if (segments.length > 1) return null;
      const segment = segments[0];
      if (segment) {
        if (children(segment, 'RepresentationIndex').length) return null;
        indexRange = segment.getAttribute('indexRange') || indexRange;
        timescale = segment.getAttribute('timescale') || timescale;
        presentationTimeOffset = segment.getAttribute('presentationTimeOffset') || presentationTimeOffset;
        const init = children(segment, 'Initialization');
        if (init.length > 1) return null;
        if (init.length) initialization = {
          range: init[0].getAttribute('range'),
          sourceURL: init[0].getAttribute('sourceURL') || null
        };
      }
      for (const item of children(node, 'ContentProtection')) protection.push({
        schemeIdUri: item.getAttribute('schemeIdUri'),
        value: item.getAttribute('value'),
        defaultKID: item.getAttributeNS('urn:mpeg:cenc:2013', 'default_KID')
      });
    }
    const url = new URL(mediaUrl);
    if (url.protocol !== 'https:' || url.username || url.password ||
        getParamountPackaging(url) !== 'single-file' || !/\.mp4$/i.test(url.pathname) ||
        !validRange(indexRange) || !validRange(initialization?.range)) return null;
    if (initialization.sourceURL && new URL(initialization.sourceURL, mediaUrl).href !== mediaUrl) return null;
    return { type: 'single-file-indexed', mediaUrl, indexRange, initializationRange: initialization.range,
      timescale, presentationTimeOffset, protection };
  } catch { return null; }
}

// Work on a private XML document; the original ladder and all original byte
// ranges remain authoritative. Ineligible documents are returned byte-for-byte.
export function filterIndexedDash(text, manifestUrl, representations, config) {
  const unchanged = reason => ({ text, supported: false, selectedHeight: null, reason, mediaUrls: [] });
  if (text.length > 2 * 1024 * 1024) return unchanged('manifest-too-large');
  if (!text.includes('MPD')) return unchanged('not-dash');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const root = doc.documentElement;
  if (root?.localName !== 'MPD' || doc.getElementsByTagName('parsererror').length ||
      root.getAttribute('type') === 'dynamic' || text.includes('<!DOCTYPE')) return unchanged('unsupported-document');
  const variants = representations.flatMap(rep => rep.variants?.length ? rep.variants : [rep]);
  const nodes = Array.from(doc.getElementsByTagNameNS('*', 'Representation'));
  if (representations.some(rep => !rep.indexedManifestEligible)) return unchanged('mixed-program-addressing');
  if (!variants.length || variants.some(rep => !rep.addressing || !nodes[rep.manifestNodeIndex])) return unchanged('unsupported-addressing');
  // Bind the parsed ladder to this exact response, never to a previous title.
  if (variants.some(rep => {
    const node = nodes[rep.manifestNodeIndex];
    const addressing = getIndexedAddressing(node, manifestUrl);
    return node.getAttribute('id') !== rep.rawId || !addressing || addressing.mediaUrl !== rep.addressing.mediaUrl;
  })) return unchanged('ladder-mismatch');

  const target = selectRepresentation(representations, config);
  const active = Boolean(config.forceMax || config.forcedId || config.forcedHeight);
  const supported = { text, supported: true, selectedHeight: null, mediaUrls: [], reason: 'auto' };
  if (!active) return supported;
  if (!target) return { ...supported, reason: 'target-unavailable' };
  const periods = new Set(variants.map(rep => rep.periodKey));
  const selected = variants.filter(rep => rep.height === target.height);
  if (Array.from(periods).some(period => !selected.some(rep => rep.periodKey === period))) {
    return { ...supported, reason: 'target-missing-in-period' };
  }
  const keep = new Set(selected.map(rep => rep.manifestNodeIndex));
  for (const rep of variants) {
    if (keep.has(rep.manifestNodeIndex)) continue;
    const node = nodes[rep.manifestNodeIndex];
    const parent = node.parentNode;
    node.remove();
    if (parent.localName === 'AdaptationSet' && !children(parent, 'Representation').length) parent.remove();
  }
  return { text: new XMLSerializer().serializeToString(doc), supported: true,
    selectedHeight: target.height, reason: 'selected', mediaUrls: selected.map(rep => rep.addressing.mediaUrl) };
}
