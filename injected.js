(function () {
  const ORIGINAL_FETCH = window.fetch;
  const ORIGINAL_XHR_OPEN = XMLHttpRequest.prototype.open;

  // Constants
  const SEGMENT_EXTENSIONS = ['.m4s', '.mp4'];  // Support both DASH and HLS segments
  const MANIFEST_EXTENSIONS = ['.mpd', '.m3u8']; // Support both DASH and HLS manifests
  const RESOLUTION_REGEX = /_(\d{3,4}p)_/;

  // Helper to check if URL is a video segment
  function isSegmentUrl(url) {
    if (!url) return false;
    return SEGMENT_EXTENSIONS.some(ext => url.includes(ext));
  }

  // Helper to check if URL is a manifest
  function isManifestUrl(url) {
    if (!url) return false;
    return MANIFEST_EXTENSIONS.some(ext => url.includes(ext));
  }

  // Bitrate to resolution estimation
  // Based on actual Paramount+ VOD tiers: 4500, 3000, 2100, 1500, 750, 380
  const BITRATE_RESOLUTION_MAP = [
    { maxBitrate: 400, resolution: '270p' },    // ~380 tier
    { maxBitrate: 900, resolution: '360p' },    // ~750 tier
    { maxBitrate: 1700, resolution: '480p' },   // ~1500 tier
    { maxBitrate: 2500, resolution: '540p' },   // ~2100 tier
    { maxBitrate: 4200, resolution: '720p' },   // ~3000-3600 tier (bumped to capture 3.6Mbps)
    { maxBitrate: 6000, resolution: '1080p' },  // ~4500+ tier
    { maxBitrate: 12000, resolution: '1440p' },
    { maxBitrate: Infinity, resolution: '2160p' }
  ];

  function estimateResolutionFromBitrate(bitrateKbps) {
    if (!bitrateKbps) return null;
    for (const tier of BITRATE_RESOLUTION_MAP) {
      if (bitrateKbps <= tier.maxBitrate) {
        return tier.resolution;
      }
    }
    return '2160p';
  }

  // Helper to parse and dispatch
  let config = {
    forceMax: false
  };

  // Listen for config
  window.addEventListener('message', (event) => {
    if (event.source === window && event.data && event.data.type === 'PQI_CONFIG') {
      config = event.data.payload;

    }
  });

  function analyzeUrl(url) {
    try {
      if (!isSegmentUrl(url)) return;

      const urlObj = new URL(url, window.location.origin);
      const pathname = urlObj.pathname;

      // Skip audio segments (check CMCD ot=a or path contains aac/audio)
      const cmcdParam = urlObj.searchParams.get('CMCD');
      if (cmcdParam) {
        // Check for ot=a (object type = audio)
        if (cmcdParam.includes('ot=a') || cmcdParam.includes('ot%3Da')) {
          return; // Skip audio segments
        }
      }
      // Also check URL path for audio indicators
      if (pathname.includes('_aac_') || pathname.includes('/audio/') || pathname.includes('_audio_')) {
        return; // Skip audio segments
      }

      // Parse Resolution from URL path (e.g., _1080p_)
      const resMatch = pathname.match(RESOLUTION_REGEX);
      let resolution = resMatch ? resMatch[1] : null;
      let isEstimated = false;
      let exactBandwidth = null;

      // Dynamic Lookup for Resolution-Based VODs
      // If we have a resolution in the URL (e.g. 540p), look it up in the manifest data
      // to get the TRUE bitrate, rather than guessing.
      if (resolution && availableRepresentations.length > 0) {
        const numericRes = parseInt(resolution);
        const match = availableRepresentations.find(r => r.height === numericRes);
        if (match) {
          // Prefer dashTier (Average Bitrate) if available, to match the UI list.
          // Otherwise fallback to bandwidth (Max Bitrate).
          if (match.dashTier) {
            exactBandwidth = parseInt(match.dashTier) * 1000;
          } else {
            exactBandwidth = match.bandwidth;
          }
          isEstimated = false;
        }
      }

      // Parse Quality ID from URL (e.g. video_1080p.m3u8)
      // This is less reliable than parsing manifest but okay for logs
      // Note: We don't use this for core logic much, relied on parsing from Manifest

      // Parse CMCD params (Common Media Client Data)
      let bitrate = null;
      let maxBitrate = null;

      if (cmcdParam) {
        // Parse the comma-separated key-value pairs
        const pairs = cmcdParam.split(',');
        pairs.forEach(pair => {
          const [key, value] = pair.split('=');
          if (key === 'br') bitrate = parseInt(value, 10); // in kbps
          if (key === 'tb') maxBitrate = parseInt(value, 10); // in kbps
        });
      }

      // Try to extract quality tier from DASH URL path (e.g., _4500/seg_ means 4500 kbps tier)
      let requestedTier = null;
      if (!resolution) {
        // Pattern: ...731210_4500/seg_8.m4s -> extract 4500
        const dashTierMatch = pathname.match(/_(\d{3,5})\/seg_/);
        if (dashTierMatch) {
          requestedTier = parseInt(dashTierMatch[1], 10);
          resolution = estimateResolutionFromBitrate(requestedTier);
          isEstimated = true;
        }
      }

      // Fallback: estimate from CMCD bitrate
      if (!resolution && bitrate) {
        resolution = estimateResolutionFromBitrate(bitrate);
        isEstimated = true;
      }

      if (resolution || bitrate || exactBandwidth) {
        // Determine what bitrate to report
        // Priority: 1. Exact from Manifest (bps -> kbps), 2. Tier from URL, 3. CMCD
        let finalBitrate = bitrate;
        if (exactBandwidth) {
          finalBitrate = Math.round(exactBandwidth / 1000);
        } else if (requestedTier) {
          finalBitrate = requestedTier;
        }

        window.postMessage({
          type: 'PARAMOUNT_QUALITY_DATA',
          payload: {
            resolution,
            isEstimated: isEstimated, // true if resolution was derived from bitrate
            bitrate: finalBitrate,
            maxBitrate, // kbps (from CMCD tb)
            timestamp: Date.now()
          }
        }, '*');
      }

    } catch (e) {
      console.error('[PQI] Error analyzing URL:', e);
    }
  }

  // State for Smart Rewriting
  let availableRepresentations = [];

  // URL Rewriter (Phase 6 - Targeted)
  function retryRewriteUrl(url, targetRep) {
    if (!targetRep) return url;
    if (!targetRep.template) return url; // Only supporting templates for retry logic

    // Find WHICH representation the current URL matches
    for (const [index, rep] of availableRepresentations.entries()) {
      if (!rep.template) continue;

      if (index === 0) {

      }

      let pattern = rep.template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      pattern = pattern.replace(/\\\$Number\\\$/g, '(\\d+)');
      pattern = pattern.replace(/\\\$RepresentationID\\\$/g, '[^/]+');
      pattern = pattern.replace(/\\\$Bandwidth\\\$/g, '\\d+'); // Match any bandwidth

      const regex = new RegExp(pattern + '$');

      const parts = url.split('?');
      const urlPath = parts[0];

      const match = urlPath.match(regex);
      if (match) {
        // Extract segment number - knowing exactly which group is hard with variable patterns
        // So we look for the digits that match the Number part
        // Simplified: Assumes Number is the last digit group if multiple
        // Better: extract directly from the known positions if possible, but regex varies.
        // Fallback: use the original logic but improved.

        // Actually, let's pull segment number from the original basic regex if possible
        const simpleMatch = url.match(/seg_(\d+)\./) || url.match(/segment_(\d+)_/);
        const segmentNum = simpleMatch ? simpleMatch[1] : match[1]; // Fallback to group 1

        if (rep.id === targetRep.id) {

          return url; // Already target
        }

        const matchIndex = match.index;
        const urlPrefix = urlPath.substring(0, matchIndex);

        let newSuffix = targetRep.template;
        newSuffix = newSuffix.replace('$Number$', segmentNum);
        newSuffix = newSuffix.replace('$RepresentationID$', targetRep.id);

        // Support Bandwidth substitution
        if (targetRep.dashTier) {
          newSuffix = newSuffix.replace('$Bandwidth$', targetRep.dashTier);
        } else if (targetRep.bandwidth) {
          newSuffix = newSuffix.replace('$Bandwidth$', targetRep.bandwidth);
        }

        const finalUrl = urlPrefix + newSuffix + (parts[1] ? '?' + parts[1] : '');

        return finalUrl;
      }
    }

    return url;
  }

  // Legacy/Default Rewriter (Matches "Best" or "Specific")
  function maybeRewriteUrl(url) {
    if (availableRepresentations.length === 0) return url;

    // Log entry for debugging (filter noise)
    if (url.includes('.m4s') && !url.includes('_aac_') && !url.includes('/audio/')) {

    }

    // Check if this is an HLS segment URL (manifest_video_X_Y_SEGMENT.mp4 pattern)
    const hlsMatch = url.match(/manifest_video_(\d+)_(\d+)_(\d+)\.mp4/);

    if (hlsMatch) {
      // HLS segment detected
      const currentTier = hlsMatch[1];
      const trackIndex = hlsMatch[2];
      const segmentNum = hlsMatch[3];

      // Find the best representation (highest resolution/bandwidth)
      const bestRep = availableRepresentations[0]; // Already sorted by height desc

      if (config.forceMax && bestRep && bestRep.hlsTier !== undefined) {
        const targetTier = bestRep.hlsTier;

        if (targetTier !== currentTier) {
          const newUrl = url.replace(
            `manifest_video_${currentTier}_${trackIndex}_${segmentNum}.mp4`,
            `manifest_video_${targetTier}_${trackIndex}_${segmentNum}.mp4`
          );

          return newUrl;
        }
      }

      return url;
    }

    // Check if this is a DASH bitrate-path segment (e.g., _4500/seg_8.m4s)
    // BUT skip audio segments (they have _aac_ or similar in URL)
    if (url.includes('_aac_') || url.includes('/audio/') || url.includes('_audio_')) {
      return url; // Never rewrite audio segments
    }

    // Check if this is a DASH segment
    // Skip audio segments
    if (url.includes('_aac_') || url.includes('/audio/') || url.includes('_audio_')) {
      return url;
    }

    // --- REWRITE LOGIC ---
    if (config.forceMax || config.forcedId) {
      // 1. Determine Target Representation
      let targetRep = null;
      if (config.forcedId) {

        targetRep = availableRepresentations.find(r => r.id === config.forcedId);
        if (!targetRep) {
          console.warn(`[PQI] ForcedID "${config.forcedId}" NOT FOUND.`);
          return url; // Cannot rewrite if target unknown
        }
      } else {
        // Force Max
        targetRep = availableRepresentations[0];
      }

      if (!targetRep) return url;

      // PRIORITY: Template-based Rewrite
      // This handles complex path changes (e.g. c24->c20, 1080p->720p) that simple regex replace misses.
      if (targetRep.template) {

        const rewritten = retryRewriteUrl(url, targetRep);
        if (rewritten !== url) {
          return rewritten;
        }

      }

      // FALLBACK: Heuristic Rewrite (Legacy/Bitrate Only)
      // Only used if templates are missing or failed to match the source URL.

      // Type A: Resolution-Based VOD (Has _1080p_ etc. in path)
      const resMatch = url.match(/_(\d{3,4}p)_/);
      if (resMatch) {
        const currentRes = resMatch[1];
        const targetRes = targetRep.height + 'p';

        if (currentRes !== targetRes) {

          let newUrl = url.replace(`_${currentRes}_`, `_${targetRes}_`);

          // Also try to replace bitrate tier if present near the resolution
          // Usually follows the resolution pattern (e.g. _540p_..._2000/)
          // We'll trust the bitrate tier from the targetRep if available
          if (targetRep.dashTier) {
            const bitrateMatch = url.match(/_(\d{3,5})\/seg_/);
            if (bitrateMatch) {
              const currentBitrate = bitrateMatch[1];
              if (currentBitrate !== targetRep.dashTier) {
                newUrl = newUrl.replace(`_${currentBitrate}/seg_`, `_${targetRep.dashTier}/seg_`);

              }
            }
          }
          return newUrl;
        }
      }

      // Type B: Bitrate-Only VOD
      const dashBitrateMatch = url.match(/_(\d{3,5})\/seg_(\d+)\.m4s/);
      if (dashBitrateMatch) {
        const currentBitrate = dashBitrateMatch[1];
        const segmentNum = dashBitrateMatch[2];

        if (targetRep.dashTier) {
          const targetBitrate = targetRep.dashTier;
          if (targetBitrate !== currentBitrate) {

            return url.replace(
              `_${currentBitrate}/seg_${segmentNum}.m4s`,
              `_${targetBitrate}/seg_${segmentNum}.m4s`
            );
          }
        }
      }

      return url;
    }

    // DASH segment handling with templates (existing logic)
    // Priority 1: Specific Forced ID
    if (config.forcedId) {
      const targetRep = availableRepresentations.find(r => r.id === config.forcedId);
      if (targetRep) {

        return retryRewriteUrl(url, targetRep);
      } else {

      }
    }

    // Priority 2: Force Max with templates
    if (config.forceMax) {
      // Find absolute max
      const bestRep = availableRepresentations.find(r => r.height >= 1080) || availableRepresentations[0];
      return retryRewriteUrl(url, bestRep);
    }

    if (config.forcedId || config.forceMax) {

    }

    return url;
  }


  // Hook Fetch
  window.fetch = async function (...args) {
    let [resource, init] = args;
    const originalResource = resource;

    // Normalize URL
    let url = '';
    if (typeof resource === 'string') {
      url = resource;
    } else if (resource instanceof Request) {
      url = resource.url;
    }

    // 1. Initial Attempt (Force Max or Forced ID)
    let newUrl = url;
    let attemptsMade = false;

    if (url && (config.forceMax || config.forcedId) && isSegmentUrl(url)) {
      newUrl = maybeRewriteUrl(url);
      if (newUrl !== url) {
        attemptsMade = true;
        if (typeof resource === 'string') {
          args[0] = newUrl;
        } else if (resource instanceof Request) {
          args[0] = new Request(newUrl, resource);
        }
        analyzeUrl(newUrl);
      } else {
        analyzeUrl(url);
      }
    } else if (url) {
      analyzeUrl(url);
    }

    if (attemptsMade) {
      try {
        const response = await ORIGINAL_FETCH.apply(this, args);
        if (response.ok) return response;

        console.warn(`[PQI] Force/Rewrite failed (${response.status}) on: ${newUrl}`);

        // 2. Retry Logic (Graceful Degradation)
        // If 1080p failed, is there a 720p?
        // Get current target height
        const maxRep = availableRepresentations.find(r => r.height >= 1080) || availableRepresentations[0];

        // Find next best: < 1080p but > current
        // Actually, just find the next available rep appearing in our list (since we sort descending)
        // maxRep is at index 0?
        const currentIndex = availableRepresentations.indexOf(maxRep);
        const nextBest = availableRepresentations[currentIndex + 1];

        if (nextBest && nextBest.height >= 720) {
          const fallbackUrl = retryRewriteUrl(url, nextBest);
          if (fallbackUrl !== url && fallbackUrl !== newUrl) {

            if (typeof resource === 'string') args[0] = fallbackUrl;
            else if (resource instanceof Request) args[0] = new Request(fallbackUrl, resource);

            const fbResponse = await ORIGINAL_FETCH.apply(this, args);
            if (fbResponse.ok) {
              analyzeUrl(fallbackUrl);
              return fbResponse;
            }
            console.warn(`[PQI] Fallback failed (${fbResponse.status}) on: ${fallbackUrl}`);
          }
        }

        // 3. Final Fallback to Original
        console.warn('[PQI] All forces failed, reverting to original.');
        args[0] = originalResource;
        if (typeof originalResource === 'string') analyzeUrl(originalResource);
        else if (originalResource instanceof Request) analyzeUrl(originalResource.url);
        return ORIGINAL_FETCH.apply(this, args);

      } catch (err) {
        console.warn('[PQI] Network error during rewrite, reverting.', err);
        args[0] = originalResource;
        if (typeof originalResource === 'string') analyzeUrl(originalResource);
        else if (originalResource instanceof Request) analyzeUrl(originalResource.url);
        return ORIGINAL_FETCH.apply(this, args);
      }
    }

    const response = await ORIGINAL_FETCH.apply(this, args);

    // Manifest Interception
    if (isManifestUrl(url)) {
      const clone = response.clone();
      clone.text().then(text => {
        parseManifest(text, url);
      }).catch(e => console.error('[PQI] Error reading manifest:', e));
    }

    return response;
  };

  // Hook XHR
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    let finalUrl = url;
    if (url && typeof url === 'string' && isSegmentUrl(url)) {
      finalUrl = maybeRewriteUrl(url);
      analyzeUrl(finalUrl);
      this._pqi_url = finalUrl;
    }
    return ORIGINAL_XHR_OPEN.apply(this, [method, finalUrl, ...rest]);
  };

  // Hook XHR Response for Manifest
  const ORIGINAL_XHR_SEND = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (this._pqi_url && isManifestUrl(this._pqi_url)) {
      this.addEventListener('load', () => {
        parseManifest(this.responseText, this._pqi_url);
      });
    }
    return ORIGINAL_XHR_SEND.apply(this, args);
  };

  /**
   * Parses HLS master playlist (.m3u8) to extract quality variants.
   * HLS format uses #EXT-X-STREAM-INF tags like:
   * #EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1..."
   * variant_1080p.m3u8
   */
  function parseHlsManifest(content, manifestUrl) {
    try {
      const lines = content.split('\n');
      const qualities = [];
      let variantIndex = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Look for #EXT-X-STREAM-INF tags (video variants)
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
          const attrs = line.substring('#EXT-X-STREAM-INF:'.length);

          // Parse attributes (BANDWIDTH, RESOLUTION, CODECS, etc.)
          let bandwidth = null;
          let resolution = null;
          let codecs = null;
          let width = null;
          let height = null;

          // Parse BANDWIDTH=value
          const bwMatch = attrs.match(/BANDWIDTH=(\d+)/);
          if (bwMatch) bandwidth = parseInt(bwMatch[1], 10);

          // Parse RESOLUTION=WIDTHxHEIGHT
          const resMatch = attrs.match(/RESOLUTION=(\d+)x(\d+)/);
          if (resMatch) {
            width = parseInt(resMatch[1], 10);
            height = parseInt(resMatch[2], 10);
            resolution = `${height}p`;
          }

          // Parse CODECS="..." 
          const codecsMatch = attrs.match(/CODECS="([^"]+)"/);
          if (codecsMatch) codecs = codecsMatch[1];

          // The next non-empty, non-comment line is the variant URL
          let variantUrl = null;
          for (let j = i + 1; j < lines.length; j++) {
            const nextLine = lines[j].trim();
            if (nextLine && !nextLine.startsWith('#')) {
              variantUrl = nextLine;
              break;
            }
          }

          // Only add video variants (must have height or bandwidth)
          if (height || bandwidth) {
            // Estimate height from bandwidth if not provided
            if (!height && bandwidth) {
              const estimatedRes = estimateResolutionFromBitrate(bandwidth / 1000);
              height = parseInt(estimatedRes);
              resolution = estimatedRes;
            }

            // Extract HLS tier from variant URL patterns like:
            // - manifest_video_1/... -> tier 1
            // - video/1/... -> tier 1
            // - manifest_video_1_0_123.mp4 -> tier 1
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
              bandwidth: bandwidth,
              width: width,
              height: height,
              resolution: resolution,
              codecs: codecs,
              variantUrl: variantUrl,
              hlsTier: hlsTier,
              isHls: true
            });
            variantIndex++;
          }
        }
      }

      // Dedupe by height - keep highest bitrate for each resolution
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

      unique.sort((a, b) => (b.height || 0) - (a.height || 0)); // descending

      if (unique.length > 0) {
        availableRepresentations = unique;
        window.postMessage({
          type: 'PQI_MANIFEST_DATA',
          payload: unique
        }, '*');
      }
    } catch (e) {
      console.error('[PQI] Error parsing HLS manifest:', e);
    }
  }

  /**
   * Parses DASH manifest (.mpd) to extract video representations.
   */
  function parseDashManifest(xmlString) {
    try {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlString, "text/xml");

      const representations = xmlDoc.getElementsByTagName('Representation');
      const qualities = [];

      // Helper: Check for Image/Text AdaptationSets
      function isVideoAdaptation(node) {
        const adaptSet = node.parentNode; // Representation -> AdaptationSet
        if (!adaptSet || adaptSet.tagName !== 'AdaptationSet') return true;
        const mime = adaptSet.getAttribute('mimeType');
        const contentType = adaptSet.getAttribute('contentType');
        if (mime && !mime.includes('video')) return false;
        if (contentType && contentType !== 'video') return false;
        return true;
      }

      // Check for SegmentTemplate at AdaptationSet level (common)
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

        // Extract DASH tier from BaseURL or template patterns like _4500/seg or _4500.m4s
        let dashTier = null;
        const tierSource = baseUrl || finalTemplate || id;
        if (tierSource) {
          // Pattern: _4500/ or _4500. in the path
          const tierMatch = tierSource.match(/_(\d{3,5})[\/\.]/);
          if (tierMatch) {
            dashTier = tierMatch[1];
          }
        }
        // NOTE: We don't fallback to raw bandwidth for dashTier because it often causes 404s.
        // Instead, we fuzzy match against KNOWN server tiers (from probing)
        if (!dashTier && bw) {

          const bwKbps = Math.round(parseInt(bw) / 1000);
          // Bandwidth in manifest is MAX bitrate, usually ~1.3x the Average bitrate (URL tier)
          const targetAvgBitrate = bwKbps / 1.3;

          // Known tiers on Paramount+ (closest match wins)
          const KNOWN_TIERS = [4500, 3000, 2100, 1500, 750, 380];

          const closest = KNOWN_TIERS.reduce((prev, curr) => {
            return (Math.abs(curr - targetAvgBitrate) < Math.abs(prev - targetAvgBitrate) ? curr : prev);
          });



          // Only accept if within reasonable range (e.g. +/- 40%)
          if (Math.abs(closest - targetAvgBitrate) / targetAvgBitrate < 0.4) {
            dashTier = closest.toString();

          } else {

          }
        }

        if (h) {
          qualities.push({
            id: id,
            baseUrl: baseUrl,
            template: finalTemplate,
            dashTier: dashTier, // Extracted or Calculated
            width: parseInt(w),
            height: parseInt(h),
            bandwidth: parseInt(bw),
            codecs: codecs
          });
        }
      }

      // Dedupe by ID
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

      availableRepresentations = unique;

      if (unique.length > 0) {
        // For representations with dashTier, use dashTier*1000 as display bandwidth
        // This shows the actual server tier, not the manifest's claimed bandwidth
        const displayQualities = unique.map(q => {
          if (q.dashTier) {
            // Check if the URL/Template indicates a specific resolution (Type A VOD)
            // If so, rely on the manifest's actual height, do NOT overwrite it.
            const src = q.template || q.baseUrl || '';
            const hasResolutionInUrl = src.match(/_(\d{3,4}p)_/);

            if (hasResolutionInUrl) {
              return {
                ...q,
                // Still convert tier to bps for display bandwidth if needed,
                // but KEEP the original height.
                bandwidth: parseInt(q.dashTier) * 1000
              };
            }

            return {
              ...q,
              bandwidth: parseInt(q.dashTier) * 1000, // Convert tier to bps for display
              height: estimateResolutionFromBitrate(parseInt(q.dashTier)).replace('p', '') // Estimate from tier
            };
          }
          return q;
        });

        // Re-sort by the updated heights
        displayQualities.sort((a, b) => parseInt(b.height) - parseInt(a.height));

        availableRepresentations = unique; // Keep original for rewriting

        window.postMessage({
          type: 'PQI_MANIFEST_DATA',
          payload: displayQualities
        }, '*');
      }
    } catch (e) {
      console.error('[PQI] Error parsing DASH manifest:', e);
    }
  }

  /**
   * Routes manifest content to the appropriate parser based on content type.
   */
  function parseManifest(content, url) {
    // Check if it's HLS (starts with #EXTM3U) or DASH (XML)
    const trimmed = content.trim();
    if (trimmed.startsWith('#EXTM3U')) {
      parseHlsManifest(content, url);
    } else if (trimmed.startsWith('<?xml') || trimmed.startsWith('<MPD')) {
      parseDashManifest(content);
    } else {
      console.log('[PQI] Unknown manifest format');
    }
  }

  // Export for Unit Testing (Node.js/Jest only)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      parseManifest,
      parseDashManifest,
      parseHlsManifest,
      maybeRewriteUrl,
      retryRewriteUrl,
      estimateResolutionFromBitrate,
      analyzeUrl,
      setConfig: (c) => { config = c; },
      setAvailableRepresentations: (r) => { availableRepresentations = r; },
      getAvailableRepresentations: () => availableRepresentations,
      isSegmentUrl
    };
  }

  console.log('[PQI] Injected script active (v7.0).');
})();
