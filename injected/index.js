import { initConfigListener } from './config.js';
import { analyzeUrl } from './url-analysis.js';
import { parseManifest, parseDashManifest, parseHlsManifest } from './manifest-parser.js';
import { maybeRewriteUrl, retryRewriteUrl, resolveNextBestRepresentation, resolveTargetRepresentation } from './rewriter.js';
import { initNetworkHooks } from './network-hooks.js';
import { estimateResolutionFromBitrate } from './constants.js';
import { getConfig, getRepresentations, setConfig, setRepresentations } from './state.js';

// Wire together config handling and network interception as soon as the module
// loads so the injected script is fully operational without additional setup.
initConfigListener();
initNetworkHooks({ analyzeUrl, maybeRewriteUrl, parseManifest });

// Re-export pieces for tests and external tooling that depend on the injected
// logic while keeping the runtime side effects (above) intact.
export {
  analyzeUrl,
  estimateResolutionFromBitrate,
  getConfig,
  getRepresentations as getAvailableRepresentations,
  maybeRewriteUrl,
  parseDashManifest,
  parseHlsManifest,
  parseManifest,
  resolveNextBestRepresentation,
  resolveTargetRepresentation,
  retryRewriteUrl,
  setConfig,
  setRepresentations as setAvailableRepresentations
};
