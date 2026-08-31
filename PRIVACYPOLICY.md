# Privacy Policy

_Last updated: August 30, 2026_

Paramount Quality+ is an independent browser extension for inspecting and adjusting the playback quality offered by Paramount+. It is not affiliated with Paramount.

## Local processing and settings

The extension processes playback manifests, request URLs, video state, resolution, and bitrate in your browser. It does not send these observations to the developer or an analytics service. Temporary playback diagnostics are kept in page memory and can include video timing and media URL paths. Network diagnostic snapshots omit URL query strings and fragments; browser console messages may contain full playback URLs. Do not share raw console logs without removing account information, signed URLs, tokens, and viewing details.

Quality preferences and network settings are stored using browser extension storage. Chromium and Firefox use their browser's sync storage; whether and how settings synchronize depends on the browser and your account settings. Safari stores preferences locally on the Mac. Temporary configuration needed across page reloads uses the Paramount+ page's session storage. These settings are not sent to the developer.

Other-browser editions also store local/synchronized flags for whether a review or cross-promotion was used. The Safari edition excludes these prompts and flags.

## Network requests and website access

The extension requests access to `*.paramountplus.com` so it can inspect and adjust playback in pages you authorize. Optional retries, representation checks, and buffer preloading can make additional requests to the media servers used by Paramount+ and its delivery providers. These requests are not requests to developer-operated servers. The website and media providers receive normal network information under their own privacy policies.

A location-permission action asks the Paramount+ page to request permission through your browser. This does not transmit your location to the extension developer. You control website and location permissions in browser settings.

The extension does not include third-party analytics, advertising SDKs, a developer account system, or a telemetry backend. It does not bypass a Paramount+ subscription, DRM, or regional access restrictions.

## Optional Apple tips

The Mac containing app offers optional consumable tips through Apple's StoreKit. Apple handles payment and purchase records under its own policies. The app verifies and finishes tip transactions on the device. Tips unlock no features or lasting benefits; the app has no receipt server and does not transmit receipts or transaction data to the developer. Apple may provide developers with standard App Store sales and financial reporting.

## Links and voluntary support requests

Opening App Store rating links, browser-store links, or the external support links in other-browser editions visits those services. They apply their own privacy policies. Opening the Safari heart action only opens the containing Mac app's support sheet.

GitHub hosts this policy and the public issue tracker. Information you voluntarily include in a GitHub issue is public. Do not include credentials, receipts, signed playback URLs, or other personal information. GitHub handles account and usage information under its privacy policy.

## Your controls

You can change settings in the popup, revoke website permission, disable the extension, or remove it using your browser's controls. Browser synchronization, backups, and Apple purchase records are controlled separately by the relevant service. Removing the extension does not necessarily delete those service-held records.

For questions or a sanitized bug report, use [the public issue tracker](https://github.com/Chaseos/ParamountQualityPlus/issues).
