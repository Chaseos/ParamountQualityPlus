import { estimateResolutionFromBitrate } from './constants.js';
import { setRepresentations, getRepresentations } from './state.js';
import {
  deriveStreamKey,
  getDeliveryFamily,
  isAdReference,
  normalizeRepresentations,
  resolveVariantUrl
} from './stream-model.js';

// Parse HLS or DASH manifests, normalize the discovered representations, and
// broadcast them to the extension UI via postMessage for display/selection.
export function parseHlsManifest(content, requestUrl) {
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

          variantUrl = resolveVariantUrl(variantUrl, requestUrl);
          let hlsTier = null;
          let daiId = null;
          if (variantUrl) {
            const tierMatch = variantUrl.match(/manifest(?:_video)?_(\d+)(?:[_\/\.]|$)/) ||
              variantUrl.match(/video[_\/](\d+)[_\/]/);
            if (tierMatch) {
              hlsTier = tierMatch[1];
            }

            const daiMatch = variantUrl.match(/\/variant\/([^\/]+)\//);
            if (daiMatch) {
              daiId = daiMatch[1];
            }
          }

          const family = getDeliveryFamily({ variantUrl, hlsTier });
          qualities.push({
            id: `hls_${variantIndex}`,
            bandwidth,
            width,
            height,
            resolution,
            codecs,
            variantUrl,
            hlsTier,
            daiId,
            family,
            streamKey: deriveStreamKey(requestUrl || variantUrl, family),
            isHls: true,
            source: 'manifest'
          });
          variantIndex++;
        }
      }
    }

    // --- Google DAI Live Stats Inference ---
    // If this is a Media Playlist (no EXT-X-STREAM-INF tags found), it's likely
    // a variant playlist being polled by the player. We infer the active quality
    // by matching the DAI Variant ID in the request URL against our known qualities.
    if (qualities.length === 0 && requestUrl) {
      const availableRepresentations = getRepresentations();
      if (availableRepresentations.length > 0) {
        const match = availableRepresentations.find(r => r.daiId && requestUrl.includes(r.daiId));
        if (match) {
          window.postMessage({
            type: 'PQI_ACTIVE_QUALITY',
            payload: {
              resolution: match.height + 'p',
              bitrate: match.bandwidth ? Math.round(match.bandwidth / 1000) : null,
              daiId: match.daiId
            }
          }, '*');
        }
      }
      return;
    }

    // Deduplicate by height+hlsTier keeping the highest bandwidth variant for each
    // unique combination to present a clean list of available qualities.
    // For archived live streams, the same height may appear with different hlsTier values.
    const byKey = new Map();
    for (const q of qualities) {
      if (q.height) {
        // Use height+hlsTier as key to properly dedupe
        const key = `${q.height}_${q.hlsTier || 'none'}`;
        const existing = byKey.get(key);
        if (!existing || (q.bandwidth > existing.bandwidth)) {
          byKey.set(key, q);
        }
      }
    }

    // Now dedupe by height only, keeping highest bandwidth for display
    const byHeight = new Map();
    for (const q of byKey.values()) {
      const existing = byHeight.get(q.height);
      if (!existing || (q.bandwidth > existing.bandwidth)) {
        byHeight.set(q.height, q);
      }
    }
    let unique = normalizeRepresentations(Array.from(byHeight.values()), {
      manifestUrl: requestUrl,
      streamKey: deriveStreamKey(requestUrl, 'hls')
    });

    unique.sort((a, b) => (b.height || 0) - (a.height || 0));

    if (unique.length > 0) {
      setRepresentations(unique, {
        streamKey: unique[0].streamKey,
        family: unique[0].family,
        manifestUrl: requestUrl
      });
      window.postMessage({
        type: 'PQI_MANIFEST_DATA',
        payload: unique
      }, '*');
    }
  } catch (e) {
    console.error('[PQI] Error parsing HLS manifest:', e);
  }
}

