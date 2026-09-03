// Simple module-level store that keeps the current quality configuration and
// the parsed list of available representations from the active manifest.
export const DEFAULT_CONFIG = Object.freeze({
  forceMax: false,
  forcedId: null,
  forcedHeight: null,
  enableRetries: true,
  maxRetries: 3,
  enablePrefetch: true,
  prefetchCount: 5
});

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function normalizeConfig(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const forcedHeight = Number.parseInt(source.forcedHeight, 10);
  return {
    forceMax: Boolean(source.forceMax),
    forcedId: typeof source.forcedId === 'string' && source.forcedId ? source.forcedId : null,
    forcedHeight: Number.isFinite(forcedHeight) && forcedHeight > 0 ? forcedHeight : null,
    enableRetries: source.enableRetries !== false,
    maxRetries: boundedInteger(source.maxRetries, DEFAULT_CONFIG.maxRetries, 1, 10),
    enablePrefetch: source.enablePrefetch !== false,
    prefetchCount: boundedInteger(source.prefetchCount, DEFAULT_CONFIG.prefetchCount, 1, 20)
  };
}

let config = normalizeConfig();

let availableRepresentations = [];
let streamSession = {
  key: null,
  family: null,
  manifestUrl: null
};

export function getConfig() {
  return config;
}

export function setConfig(newConfig) {
  config = normalizeConfig(newConfig);
}

export function getRepresentations() {
  return availableRepresentations;
}

export function setRepresentations(reps, context = {}) {
  availableRepresentations = reps;
  if (reps.length === 0) {
    streamSession = { key: null, family: null, manifestUrl: null };
    return;
  }
  streamSession = {
    key: context.streamKey ?? reps[0]?.streamKey ?? streamSession.key,
    family: context.family ?? reps[0]?.family ?? streamSession.family,
    manifestUrl: context.manifestUrl ?? streamSession.manifestUrl
  };
}

export function clearRepresentations() {
  availableRepresentations = [];
  streamSession = { key: null, family: null, manifestUrl: null };
}

export function getStreamSession() {
  return streamSession;
}
