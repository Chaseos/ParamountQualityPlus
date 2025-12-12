import { setConfig } from './state.js';

// Listen for configuration messages from the extension UI and persist them in
// module state so other helpers (rewriter, network hooks) always read the
// latest settings.
export function initConfigListener() {
  window.addEventListener('message', (event) => {
    if (event.source === window && event.data && event.data.type === 'PQI_CONFIG') {
      setConfig(event.data.payload);
    }
  });
}
