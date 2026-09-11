# Paramount error 2103 investigation — 2026-09-10

## Confirmed findings

- The local Chrome session decoded Lioness S3E2 at 1080p while logging the same uBlock `Failed to fetch` stack seen in the reporter's screenshot. That stack alone does not identify the playback failure or establish extension interference.
- Paramount's deployed Smart Tag maps Shaka's **MANIFEST category** to `SHAKA_PARSE_ERROR` / **2103**. It maps the DRM category separately to 3304. The original Shaka error is carried in `event.detail.error.cause` on the Avia player's `error` event. A 2103 is therefore not enough to conclude malformed XML, an incorrect media URL, or a DRM failure.
- Shaka **4012, RESTRICTIONS_CANNOT_BE_MET**, belongs to the MANIFEST category. Its restriction check can fail when no variant is allowed by both the application and the key system. Its diagnostic data distinguishes application restrictions, missing keys, and restricted key statuses.
- The existing indexed recovery observed failed selected-media requests and native video errors after receiving selected media. Neither is guaranteed when the player rejects the manifest before playback starts. The quality mismatch monitor also cannot accumulate advancing-playback evidence in that situation. Package discovery intentionally cannot replace indexed manifests or redirect byte ranges.

Inspected deployed sources:

- [Smart Tag 1.41.3](https://player-services.paramountplus.com/1.41.3/smart-tag/smart.tag.js): `createPlayerError`, `SHAKA_PARSE_ERROR`, error notification.
- [Avia 2.62.0](https://player-services.paramountplus.com/assets/dependencies/vtg/avia/2.62.0/avia.min.js?cb=67): player error event and original cause.
- [Shaka 4.16.24](https://player-services.paramountplus.com/assets/dependencies/shaka/4.16.24/shaka-player.compiled.js?cb=67): manifest parser and restriction check.

## Package and parser trials

The public Lioness package `4389134_cenc_fmp4_dash/stream.mpd` matches the captured fixture `tests/fixtures/lioness-single-file-captured.mpd`. This is a **package capture, not the reporter's session manifest**.

Requests using the manifest-declared initialization, index, and sample media ranges returned HTTP 206 for the AVC 540p, 720p, and 1080p files. The files have distinct byte ranges and valid SIDX indexes. The HD files use a different encryption key ID from the 540p file. Availability does not prove that the reporter's browser can obtain a usable license for HD.

A temporary Node/JSDOM harness loaded the exact deployed Shaka build and parsed the full package plus the production filter's 540p, 720p, and 1080p outputs. All four parsed successfully. The harness then **simulated** HD variants being unusable by the key system and called Shaka's restriction checker:

| Manifest | Parser variants | Simulated restriction result |
| --- | ---: | --- |
| Original | 100 | Playable variants remain |
| 540p filtered | 5 | Playable variants remain |
| 720p filtered | 15 | Shaka 4012, category 4 |
| 1080p filtered | 15 | Shaka 4012, category 4 |

This establishes a plausible mechanism: removing SD alternatives can expose an HD restriction as 2103. It does **not** establish that the reporter has error 4012, prove entitlement restrictions, or validate browser decoding of the indexed package. The harness's restriction injection was temporary and is not packaged.

### Follow-up: verify successful responses are actual media

A fresh bounded HTTP/body audit confirmed the package manifest returns 200 with XML (41,416 bytes; SHA-256 `07f8add18ee72d967cb985b6470503669e22dface36eb48577f651401e1ff0ce`). No redirects occurred for the checked manifest or media URLs.

- A normal non-range request to the declared AVC 1080p URL returned **200**, `video/mp4`, a declared length of **1,045,744,653 bytes**, and an actual `ftyp` MP4 header. Only the first 128 bytes were read before closing the response.
- Range reads contained `ftyp`, `moov`, `sidx`, and `moof` boxes. Both the track header and encrypted video sample entry identify the AVC 1080p file as **1920×1080**; its original sample format is `avc1`.
- Its 527 SIDX references total approximately 3,162.451 seconds. The computed end of the final indexed segment exactly matches the server's total file size.
- Segments 0, 263, and 526 were sampled using their own calculated offsets. All returned **206**, the requested Content-Range, distinct bytes, and a `moof` header. The same checks passed for AVC 720p and 540p.
- The package's Dolby Vision and HEVC/HDR 1080p alternatives also contain 1920×1080 track/sample dimensions and indexes ending at their respective total file sizes. This verifies container metadata and indexing, not codec support or decryption.
- One deliberately nonexistent filename returned **404**, providing a negative control. A MIME type alone is insufficient; error responses can also carry a video MIME type.

These are not error pages disguised as successful media responses. They establish that the **manifest-declared** files and sampled ranges are available. They do not establish what the reporter's session manifest contains, which track it selects, or what its license permits. The production single-file branch passes media URLs through (`single-file-manifest-selection`); quality is selected by retaining original manifest representation nodes, not generating replacement filenames.

## Candidate recovery change

`injected/indexed-session.js` now subscribes to the single matching non-ad Avia player while an indexed manifest has an active filtered height. A fatal 2103 with an original Shaka MANIFEST error requests the existing original-stream recovery even before media arrives or a native video error occurs.

The existing recovery controller limits the request to once per session. The content bridge stages Auto for the recovery reload without changing saved quality preferences. The observer ignores Auto, unrelated resources, ads, nonfatal errors, other error categories, and stale bindings. Observer disposal or diagnostic storage failures must not interrupt playback recovery.

This restores the original selection of playable tracks; it cannot manufacture an HD entitlement or repair an unknown manifest defect. Segmented fallback behavior, Safari native switching, MP4 byte ranges, and the mismatch monitor are unchanged.

Before recovery reloads, a small record is saved under `pqiIndexedFailure` in session storage: episode path, timestamp, selected height, player and Shaka codes, application-restriction flag, missing-key count, and allowlisted restricted-key statuses. No request queries, license bodies, key IDs, or raw error payloads are recorded. The record persists until overwritten or the tab session ends; use its path and timestamp to identify the attempt.

With this candidate loaded, one reproduction followed by this Console command collects the underlying failure after recovery:

```js
copy(JSON.stringify(window.__PQI_DIAGNOSTICS__.report(), null, 2))
```

An absent previousFailure is inconclusive: the player may not expose the expected event, resource association may be unavailable, or the error may be outside this narrow recovery branch.

## Validation and release boundary

- Regression tests cover failure before media/native errors, one recovery request, Auto/ad/resource guards, stale bindings, sanitized persistence, unavailable storage, and observer setup/disposal failures.
- Exact deployed Shaka parsing and simulated restriction checks passed as described above.
- Actual reporter-session HD playback and the new player-error recovery have not been validated end to end in Chrome. The observed working local session uses segmented packaging.
- The original investigation did not change the version. The subsequent authorized diagnostic build is 1.32; no store publication is included.

## Diagnostic build 1.32

The report command above now returns both `current` and `previousFailure`, with timestamps, episode association, extension version and browser information. It preserves the failure snapshot before posting the original-stream recovery message. The old small `pqiIndexedFailure` record remains available for compatibility.

The bounded report includes up to 80 original program-video representation summaries, indicating retained/removed tracks, periods, codec, addressing, initialization/index ranges and protected status; up to 40 selected-file request observations with sanitized final paths, HTTP status and available Range/Content-Range values; up to four video/player snapshots with decoded dimensions, Shaka restrictions, track/variant eligibility and aggregate key statuses; and up to 60 allowlisted diagnostic event summaries. The saved report is capped at 128 KiB. Missing, unavailable or unexposed information is reported as null. Numeric unbounded restrictions (Infinity) are represented as null.

Manifest bodies, authorization headers, authentication queries, license configuration/payloads, DRM key IDs and key material are not exported. Collection makes no network requests and does not alter player restrictions or tracks. The saved failure survives reloads until another failure replaces it or the tab session ends; `previousFailureMatchesPage` distinguishes an older episode. Resetting live diagnostics clears the current manifest/request context without deleting the saved failure. Storage or player API failures must not stop recovery.

Send the Chromium 1.32 test build, have the reporter reproduce once and run the report command after any recovery reload, then send the copied JSON. A HAR remains useful if the manifest summary or player cause cannot explain the failure; this report is not a full network/body capture.
