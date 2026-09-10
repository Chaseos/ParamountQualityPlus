# Quality mismatch monitor

The injected monitor compares the effective selected height, successful final
response URLs, and decoded video while the popup is closed. It does not publish
a new ladder, change preferences, or request a reload. Existing network-error
recovery remains separate.

## Confirmation

Sampling runs every two seconds for active selections in known Paramount VOD
packages. It requires one visible video with positively confirmed non-ad status,
advancing playback, and a finite duration. Pauses, stalls, seeks, hidden pages,
video replacement, unknown ad state, and scheduler gaps discard the evidence
window. Unsupported live/HLS/Safari native paths receive no corrective action.

A mismatch requires 30 seconds of persistent decoded disagreement, three distinct
successful media observations collected in the current window, and playback past
the initial contiguous buffer end plus two seconds. That buffer boundary is fixed
rather than extended by subsequent buffering. The latest request evidence must be
no more than 15 seconds old. Heights within 16 pixels of the target are inconclusive.
Three consecutive matching eligible samples confirm recovery.

Evidence comes from final response URLs and exact representation-directory/file
matches, or explicit resolution markers. Intended rewrite heights and bitrate
estimates are not evidence. Initialization, audio, ads, prefetches, cancelled
requests, ambiguous mappings and source-file range requests are excluded. Indexed
MP4 ranges qualify only when the active manifest confirms they are beyond that
file's initialization and index ranges.

## Corrective boundary

A retrieval mismatch can authorize the existing validated package discovery even
when the ordinary planner reports a usable mapping. Only an independently
validated segmented mapping can precede that mapping. A previously ineffective
source-to-target directory mapping is not retried as a new correction.

There is one corrective opportunity per effective selection, without resetting
the discovery module's package/session request budget. The correction stays active
for subsequent segments; it is cleared by a genuine selection/session change or a
later authoritative manifest. Later authoritative manifests restart evaluation
but do not replenish the corrective opportunity for an unchanged selection.
Failure or persistent mismatch becomes an unresolved diagnostic rather than a
reload loop. Decode mismatches and indexed mismatches are diagnostic-only.

`quality_monitor` diagnostic transitions include selected, retrieved and decoded
heights, evidence count, eligible time, buffer boundary, strategy and sanitized
paths. No popup or public configuration interface changed.

## Validation and limitations

Full JavaScript verification passes: **41 suites, 418 tests**, including Chromium,
Firefox, and Safari packaging checks. All packaged monitor modules match the
source, versions are 1.31, and `git diff --check` passes.

Deterministic tests cover timing and buffer drainage, ordering/deduplication,
stale observations, interruption and ad gating, padding, manual/Force Highest/Auto
selection, final-URL mismatches, different validated corrections, identical
ineffective mappings, activation budgets and authoritative-manifest precedence.
The fetch/XHR integration harness uses the real captured segmented Lioness MPD,
simulated responses, and simulated decoded dimensions. It is not a protected
playback test.

Live Chrome validation on Lioness S3E2 passed on September 10, 2026:

- Normal manual switching decoded 540 → 1080 → 540 with no discovery.
- A temporary startup transport shim made an apparently successful 1080 mapping
  return actual 540 media. The monitor confirmed retrieval mismatch after 32
  eligible seconds with three 540 observations and decoded 540.
- Diagnostics progressed through discovery started, validated, fallback activated,
  and matched. Actual protected playback decoded 1080 without a page reload.
- Seeking forward 90 seconds retained decoded 1080 and resumed advancing playback.
- Restoring Auto resumed decoded 540 without a playback error or another probe.

The shim and runtime stale mapping were test-only; the production source was
restored and all three packages rebuilt afterward. Saved preferences were not
modified. An earlier late-installed shim failed to intercept a player-cached
transport and caused a 404; that attempt is not counted as mismatch validation.

This verifies controlled recovery on the local segmented package, not the
reporter's session or its indexed single-file playback. Indexed mismatches remain
diagnostic-only. Safari native playback was not live-tested in this validation;
its exclusion and existing behavior are covered by the JavaScript suites.

Review follow-up: regression tests confirmed that rejected manifests could discard
fallback state and redirected media could authorize discovery against an unproven
source. Accepted program ladders now control invalidation; ad and malformed
responses preserve the fallback. Fetch and XHR discovery require matching requested
and final media origin/path, allowing query-only telemetry differences. Release
version was explicitly advanced to 1.31 before committing to develop.
