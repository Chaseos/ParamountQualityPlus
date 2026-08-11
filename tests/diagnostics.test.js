import {
  getDiagnosticSnapshot,
  initDiagnostics,
  recordDiagnosticEvent,
  recordRequestAttempt,
  resetDiagnostics
} from '../injected/diagnostics.js';

describe('Playback diagnostics', () => {
  beforeEach(() => {
    resetDiagnostics();
  });

  test('records sanitized network attempts without query tokens', () => {
    recordRequestAttempt({
      transport: 'fetch',
      category: 'segment',
      url: 'https://cdn.example/video/seg_10.m4s?token=secret&CMCD=br%3D5400',
      status: 200,
      ok: true,
      outcome: 'success',
      durationMs: 12.34
    });

    const snapshot = getDiagnosticSnapshot();
    const event = snapshot.recentEvents.find(item => item.type === 'network_attempt');

    expect(event.detail.url).toBe('https://cdn.example/video/seg_10.m4s');
    expect(event.detail.durationMs).toBe(12.3);
    expect(snapshot.counters.segment_attempts).toBe(1);
    expect(snapshot.counters.successful_attempts).toBe(1);
  });

  test('counts retry attempts and keeps arbitrary diagnostic events', () => {
    recordRequestAttempt({
      transport: 'fetch',
      category: 'manifest',
      url: 'https://cdn.example/manifest.mpd',
      attempt: 2,
      maxAttempts: 3,
      status: 503,
      ok: false,
      outcome: 'http-error',
      durationMs: 50
    });
    recordDiagnosticEvent('rewrite_result', { outcome: 'failure' });

    const snapshot = getDiagnosticSnapshot();
    expect(snapshot.counters.retry_attempts).toBe(1);
    expect(snapshot.counters.failed_attempts).toBe(1);
    expect(snapshot.counters.rewrite_result).toBe(1);
  });

  test('exposes a read-only page snapshot API', () => {
    initDiagnostics();

    expect(window.__PQI_DIAGNOSTICS__.snapshot()).toEqual(
      expect.objectContaining({ version: 1, counters: expect.any(Object) })
    );
    expect(Object.isFrozen(window.__PQI_DIAGNOSTICS__)).toBe(true);
  });
});
