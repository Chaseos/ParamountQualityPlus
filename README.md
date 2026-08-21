# Paramount Quality+

<p align="center">
  <img src="icon.png" alt="Paramount Quality+ icon" width="128">
</p>

Paramount Quality+ is a free, open-source browser extension for seeing and controlling the video quality Paramount+ actually delivers. Its lightweight popup reports the active resolution and bitrate, shows the qualities available for the current stream, and lets you use automatic playback, choose a specific resolution, or force the highest available quality.

It supports movies, episodes, older catalog titles, live TV channels, live events, and sports on `paramountplus.com`.

## Install

| Browser | Store |
| --- | --- |
| Google Chrome and Chromium browsers | [Chrome Web Store](https://chromewebstore.google.com/detail/paramount-quality%2B/jdhjjddhdmhphkfgcfclekdngihnoann) |
| Microsoft Edge | [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/paramount-quality/cpaekgjghoegidknadojliokbcldohjb) |
| Mozilla Firefox | [Firefox Browser Add-ons](https://addons.mozilla.org/firefox/addon/paramount-quality/) |
| Opera | [Opera Add-ons](https://addons.opera.com/extensions/details/paramount-quality/) |
| Naver Whale | [Whale Store](https://store.whale.naver.com/detail/lgkdongnlhpcjjopojpoabfkhcoenolg) |

Brave and other Chromium-based browsers can install the extension from the Chrome Web Store when their browser supports Chrome extensions.

## Features

<img width="371" height="598" alt="Paramount Quality+ Main Popup" src="https://github.com/user-attachments/assets/0d543e8c-9fb6-4270-993a-0519645f6119" />


- **Real-time playback details:** See the active resolution and bitrate instead of relying on the player's quality label.
- **Three quality modes:** Leave Paramount+ on Auto, select an available resolution, or use Force Max Quality to prefer the highest representation (1080p or higher when offered by Paramount+).
- **Available-quality list:** Inspect the resolution and bitrate ladder exposed for the current title or live stream.
- **Remembered preferences:** Quality mode, preferred resolution, and advanced network settings are saved with browser extension storage. A preferred height is remapped when representation IDs differ between titles.
- **Broad stream support:** Detects and controls MPEG-DASH and HLS playback across on-demand content, live DASH streams, and Google DAI live channels and events.
- **Resilient catalog handling:** Recognizes newer and legacy Paramount+/CBS video paths, estimates quality from stream telemetry when a manifest is unavailable, validates inferred max-quality paths, and safely returns to the original stream when a rewrite is rejected.
- **Live-stream switching:** Applies live quality changes with a controlled reload so the selected mode is active before playback requests begin.
- **Optional network recovery:** Retries eligible failed playback requests with a configurable limit of 1–10 attempts.
- **Optional buffer prefetching:** Preloads 1–20 eligible upcoming segments to help reduce buffering while avoiding unsupported, encrypted, ad, and live-stream requests.
- **Location-permission guidance:** Explains when blocked site location may prevent Paramount+ from exposing quality options and can trigger the site's permission request.
- **Automatic limited-mode detection:** Disables unavailable controls for recently archived live streams while Paramount+ is still processing the on-demand version.
- **Ad-blocker-friendly and fail-open behavior:** Playback requests that cannot be safely inspected or changed continue on their original URL.
- **Private by design:** No personal data, browsing history, analytics, or telemetry is collected or transmitted by the extension. See the [privacy policy](PRIVACYPOLICY.md).

Quality availability still depends on the title, subscription, region, device, DRM support, and representations supplied by Paramount+.

## Languages

The extension popup and store-facing extension metadata are localized in seven languages across eight locale catalogs:

| Language | Locale |
| --- | --- |
| Deutsch | `de` |
| English | `en` |
| Español (España) | `es` |
| Español (Latinoamérica y el Caribe) | `es_419` |
| Français | `fr` |
| Italiano | `it` |
| 한국어 | `ko` |
| Português (Brasil) | `pt_BR` |

The browser selects the matching locale automatically and falls back to English when no translation is available.

## Supported playback

- **On-demand movies and episodes:** Parses DASH (`.mpd`) and HLS (`.m3u8`) manifests, tracks media segments and CMCD data, and keeps initialization and media requests on the same selected representation.
- **Live channels, events, and sports:** Handles live DASH and Google DAI HLS variant playlists, including active-quality detection and signed variant URL switching.
- **Manifest-limited or legacy streams:** Uses verified URL and bitrate inference only when a usable manifest ladder is unavailable. A failed candidate is rejected and playback continues on the original representation.
- **Ads and non-video media:** Filters ad periods, audio, thumbnails, and preview tracks out of the selectable video-quality list.

## Troubleshooting

- Start playback on `paramountplus.com`, then open Paramount Quality+ from the browser toolbar.
- Quality changes can take 10–20 seconds to appear while the existing buffer clears. Live playback may reload once when the selected mode changes.
- If no quality options appear, allow location access for Paramount+ when prompted and refresh playback. Some titles or recently ended live streams may not expose a selectable quality ladder.
- In Brave, enable Widevine DRM and allow the permissions Paramount+ needs. If playback or detection is blocked, set Shields to Standard for `paramountplus.com` or disable Shields for that site, then refresh.

## Development

### Requirements

- A current Node.js release
- npm
- A browser that can load unpacked extensions
- The `zip` command when creating release archives

### Run locally

```bash
npm install
npm test
```

For Chrome, Edge, Opera, Brave, or Whale, open the browser's extensions page, enable Developer Mode, and load this repository as an unpacked extension. For Firefox, use **Debug Add-ons**, choose **Load Temporary Add-on**, and select `manifest.json`.

After changing extension code, reload the extension and refresh the active Paramount+ page.

### Build packages

```bash
npm run build
```

The build validates the injected module graph, creates browser-specific manifests, and writes unpacked and zipped packages to `dist/chromium/` and `dist/firefox/`.

### Project structure

- [`content.js`](content.js) bridges the Paramount+ page, extension storage, and popup state.
- [`injected/`](injected/) contains manifest parsing, request interception, stream modeling, quality rewriting, retry, prefetch, and diagnostics modules.
- [`popup.html`](popup.html) and [`popup.js`](popup.js) provide the localized UI and browser-store-aware links.
- [`_locales/`](_locales/) contains the supported translations.
- [`tests/`](tests/) contains Jest coverage for captured VOD/live stream shapes, parsing, rewriting, recovery, localization-adjacent UI behavior, and packaging.
- [`scripts/build.mjs`](scripts/build.mjs) produces Chromium and Firefox release packages.

## Permissions and privacy

Paramount Quality+ requests only extension storage and access to `*.paramountplus.com`. Storage is used for playback preferences and advanced settings; site access is used to inspect and adjust Paramount+ playback requests. The extension does not collect personal data or send analytics to the developer.

## Support

<p align="center">
<a href="https://chaseos.app">🌐 Explore my work</a>
</p>

<p align="center">
<a href="https://ko-fi.com/chaseos" target="_blank">
<img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="Support me on Ko-fi" />
</a>
</p>

Bugs and compatibility reports are welcome in [GitHub Issues](https://github.com/Chaseos/ParamountQualityPlus/issues).
