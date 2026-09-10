import { getPackageManifestCandidate, readPackageManifest, selectPackageTarget } from './package-manifest.js';
import { isAuthoritativePlanRejected } from './inferred-vod.js';

const MAX_BYTES = 2 * 1024 * 1024;
const eligibleReasons = new Set(['no-representation', 'no-compatible-representation', 'rejected',
  'unrecognized-family-request', 'single-file-manifest-selection']);

export function needsPackageDiscovery(plan, config) {
  return Boolean(config.forceMax || config.forcedId || config.forcedHeight) &&
    plan?.action === 'pass-through' && eligibleReasons.has(plan.reason);
}

async function readBoundedBody(response, signal) {
  if (Number(response.headers?.get('content-length')) > MAX_BYTES) throw new Error('manifest-too-large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('unsupported-body');
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      if (signal.aborted) throw new Error('cancelled');
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { cancel(); throw new Error('manifest-too-large'); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

export function createPackageDiscovery({ fetch, record, getPage = () => window.location.pathname }) {
  let page = getPage();
  let generation = 0;
  const attempts = new Set();
  const statuses = new Map();
  const pending = new Set();
  const manifests = new Map();
  const invalidate = () => {
    generation++;
    for (const controller of pending) controller.abort();
    pending.clear();
    manifests.clear();
    for (const key of statuses.keys()) statuses.set(key, 'rejected');
  };
  const reset = () => { invalidate(); attempts.clear(); statuses.clear(); page = getPage(); };
  const capture = () => {
    if (getPage() !== page) reset();
    return generation;
  };
  const observe = (url, token) => {
    if (capture() !== token) return;
    const candidate = getPackageManifestCandidate(url);
    if (!candidate || attempts.has(candidate.packageUrl)) return;
    attempts.add(candidate.packageUrl);
    statuses.set(candidate.packageUrl, 'pending');
    const controller = new AbortController();
    pending.add(controller);
    const detail = { packageUrl: candidate.packageUrl, packaging: candidate.packaging };
    record('package_manifest_discovery', { ...detail, outcome: 'started' });
    let timer;
    const work = async () => {
      const response = await fetch(candidate.manifestUrl, {
        credentials: 'omit', redirect: 'error', signal: controller.signal
      });
      if (!response.ok || response.redirected || response.url !== candidate.manifestUrl) throw new Error('response-rejected');
      const text = await readBoundedBody(response, controller.signal);
      if (capture() !== token || controller.signal.aborted) return;
      const manifest = readPackageManifest(text, candidate, url);
      if (!manifest) throw new Error('manifest-mismatch-or-unsupported');
      manifests.set(candidate.packageUrl, manifest);
      statuses.set(candidate.packageUrl, 'validated');
      record('package_manifest_discovery', { ...detail, outcome: 'validated', diagnosticOnly: Boolean(manifest.diagnosticOnly) });
    };
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { reject(new Error('timeout')); controller.abort(); }, 5000);
    });
    const cancelled = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    void Promise.race([work(), timeout, cancelled]).catch(error => {
      if (capture() !== token) return;
      statuses.set(candidate.packageUrl, 'rejected');
      // Log a fixed reason vocabulary, never an exception containing a URL.
      const reasons = ['timeout', 'manifest-too-large', 'response-rejected', 'unsupported-body', 'manifest-mismatch-or-unsupported'];
      record('package_manifest_discovery', { ...detail, outcome: 'skipped',
        reason: reasons.includes(error.message) ? error.message : 'request-failed' });
    }).finally(() => { clearTimeout(timer); pending.delete(controller); });
  };
  const plan = (url, config, representations) => {
    capture();
    const candidate = getPackageManifestCandidate(url);
    const manifest = candidate && manifests.get(candidate.packageUrl);
    if (!manifest) return null;
    const selected = selectPackageTarget(manifest, url, config, representations);
    if (!selected) return null;
    const rejectionKey = `${candidate.packageUrl}|package-manifest|${selected.target.periodKey}|${selected.target.rawId}`;
    if (isAuthoritativePlanRejected(rejectionKey)) return null;
    return { action: 'authoritative-rewrite', originalUrl: url, url: selected.url,
      target: selected.target, targetHeight: selected.target.height, targetBitrateKbps: selected.target.bandwidth / 1000,
      streamKey: candidate.packageUrl.slice(0, -1), rejectionKey, strategy: 'package-manifest',
      mediaRole: 'segment', source: 'package-manifest', targetSource: 'package-manifest' };
  };
  window.addEventListener('pagehide', reset);
  const status = url => statuses.get(getPackageManifestCandidate(url)?.packageUrl) || 'untried';
  return { capture, observe, plan, reset, status, authoritativeReceived: invalidate };
}
