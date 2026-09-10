# Indexed DASH candidate validation

## Implemented boundary

The single-file branch recognizes `_cenc_fmp4_dash/` on the two existing
Paramount VOD hosts. Quality selection additionally requires an unambiguous,
static DASH manifest with indexed program-video representations. It filters
original representation nodes, retaining their URLs, initialization/index
ranges, DRM and timing. It does not translate byte ranges or invent media URLs.

The original ladder remains available to the popup. Only this branch requests a
reload on an effective quality change, with episode-scoped position restoration.
Unsupported addressing, mixed program formats and absent target heights keep the
original manifest. MP4 files in this package are never speculatively prefetched
or passed through the ordinary media URL rewriter.

## Automated evidence

The fixtures in `tests/fixtures/indexed-dash.js` are **synthetic**, not captures
from the reporter. Tests cover selection, inherited addressing, original metadata,
multiple periods/codecs, excluded media, fail-open cases, prefetching, reload
coordination, position restoration, recovery and transport response semantics.
Transport tests use JSDOM's XMLHttpRequest against a loopback HTTP server, plus
Node's Request/Response implementation. These are not protected-video decode tests.

Run `npm test -- --runInBand --silent`. Loopback-server access is needed for the
transport tests. The package tests build Chromium, Firefox and Safari and check
their resource graphs and existing Safari behavior. `npm run build` also produces
all three candidate archives without changing their version numbers.

## Live checks on 2026-09-10

- Chrome Lioness S3E2: 1080p -> 540p -> 1080p verified using decoded video dimensions
  after the unpacked extension was reloaded. Existing switching did not reload the
  page. This session still receives `_cenc_precon_dash` segmented media.
- Safari's installed native extension played the episode at 1080p. A manual
  downgrade was not confirmed; this is an incomplete switching smoke test. The
  installed Safari app was not rebuilt/reinstalled during this task. Candidate
  Safari packaging and native switching are covered by automated tests.
- The reporter's indexed MPD and real byte-range requests have **not** been
  captured. The candidate must not be described as a verified fix for that session.

### Alternate MP4 reachability

A URL reconstructed from the screenshot and the known episode ID was checked
directly with curl (not through Chrome's player):

`https://vod.pplus.paramount.tech/intl_vms/2026/06/10/ALVE01KTSC0QNME2JAKFQW7D3XQN8X/4389134_cenc_fmp4_dash/PARPUS_LIONESS_302_V1_c24_540p_4342061_2000.mp4`

HEAD returned `200 OK`, `Content-Type: video/mp4`, `Content-Length: 175845282`
and `Accept-Ranges: bytes`. A GET with `Range: bytes=0-1023` returned
`206 Partial Content`, 1024 bytes, and
`Content-Range: bytes 0-1023/175845282`. No cookies or authorization were supplied.
This establishes file availability and range support, not the reporter's manifest
addressing, DRM compatibility, or successful playback. Only the first 1 KB was
retrieved. A meaningful player substitution still requires the original affected
MPD with its initialization/index ranges and protection metadata.

Follow-up candidate probes in the same directory:

| Filename suffix | HEAD result |
| --- | --- |
| `c24_540p_4342061_2000.mp4` (control) | 200 |
| `c24_1080p_4342061_2000.mp4` | 404 |
| `c20_1080p_4342061_5400.mp4` | 200 |
| `c23_1080p_4342061_5400.mp4` | 404 |

The successful 1080p candidate returned `206 Partial Content` for bytes 0-65535,
with `Content-Range: bytes 0-65535/1045744653`. Parsing those bytes found a
complete `moov` box, a `tkhd` declaring **1920 x 1080**, two `pssh` boxes, and
a complete `sidx` at offset 1639 (6356 bytes), followed by `moof` at 7995.
This verifies an actual 1080p indexed MP4 exists in the affected package, rather
than relying on its filename alone. It does not verify decoded playback or the
affected MPD. Candidate URLs were generated only for this diagnostic probe;
production filtering continues to retain URLs supplied by the original manifest.

### Real package manifest retrieved

The package's public `stream.mpd` was successfully retrieved on 2026-09-10:

`https://vod.pplus.paramount.tech/intl_vms/2026/06/10/ALVE01KTSC0QNME2JAKFQW7D3XQN8X/4389134_cenc_fmp4_dash/stream.mpd`

It is saved verbatim as `tests/fixtures/lioness-single-file-captured.mpd` and
exercised by `tests/indexed_captured_manifest.test.js` (three passing tests).
This is a real package manifest, not a capture of the reporter's session response.
It contains the exact reported 540p filename and the verified AVC 1080p filename.
The latter's initialization range is `0-1638` and index range is `1639-7994`,
matching the MP4 boxes inspected above.

The existing implementation accepts this manifest, selects 1080p or 540p,
preserves the full popup ladder, retains selected representation nodes and DRM,
and leaves audio, captions and thumbnail adaptation sets unchanged. Auto returns
the original text. The 1080p output retains three codec variants including AVC;
Force Highest selects 2160p, which this package provides only as HDR variants.
Codec/DRM compatibility and decoded playback still require player validation.

## Required before release

If local playback substitution cannot reproduce their session, ask the reporter
for the affected MPD response from DevTools Network (filter
`mpd`, open the request, copy the Response to a text file), and just the `Range`
request header, response status and `Content-Range` response header from one
video MP4 request. Do not request a complete HAR, cookies or authorization headers;
redact signed URL query values before sharing a manifest.

Compare any session-specific response with the captured package MPD. If it is not the supported
SegmentBase subset, keep it unchanged and revise support using that evidence.
Test the candidate on that stream: decoded 1080p, correct index/media ranges,
seeking, manual changes, Force Highest, return to Auto and recovery. Also repeat
Safari switching with the newly built Safari package before publishing it.
