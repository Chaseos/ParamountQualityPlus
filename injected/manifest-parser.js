import { estimateResolutionFromBitrate } from './constants.js';
import { getConfig, setRepresentations, getRepresentations } from './state.js';
import {
  classifyMediaRequest,
  deriveStreamKey,
  getDeliveryFamily,
  getHlsTier,
  isAdReference,
  normalizeRepresentations,
  resolveVariantUrl,
  selectRepresentation
} from './stream-model.js';
import { recordPlaybackCheckpoint } from './diagnostics.js';

function getVideoCodecFamily(codecs) {
  const value = String(codecs || '').toLowerCase();
  if (/\b(?:avc1|avc3)\b/.test(value)) return 'avc';
  if (/\b(?:hev1|hvc1)\b/.test(value)) return 'hevc';
  if (/\b(?:dvhe|dvh1)\b/.test(value)) return 'dolby-vision';
  if (/\bav01\b/.test(value)) return 'av1';
  if (/\bvp0?9\b/.test(value)) return 'vp9';
  return value || 'unknown';
}

function withoutVariants(representation) {
  const { variants, ...displayRepresentation } = representation;
  return displayRepresentation;
}

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

        const audioGroup = attrs.match(/(?:^|,)AUDIO="([^"]+)"/)?.[1] || null;
        const videoRange = attrs.match(/(?:^|,)VIDEO-RANGE=([^,]+)/)?.[1]?.trim() || null;

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
            hlsTier = getHlsTier(variantUrl);

            const daiMatch = variantUrl.match(/\/variant\/([^\/]+)\//);
            if (daiMatch) {
              daiId = daiMatch[1];
            }
          }

          const family = getDeliveryFamily({ variantUrl, hlsTier });
          const request = classifyMediaRequest(variantUrl);
          qualities.push({
            id: `hls_${variantIndex}`,
            bandwidth,
            width,
            height,
            resolution,
            codecs,
            audioGroup,
            videoRange,
            variantUrl,
            hlsTier,
            daiId,
            family,
            streamKey: deriveStreamKey(requestUrl || variantUrl, family),
            compatibilityKey: `hls:${getVideoCodecFamily(codecs)}:${audioGroup || 'default'}:${videoRange || 'default'}`,
            isAd: request.isAd,
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
        const selected = selectRepresentation(availableRepresentations, getConfig());
        // Media playlists can arrive out of order while a live selection is
        // changing. Do not let a late playlist from the old variant overwrite
        // the selected rendition in the popup.
        const matchesSelection = !selected || selected.height === match?.height ||
          selected.variants?.some(variant => variant.daiId === match?.daiId);
        if (match && matchesSelection) {
          window.postMessage({
            type: 'PQI_ACTIVE_QUALITY',
            payload: {
              resolution: match.height + 'p',
              bitrate: match.bandwidth ? Math.round(match.bandwidth / 1000) : null,
              daiId: match.daiId,
              streamKey: match.streamKey || null
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
        const key = `${q.height}_${q.hlsTier || 'none'}_${q.compatibilityKey}`;
        const existing = byKey.get(key);
        if (!existing || (q.bandwidth > existing.bandwidth)) {
          byKey.set(key, q);
        }
      }
    }

    // Keep one display row per height while retaining codec/audio alternatives
    // for request-time selection. A player request must stay within the same
    // compatibility family instead of blindly taking the highest bitrate.
    const byHeight = new Map();
    for (const q of byKey.values()) {
      if (q.isAd) continue;
      const variants = byHeight.get(q.height) || [];
      variants.push(q);
      byHeight.set(q.height, variants);
    }
    let unique = normalizeRepresentations(Array.from(byHeight.values()).map(variants => {
      const preferred = variants.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
      return { ...preferred, variants };
    }), {
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
      recordPlaybackCheckpoint('ladder_ready', {
        family: unique[0].family,
        streamKey: unique[0].streamKey || null,
        representationCount: unique.length,
        maxHeight: unique[0].height || null
      });
      window.postMessage({
        type: 'PQI_MANIFEST_DATA',
        payload: unique.map(withoutVariants)
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

    function getDirectChild(node, localName) {
      if (node?.children) {
        return Array.from(node.children).find(child =>
          (child.localName || child.tagName)?.split(':').pop() === localName
        ) || null;
      }
      // The test DOM shim does not expose children. Its descendant lookup is
      // an adequate fallback for the simple fixtures used there.
      return node?.getElementsByTagNameNS?.('*', localName)?.[0] || null;
    }

    function getAncestor(node, localName) {
      let current = node?.parentNode || null;
      while (current) {
        if ((current.localName || current.tagName)?.split(':').pop() === localName) return current;
        current = current.parentNode;
      }
      return null;
    }

    function getDirectBaseUrl(node) {
      // Do not use the descendant fallback here: an AdaptationSet may contain
      // representation-level BaseURLs for both content and ads.
      if (!node?.children) return '';
      return getDirectChild(node, 'BaseURL')?.textContent || '';
    }

    function isAdPeriod(period) {
      if (!period) return false;
      const id = period.getAttribute('id') || '';
      const baseUrl = getDirectBaseUrl(period);
      return /(?:^|[-_])(?:pre|mid|post)[-_]?roll(?:[-_]|$)|(?:^|[-_])ad(?:vertisement)?(?:[-_]|$)/i.test(id) ||
        isAdReference(baseUrl);
    }

    function isPreviewAdaptation(adaptSet) {
      const id = adaptSet.getAttribute('id') || '';
      if (/(?:^|[-_])(?:thumbnail|thumb|trick(?:mode|play)?)(?:[-_]|$)/i.test(id)) return true;

      for (const tagName of ['EssentialProperty', 'SupplementalProperty', 'Role']) {
        const nodes = adaptSet.getElementsByTagNameNS('*', tagName);
        for (let index = 0; index < nodes.length; index++) {
          const scheme = (nodes[index].getAttribute('schemeIdUri') || '').toLowerCase();
          const value = (nodes[index].getAttribute('value') || '').toLowerCase();
          if (scheme.includes('dashif.org/guidelines/trickmode') ||
              scheme.includes('dashif.org/guidelines/thumbnail_tile') ||
              /^(?:thumbnail|thumb|trick(?:mode|play)?)$/.test(value)) return true;
        }
      }
      return false;
    }

    function hasNonVideoMediaType(mime, contentType) {
      return mime.includes('audio') || mime.includes('image') || mime.includes('text') ||
        contentType.includes('audio') || contentType.includes('image') || contentType.includes('text');
    }

    function representationHasVideo(rep, adaptSet) {
      const mime = (rep.getAttribute('mimeType') || adaptSet.getAttribute('mimeType') || '').toLowerCase();
      const contentType = (rep.getAttribute('contentType') || adaptSet.getAttribute('contentType') || '').toLowerCase();
      if (hasNonVideoMediaType(mime, contentType) || isPreviewAdaptation(rep)) return false;

      const codecs = (rep.getAttribute('codecs') || adaptSet.getAttribute('codecs') || '').toLowerCase();
      return mime.includes('video') || contentType.includes('video') ||
        Boolean(rep.getAttribute('height') || rep.getAttribute('width')) ||
        /(?:avc|hvc|hev|vp0?9|av01)/.test(codecs);
    }

    function adaptationHasVideo(adaptSet) {
      const mime = (adaptSet.getAttribute('mimeType') || '').toLowerCase();
      const contentType = (adaptSet.getAttribute('contentType') || '').toLowerCase();
      // Width and height also describe thumbnail sprite sheets, so explicit
      // media type and preview signaling must win over the dimension fallback.
      if (isPreviewAdaptation(adaptSet) || hasNonVideoMediaType(mime, contentType)) return false;

      // Some Paramount MPDs put the media type only on Representation nodes.
      const reps = adaptSet.getElementsByTagNameNS('*', 'Representation');
      for (let i = 0; i < reps.length; i++) {
        if (representationHasVideo(reps[i], adaptSet)) return true;
      }
      return false;
    }

    const adaptSets = xmlDoc.getElementsByTagNameNS('*', 'AdaptationSet');
    const periods = Array.from(xmlDoc.getElementsByTagNameNS('*', 'Period'));
    const videoAdaptSets = [];

    if (adaptSets.length > 0) {
      for (let i = 0; i < adaptSets.length; i++) {
        if (adaptationHasVideo(adaptSets[i])) {
          videoAdaptSets.push(adaptSets[i]);
        }
      }
    }

    for (const adaptSet of videoAdaptSets) {
      const period = getAncestor(adaptSet, 'Period');
      const periodId = period?.getAttribute('id') || '';
      const periodIndex = period ? periods.indexOf(period) : -1;
      const periodKey = periodId || (periodIndex >= 0 ? `index-${periodIndex}` : 'unknown');
      const periodIsAd = isAdPeriod(period);
      const adaptationBaseUrl = getDirectBaseUrl(adaptSet);
      const adaptTmplNode = getDirectChild(adaptSet, 'SegmentTemplate');
      const adaptTemplate = adaptTmplNode ? adaptTmplNode.getAttribute('media') : null;
      const adaptInitialization = adaptTmplNode ? adaptTmplNode.getAttribute('initialization') : null;

      const setRepresentations = adaptSet.getElementsByTagNameNS('*', 'Representation');
      for (let j = 0; j < setRepresentations.length; j++) {
        const rep = setRepresentations[j];
        if (!representationHasVideo(rep, adaptSet)) continue;

        const w = rep.getAttribute('width');
        const h = rep.getAttribute('height');
        const bw = rep.getAttribute('bandwidth');
        const rawId = rep.getAttribute('id');
        const setIndex = videoAdaptSets.indexOf(adaptSet);
        const id = `s${setIndex}-${rawId}`;

        const baseUrlNode = getDirectChild(rep, 'BaseURL');
        const baseUrl = baseUrlNode ? baseUrlNode.textContent.trim() : null;

        const repTmplNode = getDirectChild(rep, 'SegmentTemplate');
        const repTemplate = repTmplNode ? repTmplNode.getAttribute('media') : null;
        const repInitialization = repTmplNode ? repTmplNode.getAttribute('initialization') : null;

        const finalTemplate = repTemplate || adaptTemplate;
        const finalInitialization = repInitialization || adaptInitialization;

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

          const isAd = periodIsAd || isAdReference(adaptationBaseUrl) ||
            [lowerBase, lowerId, lowerPath, lowerTempl].some(isAdReference);

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
            initialization: finalInitialization,
            codecs: rep.getAttribute('codecs') || adaptSet.getAttribute('codecs') || null,
            dashTier,
            width: w ? parseInt(w) : 0,
            height: finalHeight,
            bandwidth: parseInt(bw, 10),
            // Google DAI numbers program periods while ad periods use names
            // such as `pre-roll-1-ad-1`. Treat that hierarchy as authoritative
            // when a legacy content path has no useful marker.
            isContent: !isAd && (hasContentMarker || /^\d+$/.test(periodId)),
            isAd,
            // Compatible renditions may be split across multiple AdaptationSets
            // in the same DAI program period. Keep period and codec boundaries,
            // but do not treat the AdaptationSet index itself as a codec/DRM
            // boundary or Force Max will silently remain on the source tier.
            compatibilityKey: `dash:${periodKey}:${getVideoCodecFamily(rep.getAttribute('codecs') || adaptSet.getAttribute('codecs'))}`,
            family: 'dash',
            streamKey: deriveStreamKey(requestUrl, 'dash'),
            source: 'manifest'
          };

          qualities.push(q);
        }
      }
    }

    // Ignore ad-only manifests rather than replacing a valid content ladder.
    // For content, retain all same-height compatibility variants
    // internally and expose a single representative row to the popup.
    const nonAdQualities = qualities.filter(q => !q.isAd);
    if (nonAdQualities.length === 0) return;
    const markedContentQualities = nonAdQualities.filter(q => q.isContent);
    const eligibleQualities = markedContentQualities.length > 0
      ? markedContentQualities
      : nonAdQualities;

    const byHeightMap = new Map();
    for (const q of eligibleQualities) {
      const variants = byHeightMap.get(q.height) || [];
      variants.push(q);
      byHeightMap.set(q.height, variants);
    }

    let unique = Array.from(byHeightMap.values()).map(variants => {
      const preferred = variants.slice().sort((a, b) =>
        Number(Boolean(b.pathId)) - Number(Boolean(a.pathId)) ||
        (b.bandwidth || 0) - (a.bandwidth || 0)
      )[0];
      return { ...preferred, variants };
    });

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
      recordPlaybackCheckpoint('ladder_ready', {
        family: 'dash',
        streamKey: unique[0].streamKey || null,
        representationCount: unique.length,
        maxHeight: unique[0].height || null
      });
      const displayQualities = unique.map(q => {
        const fallbackBandwidth = q.dashTier ? parseInt(q.dashTier, 10) * 1000 : null;
        return {
          ...withoutVariants(q),
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
