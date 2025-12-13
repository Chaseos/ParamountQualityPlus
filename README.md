# Paramount+ Quality Controller

A Chrome extension that surfaces real-time streaming quality information on Paramount+, including resolution, bitrate, and available representations. The extension injects lightweight instrumentation to inspect manifests/segments and displays status in a polished popup UI. This README highlights what users can expect while also giving contributors a quick orientation to the codebase.

## Features
- **Live Stream Detection**: Finds active video streams on paramountplus.com and tracks bitrate, resolution, and maximum available bitrate.
- **Resolution Estimation**: Approximates resolution tiers when manifest data is limited or unavailable.
- **Quality Controls Insight**: Indicates whether a stream is limited (no quality options) and whether max quality is being forced.
- **Rich Popup UI**: Presents a live status indicator, stats cards, and representation list in the popup.
- **Proven Parsing Helpers**: Jest coverage for manifest parsing, URL analysis, and bitrate-to-resolution estimation.

## Using the Extension
- Load the unpacked extension via `chrome://extensions` (Developer Mode) and select this repository folder.
- Start playback on Paramount+ and open the popup to view real-time metrics and available quality tiers.
- When multiple quality options exist, the popup highlights the current selection and max limits.

## Supported Content
- **On-Demand VOD (Episodes & Movies)**: Observes both MPEG-DASH (`.mpd`) and HLS (`.m3u8`) manifests used for standard Paramount+ playback, listing detected video representations and tracking segment-level bitrate/CMCD data.
- **Google DAI Live Streams**: Understands the variant-based HLS playlists used for live channels and events, including extracting DAI variant IDs, inferring the active playlist quality, and rewriting variant URLs when forcing max quality.
- **Manifest-Limited Streams**: Continues to surface telemetry when only segment requests are visible (e.g., ad breaks or limited live feeds) by estimating resolution/bitrate from segment paths and CMCD hints while flagging the stream as limited.

## Development
- Main logic lives in [`content.js`](./content.js) (content script) and [`injected.js`](./injected.js) (page instrumentation).
- The popup UI is defined in [`popup.html`](./popup.html) with behavior in [`popup.js`](./popup.js).
- Update icons in the [`icons/`](./icons) directory and extension metadata in [`manifest.json`](./manifest.json).

### Testing
Run the Jest suite:
```bash
npm test
```

Tests focus on manifest parsing and quality estimation helpers used by `injected.js`.

## Notes
- Host permissions are limited to `*.paramountplus.com` and `*.paramount.tech` for quality inspection.
- The extension respects both DASH (`.mpd`) and HLS (`.m3u8`) manifest formats.
