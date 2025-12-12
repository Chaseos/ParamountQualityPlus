// Simple module-level store that keeps the current quality configuration and
// the parsed list of available representations from the active manifest.
let config = {
  forceMax: false,
  forcedId: null
};

let availableRepresentations = [];

export function getConfig() {
  return config;
}

export function setConfig(newConfig) {
  config = newConfig;
}

export function getRepresentations() {
  return availableRepresentations;
}

export function setRepresentations(reps) {
  availableRepresentations = reps;
}
