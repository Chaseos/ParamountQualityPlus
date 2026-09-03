# Chrome playback verification

Load the unpacked Chromium build, open Paramount+ in Chrome, and open DevTools
on the player page. Keep **Info** messages visible and preserve the console
log while moving through each scenario below. The extension emits concise
`[PQI checkpoint]` messages and retains the same events in
`window.__PQI_DIAGNOSTICS__.snapshot()`.

| Test point | Action | Expected checkpoints |
| --- | --- | --- |
| Configuration handoff | Reload a playback page with Force Highest Quality on, then toggle it off and on. | `configuration_restored`, then `configuration_applied` for each toggle. |
| New program boundary | Start a different movie or episode without closing the tab. | Exactly one `stream_reset` for the new title before its ladder appears. |
| Ladder discovery | Start VOD, live, and ad-supported playback. | `ladder_ready` with the stream family, representation count, and max height. |
| Rewrite selection | Play with Force Highest Quality enabled. | `rewrite_planned`, followed by `rewrite_succeeded` for the matching media role. |
| Safe failure handling | Use a stream that rejects an override, or block the rewritten request in DevTools. | One `recovery_deferred` after the first committed failure; `recovery_requested` only after a second consecutive failure. |
| No stale popup state | Switch titles while the popup is open. | Resolution, bitrate, and the quality list clear until the new `ladder_ready` data arrives. |

Run this in the page console to collect the structured result without relying
on visual quality alone:

```js
window.__PQI_DIAGNOSTICS__.snapshot()
```

The `recentEvents` list includes checkpoint details, request outcome counters,
and a compact video playback snapshot. URLs in request diagnostics exclude
query strings and fragments.

## Recommended playback matrix

Use these titles after loading `dist/chromium` as an unpacked extension. They
are the real stream shapes covered by the captured regression fixtures, rather
than generic placeholders.

| Video | Primary check |
| --- | --- |
| *Avatar: The Last Airbender* — Aang | Legacy catalog VOD, validated c23 fallback, initialization/media continuity. |
| *Starfleet Academy* S1E1 | Modern VOD path and max-quality fallback. |
| *Strange New Worlds* S1E1 and S4E1 | Older and newer VOD paths; switch between them to confirm one clean reset. |
| *Survivor* S50E8 | c23 profile selection for the Survivor pipeline. |
| *The Wolf of Wall Street* | Legacy mastered VOD profile. |
| *Sleepy Hollow* | Legacy plain numeric-tier (4500) fallback. |
| *Mean Girls* (2024), *Roofman*, *NCIS: Tony & Ziva* S1E1, and *The Madison* S1E4 | Modern representative VOD coverage. |
| Any currently available Paramount+ live channel | DASH/HLS manifest stays authoritative while subsequent media may be selected. |

For each VOD title, verify the `configuration_*`, `stream_reset`,
`ladder_ready`, `rewrite_planned`, and `rewrite_succeeded` sequence. Run the
intentional-failure case on one non-critical VOD title only, then verify the
two-step recovery sequence described above.
