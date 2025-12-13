// Shared constants for determining whether a URL points to a manifest or media
// segment and for translating bandwidth to an approximate resolution.
export const SEGMENT_EXTENSIONS = ['.m4s', '.mp4', '.ts'];
export const MANIFEST_EXTENSIONS = ['.mpd', '.m3u8'];
export const RESOLUTION_REGEX = /_(\d{3,4}p)_/;

// Rough heuristic mapping of bitrate ceilings (in kbps) to expected output
// resolution. Keeps the logic centralized so both DASH/HLS parsing and
// telemetry can agree on a quality label.
export const BITRATE_RESOLUTION_MAP = [
  { maxBitrate: 200, resolution: '234p' },
  { maxBitrate: 400, resolution: '270p' },
  { maxBitrate: 900, resolution: '360p' },
  { maxBitrate: 1700, resolution: '480p' },
  { maxBitrate: 2500, resolution: '540p' },
  { maxBitrate: 4200, resolution: '720p' },
  { maxBitrate: 6000, resolution: '1080p' },
  { maxBitrate: 12000, resolution: '1440p' },
  { maxBitrate: Infinity, resolution: '2160p' }
];

// Convert a bitrate in kbps to a coarse resolution bucket. Used to classify
// unknown variants when exact dimensions are missing from the URL or manifest.
export function estimateResolutionFromBitrate(bitrateKbps) {
  if (!bitrateKbps) return null;
  for (const tier of BITRATE_RESOLUTION_MAP) {
    if (bitrateKbps <= tier.maxBitrate) {
      return tier.resolution;
    }
  }
  return '2160p';
}
