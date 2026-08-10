// Simple module-level store that keeps the current quality configuration and
// the parsed list of available representations from the active manifest.
let config = {
  forceMax: false,
  forcedId: null,
  forcedHeight: null,
  enableRetries: true,
  maxRetries: 3,
  enablePrefetch: true,
  prefetchCount: 5
};

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
  config = newConfig;
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
