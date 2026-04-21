const PREFETCH_CACHE_LIMIT = 200; // Keep the set from growing infinitely
const prefetchQueue = new Set();
const PREFETCH_COUNT = 5;

// Find a number directly before the file extension. 
// E.g., 'seg_10.m4s' or 'video_1_10.ts'
const SEGMENT_NUMBER_REGEX = /^(.*?)(\d+)(\.(?:m4s|ts|mp4)(?:\?.*)?)$/i;

export function maybePrefetchSegments(url, originalFetch) {
  if (!url) return;

  const normalizedUrl = url.split('?')[0];
  // Add the current URL to the queue so we don't fetch it again
  if (prefetchQueue.size > PREFETCH_CACHE_LIMIT) {
    // Clear half the cache to make room, relying on temporal locality
    const items = Array.from(prefetchQueue);
    prefetchQueue.clear();
    items.slice(PREFETCH_CACHE_LIMIT / 2).forEach(item => prefetchQueue.add(item));
  }
  prefetchQueue.add(normalizedUrl);

  const match = url.match(SEGMENT_NUMBER_REGEX);
  if (!match) {
    console.log(`[PQI Debug] URL did not match segment regex: ${url}`);
    return;
  }

  const [, prefix, numStr, suffix] = match;
  let currentNum = parseInt(numStr, 10);

  let prefetchedCount = 0;

  for (let i = 1; i <= PREFETCH_COUNT; i++) {
    const nextNum = currentNum + i;
    const nextNumStr = String(nextNum).padStart(numStr.length, '0');
    const nextUrl = `${prefix}${nextNumStr}${suffix}`;
    const nextNormalizedUrl = nextUrl.split('?')[0];

    if (!prefetchQueue.has(nextNormalizedUrl)) {
      prefetchQueue.add(nextNormalizedUrl);
      prefetchedCount++;
      console.log(`[PQI Debug] Prefetching future segment: ${nextUrl}`);
      // Fire and forget the background fetch using the raw fetch function.
      // The browser's network stack will cache the response.
      Promise.resolve(originalFetch(nextUrl, { priority: 'low' })).catch(() => {
        // Ignore prefetch failures; if the network hiccuped, the player
        // will just try again later and our fetchWithRetry will catch it.
      });
    }
  }
  
  if (prefetchedCount > 0) {
    console.log(`[PQI Debug] Triggered ${prefetchedCount} prefetch(es) based on: ${url}`);
  }
}

// Exported for testing
export function clearPrefetchQueue() {
  prefetchQueue.clear();
}
