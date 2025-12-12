import { estimateResolutionFromBitrate } from './constants.js';
import { setRepresentations } from './state.js';

// Parse HLS or DASH manifests, normalize the discovered representations, and
// broadcast them to the extension UI via postMessage for display/selection.
export function parseHlsManifest(content) {
  try {
    const lines = content.split('\n');
    const qualities = [];
    let variantIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const attrs = line.substring('#EXT-X-STREAM-INF:'.length);

        let bandwidth = null;
        let resolution = null;
        let codecs = null;
        let width = null;
        let height = null;

        const bwMatch = attrs.match(/BANDWIDTH=(\d+)/);
        if (bwMatch) bandwidth = parseInt(bwMatch[1], 10);

        const resMatch = attrs.match(/RESOLUTION=(\d+)x(\d+)/);
        if (resMatch) {
          width = parseInt(resMatch[1], 10);
          height = parseInt(resMatch[2], 10);
          resolution = `${height}p`;
        }

        const codecsMatch = attrs.match(/CODECS="([^"]+)"/);
        if (codecsMatch) codecs = codecsMatch[1];

        let variantUrl = null;
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j].trim();
          if (nextLine && !nextLine.startsWith('#')) {
            variantUrl = nextLine;
            break;
          }
        }

        if (height || bandwidth) {
          if (!height && bandwidth) {
            const estimatedRes = estimateResolutionFromBitrate(bandwidth / 1000);
            height = parseInt(estimatedRes);
            resolution = estimatedRes;
          }

          let hlsTier = null;
          if (variantUrl) {
            const tierMatch = variantUrl.match(/manifest_video_(\d+)[_\/]/) ||
              variantUrl.match(/video[_\/](\d+)[_\/]/);
            if (tierMatch) {
              hlsTier = tierMatch[1];
            }
          }

          qualities.push({
            id: `hls_${variantIndex}`,
            bandwidth,
            width,
            height,
            resolution,
            codecs,
            variantUrl,
            hlsTier,
            isHls: true
          });
          variantIndex++;
        }
      }
    }

    // Deduplicate by height keeping the highest bandwidth variant for each
    // resolution to present a clean list of available qualities.
    const byHeight = new Map();
    for (const q of qualities) {
      if (q.height) {
        const existing = byHeight.get(q.height);
        if (!existing || (q.bandwidth > existing.bandwidth)) {
          byHeight.set(q.height, q);
        }
      }
    }
    let unique = Array.from(byHeight.values());

    unique.sort((a, b) => (b.height || 0) - (a.height || 0));

    if (unique.length > 0) {
      setRepresentations(unique);
      window.postMessage({
        type: 'PQI_MANIFEST_DATA',
        payload: unique
      }, '*');
    }
  } catch (e) {
    console.error('[PQI] Error parsing HLS manifest:', e);
  }
}

