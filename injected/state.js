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
  const hasHls = reps.some(r => r.hlsTier !== undefined);
  const existingHls = availableRepresentations.some(r => r.hlsTier !== undefined);

  // If we have existing HLS tiers (main content) and the new manifest is DASH
  // (which on Paramount+ is often an Ad or supplementary), we MERGE them 
  // instead of overwriting, to ensure our forcedId for HLS still works.
  if (existingHls && !hasHls && reps.length < 10) {
    console.log('[PQI_DEBUG] Preserving HLS tiers; appending new DASH reps.');
    availableRepresentations = [...availableRepresentations.filter(r => r.hlsTier !== undefined), ...reps];
  } else {
    availableRepresentations = reps;
  }
}
