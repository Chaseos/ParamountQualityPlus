import { MANIFEST_EXTENSIONS, RESOLUTION_REGEX, SEGMENT_EXTENSIONS } from './constants.js';

// Small helpers to classify streaming URLs and extract resolution hints from
// path segments so analysis and rewrite logic can stay focused on decisions.
export function isSegmentUrl(url) {
  if (!url) return false;
  return SEGMENT_EXTENSIONS.some(ext => url.includes(ext));
}

export function isManifestUrl(url) {
  if (!url) return false;
  return MANIFEST_EXTENSIONS.some(ext => url.includes(ext));
}

export function extractResolutionFromPath(pathname) {
  const resMatch = pathname.match(RESOLUTION_REGEX);
  return resMatch ? resMatch[1] : null;
}
