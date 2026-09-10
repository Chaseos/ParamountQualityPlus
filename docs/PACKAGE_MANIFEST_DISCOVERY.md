# Package-manifest discovery fallback

## Behavior

Successful program-video requests in known Paramount VOD packages can trigger
one background request to that package's `stream.mpd` when an active quality
selection has no usable ordinary mapping. Requests use the original fetch,
omit credentials, reject redirects, omit source query parameters, time out after
five seconds, and stop reading after two MiB. Playback does not wait for them.
Auto, working mappings, audio, ads, live streams, and initialization-only
observations do not trigger discovery. A source without a height marker requires
explicit CMCD video signaling.

The parsed package data is separate from the player's ladder and has
`package-manifest` provenance. Failed probes are not retried within that playback
session. Episode changes invalidate pending work and cached results; a later
player manifest invalidates supplementary mappings without restarting probes.

Segmented fallback requires an exact, unique source URL and numbered-timeline
period match. Source and target must agree on codec, MIME type, frame rate/aspect
metadata, encryption identity/protection metadata, initialization filename
structure, timescale, presentation offset, and timeline runs. Target paths come
from the manifest, including unfamiliar representation-directory names. Missing
or unsupported metadata preserves the existing request behavior. Discovery is
preferred over filename inference only after these checks succeed.

The current subset supports `seg_$Number$.m4s` with a finite SegmentTimeline and
`init.m4s`, `init.m4v`, or `init.mp4` in the representation directory. Other
addressing (including open-ended repeats) remains unsupported. The existing
filename inference still operates when supplementary mapping cannot help.

Single-file discovery validates the observed file against the package MPD only
for diagnostics. It does not publish a new ladder, alter byte ranges, redirect
MP4 requests, replace a session manifest, or reload playback. Existing indexed
manifest filtering remains the quality-control mechanism for those streams.

## Evidence

`tests/fixtures/lioness-segmented-captured.mpd` was retrieved from:

`https://vod.pplus.paramount.tech/intl_vms/2026/06/10/ALVE01KTSC0QNME2JAKFQW7D3XQN8X/4388933_cenc_precon_dash/stream.mpd`

This is the public package MPD captured on 2026-09-10, not a reporter-session
capture. It contains four finite video periods, compatible 540p/1080p AVC tracks,
and their declared segment/initialization paths. The indexed package capture
and retrieval evidence are documented in `INDEXED_DASH_VALIDATION.md`.

The full JavaScript suite currently passes: 38 suites, 372 tests, including
Chromium, Firefox, and Safari packaging checks. Added checks exercise pure parsing,
real period boundaries, missing targets and incompatible metadata, bounded
networking, cancellation/stale responses, negative caching, shared fetch/XHR
state, unchanged Auto and popup state, range passthrough, and original-stream
recovery. Discovery XHR unit tests use an event-driven test double; existing
transport tests additionally exercise native JSDOM XMLHttpRequest.

## Live validation

Live candidate validation is pending extension reload. In an isolated Chrome
episode tab, first verify normal 540p/1080p switching. Temporarily clear only the
injected runtime's representation store and set a manual 1080p preference, leaving
the player's manifest intact. Check that a successful original request triggers
one `stream.mpd` discovery, subsequent media uses manifest-declared 1080p paths,
and decoded dimensions reach 1920 x 1080. Seek across a period boundary, restore
Auto, and restore the original runtime settings. Closing the test tab removes
the temporary state. Do not ship a mapping-suppression hook.

Before release, confirm decoded playback and seeking through this fallback;
HTTP retrieval and fixture tests alone do not establish protected playback.
Safari native implementation files are unchanged. No version bump, commit, push,
or publication is part of this implementation.
