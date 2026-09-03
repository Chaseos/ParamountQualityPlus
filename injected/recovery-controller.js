const RECOVERY_FAILURE_THRESHOLD = 2;

// Owns recovery state for one injected playback session. Keeping this policy
// independent of fetch/XHR interception makes the failure threshold and
// new-content reset behavior directly testable.
export function createRecoveryController({ canFallbackToOriginal, postRecovery, recordDiagnosticEvent, recordCheckpoint }) {
  let recoveryRequested = false;
  const committedFailureCounts = new Map();

  function failureKey(plan) {
    return plan?.streamKey || plan?.rejectionKey || 'unknown';
  }

  function requestRecovery(plan, detail = null) {
    if (recoveryRequested || canFallbackToOriginal(plan)) return false;

    const key = failureKey(plan);
    const failureCount = (committedFailureCounts.get(key) || 0) + 1;
    committedFailureCounts.set(key, failureCount);
    if (failureCount < RECOVERY_FAILURE_THRESHOLD) {
      recordDiagnosticEvent('recovery_deferred', { failureCount, detail });
      recordCheckpoint('recovery_deferred', plan, { failureCount, detail });
      return false;
    }

    recoveryRequested = true;
    recordCheckpoint('recovery_requested', plan, { failureCount, detail });
    postRecovery({
      streamKey: plan?.streamKey || null,
      strategy: plan?.strategy || null,
      detail
    });
    return true;
  }

  function recordRewriteSuccess(plan) {
    const key = plan?.streamKey || plan?.rejectionKey;
    if (key) committedFailureCounts.delete(key);
  }

  function reset() {
    committedFailureCounts.clear();
    recoveryRequested = false;
  }

  return { requestRecovery, recordRewriteSuccess, reset };
}