export function parseDashManifest(xmlString) {
  try {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, 'text/xml');

    const representations = xmlDoc.getElementsByTagName('Representation');
    const qualities = [];

    function isVideoAdaptation(node) {
      const adaptSet = node.parentNode;
      if (!adaptSet || adaptSet.tagName !== 'AdaptationSet') return true;
      const mime = adaptSet.getAttribute('mimeType');
      const contentType = adaptSet.getAttribute('contentType');
      if (mime && !mime.includes('video')) return false;
      if (contentType && contentType !== 'video') return false;
      return true;
    }

    const adaptSets = xmlDoc.getElementsByTagName('AdaptationSet');
    let globalTemplate = null;
    if (adaptSets.length > 0) {
      for (let i = 0; i < adaptSets.length; i++) {
        const mime = adaptSets[i].getAttribute('mimeType');
        const contentType = adaptSets[i].getAttribute('contentType');
        if ((mime && mime.includes('video')) || (contentType && contentType === 'video')) {
          const tmpl = adaptSets[i].getElementsByTagName('SegmentTemplate')[0];
          if (tmpl) globalTemplate = tmpl.getAttribute('media');
          break;
        }
      }
    }

    for (let i = 0; i < representations.length; i++) {
      const rep = representations[i];

      if (!isVideoAdaptation(rep)) continue;

      const w = rep.getAttribute('width');
      const h = rep.getAttribute('height');
      const bw = rep.getAttribute('bandwidth');
      const id = rep.getAttribute('id');
      const codecs = rep.getAttribute('codecs');

      const baseUrlNode = rep.getElementsByTagName('BaseURL')[0];
      const baseUrl = baseUrlNode ? baseUrlNode.textContent.trim() : null;

      const repTmplNode = rep.getElementsByTagName('SegmentTemplate')[0];
      const repTemplate = repTmplNode ? repTmplNode.getAttribute('media') : null;

      const finalTemplate = repTemplate || globalTemplate;

      let dashTier = null;
      const tierSource = baseUrl || finalTemplate || id;
      if (tierSource) {
        const tierMatch = tierSource.match(/_(\d{3,5})[\/\.]/);
        if (tierMatch) {
          dashTier = tierMatch[1];
        }
      }

      if (!dashTier && bw) {
        const bwKbps = Math.round(parseInt(bw) / 1000);
        const targetAvgBitrate = bwKbps / 1.3;
        const KNOWN_TIERS = [4500, 3000, 2100, 1500, 750, 380];

        const closest = KNOWN_TIERS.reduce((prev, curr) => {
          return (Math.abs(curr - targetAvgBitrate) < Math.abs(prev - targetAvgBitrate) ? curr : prev);
        });

        if (Math.abs(closest - targetAvgBitrate) / targetAvgBitrate < 0.4) {
          dashTier = closest.toString();
        }
      }

      if (h) {
        qualities.push({
          id,
          baseUrl,
          template: finalTemplate,
          dashTier,
          width: parseInt(w),
          height: parseInt(h),
          bandwidth: parseInt(bw),
          codecs
        });
      }
    }

    // Some manifests repeat representations; keep only the first instance of
    // each ID and then dedupe on (height, bandwidth, id) to avoid clutter.
    const seenIds = new Set();
    let unique = qualities.filter(q => {
      if (q.id) {
        if (seenIds.has(q.id)) return false;
        seenIds.add(q.id);
        return true;
      }
      return true;
    });

    unique = unique.filter((v, i, a) => a.findIndex(t => (
      t.height === v.height &&
      t.bandwidth === v.bandwidth &&
      t.id === v.id
    )) === i);

    unique.sort((a, b) => b.height - a.height);

    setRepresentations(unique);

    if (unique.length > 0) {
      const displayQualities = unique.map(q => {
        if (q.dashTier) {
          const src = q.template || q.baseUrl || '';
          const hasResolutionInUrl = src.match(/_(\d{3,4}p)_/);

          if (hasResolutionInUrl) {
            return {
              ...q,
              bandwidth: parseInt(q.dashTier) * 1000
            };
          }

          return {
            ...q,
            bandwidth: parseInt(q.dashTier) * 1000,
            height: estimateResolutionFromBitrate(parseInt(q.dashTier)).replace('p', '')
          };
        }
        return q;
      });

      displayQualities.sort((a, b) => parseInt(b.height) - parseInt(a.height));

      window.postMessage({
        type: 'PQI_MANIFEST_DATA',
        payload: displayQualities
      }, '*');
    }
  } catch (e) {
    console.error('[PQI] Error parsing DASH manifest:', e);
  }
}

export function parseManifest(content) {
  const trimmed = content.trim();
  if (trimmed.startsWith('#EXTM3U')) {
    parseHlsManifest(content);
  } else if (trimmed.startsWith('<?xml') || trimmed.startsWith('<MPD')) {
    parseDashManifest(content);
  } else {
    console.log('[PQI] Unknown manifest format');
  }
}
