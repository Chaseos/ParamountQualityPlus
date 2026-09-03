import { normalizeConfig, setConfig } from './state.js';
import { recordPlaybackCheckpoint } from './diagnostics.js';

export const PENDING_CONFIG_KEY = 'pqiPendingQualityConfig';

export function consumePendingConfig(storage = null) {
  try {
    const configStorage = storage || window.sessionStorage;
    const rawConfig = configStorage?.getItem(PENDING_CONFIG_KEY);
    if (!rawConfig) return null;

    configStorage.removeItem(PENDING_CONFIG_KEY);
    const config = JSON.parse(rawConfig);
    if (!config || typeof config !== 'object') return null;
    const normalized = normalizeConfig(config);
    setConfig(normalized);
    recordPlaybackCheckpoint('configuration_restored', {
      forceMax: normalized.forceMax,
      hasManualSelection: Boolean(normalized.forcedId || normalized.forcedHeight)
    });
    return normalized;
  } catch (error) {
    console.warn('[PQI] Unable to restore pending quality configuration.', error);
    return null;
  }
}

// Listen for configuration messages from the extension UI and persist them in
// module state so other helpers (rewriter, network hooks) always read the
// latest settings.
export function initConfigListener() {
  window.addEventListener('message', (event) => {
    if (event.source === window && event.data?.type === 'PQI_CONFIG' &&
        event.data.payload && typeof event.data.payload === 'object') {
      const config = normalizeConfig(event.data.payload);
      setConfig(config);
      recordPlaybackCheckpoint('configuration_applied', {
        forceMax: config.forceMax,
        hasManualSelection: Boolean(config.forcedId || config.forcedHeight)
      });
    }
  });
}
