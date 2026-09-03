const DIAGNOSTIC_EVENT_LIMIT = 300;

const diagnosticState = {
  startedAt: Date.now(),
  startedAtMonotonic: diagnosticNow(),
  sequence: 0,
  counters: {},
  events: []
};

let diagnosticsInitialized = false;

export function diagnosticNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function incrementCounter(name, amount = 1) {
  diagnosticState.counters[name] = (diagnosticState.counters[name] || 0) + amount;
}

function sanitizeUrl(url) {
  try {
    const parsed = new URL(url, window.location.origin);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url || '').split('?')[0].split('#')[0];
  }
}

function trimEvents() {
  if (diagnosticState.events.length > DIAGNOSTIC_EVENT_LIMIT) {
    diagnosticState.events.splice(0, diagnosticState.events.length - DIAGNOSTIC_EVENT_LIMIT);
  }
}

export function recordDiagnosticEvent(type, detail = {}) {
  incrementCounter(type);
  diagnosticState.events.push({
    sequence: ++diagnosticState.sequence,
    timestamp: Date.now(),
    elapsedMs: Math.round(diagnosticNow() - diagnosticState.startedAtMonotonic),
    type,
    detail
  });
  trimEvents();
}

// Sparse, human-readable checkpoints for manual playback verification.
// Per-request diagnostics remain available in the snapshot without filling the
// console for every media segment.
export function recordPlaybackCheckpoint(checkpoint, detail = {}) {
  const payload = { checkpoint, ...detail };
  recordDiagnosticEvent('playback_checkpoint', payload);
  console.info?.(`[PQI checkpoint] ${checkpoint}`, detail);
}

export function recordRequestAttempt({
  transport,
  category,
  url,
  method = 'GET',
  attempt = 1,
  maxAttempts = 1,
  status = null,
  ok = null,
  outcome,
  durationMs
}) {
  recordDiagnosticEvent('network_attempt', {
    transport,
    category,
    url: sanitizeUrl(url),
    method,
    attempt,
    maxAttempts,
    status,
    ok,
    outcome,
    durationMs: Math.round(durationMs * 10) / 10
  });
  incrementCounter(`${category}_attempts`);
  if (attempt > 1) incrementCounter('retry_attempts');
  if (outcome === 'success') incrementCounter('successful_attempts');
  if (outcome === 'http-error' || outcome === 'network-error') incrementCounter('failed_attempts');
  if (outcome === 'cancelled') incrementCounter('cancelled_attempts');
}

function snapshotVideo(video) {
  if (!video) return null;

  let bufferedAhead = 0;
  try {
    for (let index = 0; index < video.buffered.length; index++) {
      if (video.buffered.start(index) <= video.currentTime && video.buffered.end(index) >= video.currentTime) {
        bufferedAhead = Math.max(0, video.buffered.end(index) - video.currentTime);
        break;
      }
    }
  } catch {
    bufferedAhead = 0;
  }

  return {
    currentTime: Number.isFinite(video.currentTime) ? Math.round(video.currentTime * 10) / 10 : null,
    duration: Number.isFinite(video.duration) ? Math.round(video.duration * 10) / 10 : null,
    paused: Boolean(video.paused),
    ended: Boolean(video.ended),
    readyState: video.readyState,
    networkState: video.networkState,
    bufferedAhead: Math.round(bufferedAhead * 10) / 10,
    errorCode: video.error?.code || null
  };
}

export function getDiagnosticSnapshot() {
  const video = typeof document !== 'undefined' ? document.querySelector('video') : null;
  return {
    version: 1,
    startedAt: diagnosticState.startedAt,
    elapsedMs: Math.round(diagnosticNow() - diagnosticState.startedAtMonotonic),
    counters: { ...diagnosticState.counters },
    playback: snapshotVideo(video),
    recentEvents: diagnosticState.events.map(event => ({
      ...event,
      detail: { ...event.detail }
    }))
  };
}

export function resetDiagnostics() {
  diagnosticState.startedAt = Date.now();
  diagnosticState.startedAtMonotonic = diagnosticNow();
  diagnosticState.sequence = 0;
  diagnosticState.counters = {};
  diagnosticState.events = [];
}

export function initDiagnostics() {
  if (diagnosticsInitialized || typeof window === 'undefined' || typeof document === 'undefined') return;
  diagnosticsInitialized = true;

  const playbackEvents = [
    'encrypted', 'error', 'loadedmetadata', 'pause', 'play', 'playing',
    'seeked', 'seeking', 'stalled', 'waiting'
  ];
  playbackEvents.forEach(type => {
    document.addEventListener(type, event => {
      if (event.target?.tagName !== 'VIDEO') return;
      recordDiagnosticEvent(`video_${type}`, snapshotVideo(event.target));
    }, true);
  });

  Object.defineProperty(window, '__PQI_DIAGNOSTICS__', {
    configurable: true,
    value: Object.freeze({ snapshot: getDiagnosticSnapshot })
  });

  recordDiagnosticEvent('diagnostics_initialized');
}
