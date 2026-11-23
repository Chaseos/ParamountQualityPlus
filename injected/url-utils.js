import { MANIFEST_EXTENSIONS, RESOLUTION_REGEX, SEGMENT_EXTENSIONS } from './constants.js';

// Small helpers to classify streaming URLs and extract resolution hints from
// path segments so analysis and rewrite logic can stay focused on decisions.
// The extension must end the path. A match anywhere in the URL would also
// claim unrelated requests, such as a beacon that names a segment in its query.
const hasPathExtension = (url, extensions) => {
  if (!url) return false;
  const path = String(url).split(/[?#]/, 1)[0].toLowerCase();
  return extensions.some(ext => path.endsWith(ext));
};

export function isSegmentUrl(url) {
  return hasPathExtension(url, SEGMENT_EXTENSIONS);
}

export function isManifestUrl(url) {
  return hasPathExtension(url, MANIFEST_EXTENSIONS);
}

export function extractResolutionFromPath(pathname) {
  const resMatch = pathname.match(RESOLUTION_REGEX);
  return resMatch ? resMatch[1] : null;
}