export function parseDashManifest(xmlString, requestUrl) {
  try {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, 'text/xml');

    const representations = xmlDoc.getElementsByTagNameNS('*', 'Representation');
    const qualities = [];

    function getBandwidthKbps(bandwidth) {
      const parsed = parseInt(bandwidth, 10);
      if (!parsed) return null;
      return parsed >= 50000 ? parsed / 1000 : parsed;
    }

    function isPlausibleDashTier(tier, bandwidth) {
      const parsedTier = parseInt(tier, 10);
      const bandwidthKbps = getBandwidthKbps(bandwidth);
      if (!parsedTier) return false;
      if (!bandwidthKbps) return parsedTier <= 15000;

      const ratio = parsedTier / bandwidthKbps;
      return ratio >= 0.35 && ratio <= 2.5;
    }

    function isVideoAdaptation(node) {
      const adaptSet = node.parentNode;
      if (!adaptSet) return true;
      const ln = adaptSet.localName || adaptSet.tagName;
      if (ln !== 'AdaptationSet') return true;
      const mime = adaptSet.getAttribute('mimeType');
      const contentType = adaptSet.getAttribute('contentType');
      if (mime && !mime.includes('video')) return false;
      if (contentType && contentType !== 'video') return false;
      return true;
    }

    const adaptSets = xmlDoc.getElementsByTagNameNS('*', 'AdaptationSet');
    const videoAdaptSets = [];

    if (adaptSets.length > 0) {
      for (let i = 0; i < adaptSets.length; i++) {
        const mime = adaptSets[i].getAttribute('mimeType');
        const contentType = adaptSets[i].getAttribute('contentType');
        const isVideo = (mime && mime.toLowerCase().includes('video')) ||
          (contentType && contentType.toLowerCase().includes('video'));
        if (isVideo) {
          videoAdaptSets.push(adaptSets[i]);
        }
      }
    }

    for (const adaptSet of videoAdaptSets) {
      const adaptTmplNode = adaptSet.getElementsByTagNameNS('*', 'SegmentTemplate')[0];
      const adaptTemplate = adaptTmplNode ? adaptTmplNode.getAttribute('media') : null;

      const setRepresentations = adaptSet.getElementsByTagNameNS('*', 'Representation');
      for (let j = 0; j < setRepresentations.length; j++) {
        const rep = setRepresentations[j];

        const w = rep.getAttribute('width');
        const h = rep.getAttribute('height');
        const bw = rep.getAttribute('bandwidth');
        const rawId = rep.getAttribute('id');
        const setIndex = videoAdaptSets.indexOf(adaptSet);
        const id = `s${setIndex}-${rawId}`;

        const baseUrlNode = rep.getElementsByTagNameNS('*', 'BaseURL')[0];
        const baseUrl = baseUrlNode ? baseUrlNode.textContent.trim() : null;

        const repTmplNode = rep.getElementsByTagNameNS('*', 'SegmentTemplate')[0];
        const repTemplate = repTmplNode ? repTmplNode.getAttribute('media') : null;

        const finalTemplate = repTemplate || adaptTemplate;

        let dashTier = null;
        let pathId = rawId;

        // Representation names often contain unrelated production numbers (for
        // example, THE_36001_001). Only accept a bitrate tier from the terminal
        // representation-directory token, then sanity-check it against the MPD
        // bandwidth. Arbitrary numeric tokens must never become URL tiers.
        const sources = [baseUrl, rawId, finalTemplate].filter(s => s && s.length > 0);
        for (const src of sources) {
          if (src.includes('_')) {
            let cleanSrc = src;
            if (src.includes('$')) {
              const parts = src.split('/');
              if (parts.length > 1 && parts[parts.length - 1].includes('$')) cleanSrc = parts[parts.length - 2];
            }
            const chunks = cleanSrc.split('/').filter(c => c.length > 0 && c.includes('_'));
            if (chunks.length > 0) {
              const best = chunks[chunks.length - 1];
              const tierMatch = best.match(/_(\d{2,5})$/);
              if (tierMatch && isPlausibleDashTier(tierMatch[1], bw)) {
                dashTier = tierMatch[1];
              }

              if (best.includes('PPUSA') || best.split('_').length > 3) {
                pathId = best;
                break;
              } else if (pathId === rawId) {
                pathId = best;
              }
            }
          }
        }

        // Exact bitrate fallback
        if (!dashTier && bw) {
          dashTier = Math.round(getBandwidthKbps(bw)).toString();
        }

        if (h || bw) {
          let finalHeight = h ? parseInt(h) : 0;
          if (!finalHeight && bw) {
            const estimatedRes = estimateResolutionFromBitrate(parseInt(bw) / 1000);
            finalHeight = parseInt(estimatedRes.replace('p', ''));
          }

          const lowerId = (rawId || '').toLowerCase();
          const lowerPath = (pathId || '').toLowerCase();
          const lowerBase = (baseUrl || '').toLowerCase();
          const lowerTempl = (finalTemplate || '').toLowerCase();

          const isAd = [lowerBase, lowerId, lowerPath, lowerTempl].some(isAdReference);

          const hasContentMarker = !!(pathId && (
            pathId.includes('PPUSA') ||
            /feature|movie|show|uhd|hd|sdr|hdr|dolby|atmos|4k|1080|720|2ch|8ch|apple|amazon|c\d{2}|hvc1|avc1|cenc|dash|prod|ftr|vmaster|vtrack|eng|spa|fra|live|event|pplus|match|replay|efl|sport|league|en[-_]|es[-_]/i.test(pathId)
          ));

          const q = {
            id,
            rawId,
            pathId: (pathId && pathId !== rawId) ? pathId : null,
            baseUrl,
            template: finalTemplate,
            dashTier,
            width: w ? parseInt(w) : 0,
            height: finalHeight,
            bandwidth: parseInt(bw, 10),
            isContent: hasContentMarker && !isAd,
            family: 'dash',
            streamKey: deriveStreamKey(requestUrl, 'dash'),
            source: 'manifest'
          };

          qualities.push(q);
        }
      }
    }

    // Deduplication: Prioritize movie content (PPUSA) over Ads
    const byHeightMap = new Map();
    let hasAnyTrueContent = false;

    for (const q of qualities) {
      if (q.isContent) hasAnyTrueContent = true;

      const existing = byHeightMap.get(q.height);
      const isBetter = !existing ||
        (q.isContent && !existing.isContent) ||
        (q.pathId && !existing.pathId && q.bandwidth >= existing.bandwidth) ||
        (q.bandwidth > existing.bandwidth && q.isContent === existing.isContent);
      if (isBetter) byHeightMap.set(q.height, q);
    }

    let unique = Array.from(byHeightMap.values());

    // If we confidently found content, discard everything else (Ads, traps)
    if (hasAnyTrueContent) {
      unique = unique.filter(q => q.isContent);
    }

    unique = normalizeRepresentations(unique, {
      manifestUrl: requestUrl,
      streamKey: deriveStreamKey(requestUrl, 'dash')
    });

    if (unique.length > 0) {
      setRepresentations(unique, {
        streamKey: unique[0].streamKey,
        family: 'dash',
        manifestUrl: requestUrl
      });
      const displayQualities = unique.map(q => {
        const fallbackBandwidth = q.dashTier ? parseInt(q.dashTier, 10) * 1000 : null;
        return {
          ...q,
          // dashTier is a URL naming token and may be nominal. The MPD's
          // bandwidth attribute remains the authoritative display value.
          bandwidth: Number.isFinite(q.bandwidth) ? q.bandwidth : fallbackBandwidth,
          height: q.height || (q.dashTier
            ? parseInt(estimateResolutionFromBitrate(parseInt(q.dashTier, 10)), 10)
            : 0)
        };
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

export function parseManifest(content, requestUrl) {
  const trimmed = content.trim();
  if (trimmed.startsWith('#EXTM3U')) {
    parseHlsManifest(content, requestUrl);
  } else if (trimmed.startsWith('<?xml') || (trimmed.startsWith('<MPD') || trimmed.includes('<MPD'))) {
    parseDashManifest(content, requestUrl);
  } else {
    // Unknown format
  }
}
