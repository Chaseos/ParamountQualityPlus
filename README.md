# Paramount+ Quality Controller

A Chrome extension that surfaces real-time streaming quality information on Paramount+, including resolution, bitrate, and available representations. The extension injects lightweight instrumentation to inspect manifests/segments and displays status in a polished popup UI. This README highlights what users can expect while also giving contributors a quick orientation to the codebase.

## Features
- **Live Stream Detection**: Finds active video streams on paramountplus.com and tracks bitrate, resolution, and maximum available bitrate.
- **Resolution Estimation**: Approximates resolution tiers when manifest data is limited or unavailable.
- **Quality Controls Insight**: Indicates whether a stream is limited (no quality options) and whether max quality is being forced.
- **Rich Popup UI**: Presents a live status indicator, stats cards, and representation list in the popup.
- **Proven Parsing Helpers**: Jest coverage for manifest parsing, URL analysis, and bitrate-to-resolution estimation.

## Supported Content
- **On-Demand VOD (Episodes & Movies)**: Observes both MPEG-DASH (`.mpd`) and HLS (`.m3u8`) manifests used for standard Paramount+ playback, listing detected video representations and tracking segment-level bitrate/CMCD data.
- **Google DAI Live Streams**: Understands the variant-based HLS playlists used for live channels and events, including extracting DAI variant IDs, inferring the active playlist quality, and rewriting variant URLs when forcing max quality.
- **Manifest-Limited Streams**: Continues to surface telemetry when only segment requests are visible (e.g., ad breaks or limited live feeds) by estimating resolution/bitrate from segment paths and CMCD hints while flagging the stream as limited.

## Development
- **Project layout**:
  - [`content.js`](./content.js) is the Chrome content script that bridges the injected page logic to the popup, keeps a rolling stream state, and relays storage updates to the page context.
  - [`injected/`](./injected) contains the page-level instrumentation loaded as a module. [`index.js`](./injected/index.js) wires together network interception, manifest parsing, URL analysis, and adaptive quality rewriting helpers defined in sibling modules like [`network-hooks.js`](./injected/network-hooks.js), [`manifest-parser.js`](./injected/manifest-parser.js), and [`rewriter.js`](./injected/rewriter.js).
  - [`popup.html`](./popup.html) and [`popup.js`](./popup.js) render the status UI, poll the active tab for stream state, and let users toggle automatic vs. forced quality tiers.
  - Extension metadata lives in [`manifest.json`](./manifest.json), and the icon used in the toolbar is [`icon.png`](./icon.png).

- **Local setup**:
  - Install dependencies once with `npm install` (the project uses native ES modules and Jest with JSDOM for tests).
  - Load the repository folder as an unpacked extension from `chrome://extensions` with Developer Mode enabled; changes to scripts require reloading the extension plus a page refresh on Paramount+.

- **Testing**:
  - The Jest suite exercises manifest parsing, URL analysis, and quality rewriting logic in `injected/`. Run it with:
    ```bash
    npm test
    ```
  - Tests live in [`tests/`](./tests) alongside fixtures that mirror live DAI and VOD manifest shapes.

## Notes
- Host permissions are limited to `*.paramountplus.com` and `*.paramount.tech` for quality inspection.
- The extension respects both DASH (`.mpd`) and HLS (`.m3u8`) manifest formats.
