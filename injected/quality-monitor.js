// Pure timing/evidence state machine. Callers supply monotonic time and opaque
// video/session identities; no DOM, timers, networking, or configuration writes.
export function createQualityMonitor() {
  let context = null;
  let targetHeight = null;
  let epoch = 0;
  let windowState = null;
  let status = 'insufficient-evidence';
  let lastSequence = -1;
  let latestDecoded = null;
  const snapshot = () => ({ status, targetHeight, decodedHeight: latestDecoded,
    eligibleSeconds: (windowState?.elapsed || 0) / 1000,
    bufferBoundary: windowState?.boundary ?? null,
    observations: windowState?.observations.slice() || [] });
  const transition = next => {
    const changed = next !== status;
    status = next;
    return { changed, ...snapshot() };
  };
  const interrupt = () => {
    if (windowState) epoch++;
    windowState = null; return transition('insufficient-evidence');
  };
  const configure = (key, height) => {
    if (key === context && height === targetHeight) return false;
    context = key; targetHeight = height; epoch++; lastSequence = -1;
    latestDecoded = null; interrupt(); return true;
  };
  const observe = observation => {
    if (!windowState || observation.epoch !== epoch || observation.startedAt < windowState.startedAt ||
        observation.sequence <= lastSequence || !Number.isFinite(observation.height) || observation.height <= 0) return;
    lastSequence = observation.sequence;
    if (windowState.observations.some(item => item.requestKey === observation.requestKey)) return;
    windowState.observations.push(observation);
    windowState.observations = windowState.observations.slice(-3);
  };
  const sample = value => {
    latestDecoded = value.decodedHeight ?? null;
    if (!targetHeight || !value.eligible || !Number.isFinite(value.currentTime) || !Number.isFinite(value.now)) return interrupt();
    if (!windowState || windowState.video !== value.video) {
      if (windowState) interrupt();
      if (!Number.isFinite(value.bufferedEnd) || value.bufferedEnd < value.currentTime) return interrupt();
      windowState = { video: value.video, startedAt: value.now, lastAt: value.now, lastTime: value.currentTime,
        boundary: value.bufferedEnd, elapsed: 0, mismatchElapsed: 0, matched: 0, observations: [] };
      return transition('insufficient-evidence');
    }
    const elapsed = value.now - windowState.lastAt;
    const progress = value.currentTime - windowState.lastTime;
    if (elapsed <= 0 || elapsed > 5000 || progress <= 0 || progress > elapsed / 1000 * (value.playbackRate || 1) + 2) return interrupt();
    windowState.lastAt = value.now; windowState.lastTime = value.currentTime; windowState.elapsed += elapsed;
    if (value.decodedHeight === targetHeight) {
      windowState.mismatchElapsed = 0;
      if (++windowState.matched >= 3) return transition('matched');
      return transition('insufficient-evidence');
    }
    windowState.matched = 0;
    if (Number.isFinite(value.decodedHeight) && Math.abs(value.decodedHeight - targetHeight) > 16) windowState.mismatchElapsed += elapsed;
    else windowState.mismatchElapsed = 0;
    if (!Number.isFinite(value.decodedHeight) || Math.abs(value.decodedHeight - targetHeight) <= 16 ||
        windowState.mismatchElapsed < 30000 || value.currentTime < windowState.boundary + 2) return transition('insufficient-evidence');
    const observations = windowState.observations;
    if (observations.length < 3 || value.now - observations.at(-1).completedAt > 15000) return transition('insufficient-evidence');
    if (observations.every(item => item.height !== targetHeight)) return transition('retrieval-mismatch');
    if (observations.every(item => item.height === targetHeight)) return transition('decode-mismatch');
    return transition('insufficient-evidence');
  };
  return { configure, observe, sample, interrupt, snapshot, capture: () => epoch };
}
