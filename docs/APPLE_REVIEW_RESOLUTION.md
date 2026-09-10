# September 8 review resolution — 1.30 (2)

## Website publication update

Support and privacy were published with owner authorization on September 8 to chaseos.app. Both canonical URLs returned HTTP 200 with expected content. Deployment: https://36c3d275.chaseos-portfolio.pages.dev. The release excluded unrelated portfolio work and made no Git commit/push. App Store Connect URL updates, app upload and review submission remain outstanding. This update supersedes the pre-publication status recorded below.

## Local implementation and verification

The containing app now quits after its last window closes. Existing purchase-in-progress close/termination guards and cold support routing are preserved. Configuration and generated build settings identify version 1.30 (2). Apple Help points to https://chaseos.app/extensions/paramount-quality-plus/support.

The support page is implemented in the existing ChaseosPortfolio repository using its product-page styles, shared public contact email, and metadata helper. It now covers Chrome, Firefox, Edge, Opera, Naver Whale and Safari, with general setup and a separate Safari section. It includes website permissions, troubleshooting, quality limitations, optional support, privacy guidance for reports, and email/GitHub contact methods. The existing August 30 privacy policy was migrated to `/extensions/paramount-quality-plus/privacy`, preserving its substance and updating hosting/contact references. The complete published GitHub main tree contained no terms document, so none was invented. The product support/privacy links, Apple privacy configuration and sitemap use the website routes. The GitHub policy remains intact for existing links; publication and store metadata updates are pending.

Passed on September 8:

- 273 JavaScript tests and 9 Swift tests (`npm run test:apple`).
- Development-signed universal Release build and bundled resource/configuration validation (`npm run build:apple:release -- --development-signed`). This is not an App Store archive.
- Portfolio production build and 36 tests, including internal link, metadata and sitemap checks covering the support page.
- Chrome desktop and 390 × 844 support-page visual checks. Viewport restored afterward.
- Physical Mac: launching the exact new Release executable, closing its main window, and observing its process exit. Normal relaunch works.
- Safari popup remains available while the containing app is closed. Direct navigation to its observed `paramountqualityplus://support` URL, followed by Safari's Allow prompt, cold-launches the exact new executable and opens Support options with all three prices. An AX click on the popup link alone did not produce a launch; this is not recorded as a passed popup-link interaction.
- A Small Tip attempt disabled the sheet controls, then returned “Purchase cancelled” and restored them. No checkout/Sandbox confirmation appeared, and no successful purchase is claimed. Escape then dismissed the sheet normally.

Still required: exact-build playback/quality persistence with the app closed, interactive Sandbox successful/repeat purchases and recovery, and a fresh physical-device recording. Do not mark these passed from unit tests or prior-build evidence.

The available Safari session subsequently opened SpongeBob SquarePants S2 E2, but the player exposed no usable playback controls and the popup reported Not connected with no quality ladder. This session did not establish advancing playback or quality switching. A black DRM capture alone is not evidence of a playback defect. No playback code or Safari permissions were changed to work around this observation.

## Purchase metadata inspection

Read-only inspection in App Store Connect confirmed all three products still show Prepare for Submission, English (U.S.) localization, all-country availability, an attached review screenshot, product-specific review notes, and an enabled Add for Review action. Existing notes explicitly disclose that interactive checkout and recovery remain unverified. IDs and prices were not changed.

| Product | Product ID | US price shown in native app |
| --- | --- | --- |
| Small Tip | app.chaseos.ParamountQualityPlus.tip.small | $0.99 |
| Standard Tip | app.chaseos.ParamountQualityPlus.tip.standard | $2.99 |
| Generous Tip | app.chaseos.ParamountQualityPlus.tip.generous | $4.99 |

Standard and Generous have Apple-scheduled foreign exchange/tax adjustments on September 14 for three and four regions respectively; preserve these schedules.

## Remaining publication sequence

Publication, archive/upload, reviewer messaging and resubmission require separate authorization under the accepted plan. No portal fields have been changed by this implementation.

1. Publish the support and privacy pages through the portfolio's existing deployment flow. Verify both public routes anonymously, then save their URLs in App Store Connect's Support URL and Privacy Policy URL fields. Until publication, the candidate's new Help and Privacy destinations are not release-ready.
2. Finish the runtime checks and recording below. Use a confirmed no-charge Sandbox/TestFlight environment for purchases.
3. Archive the normal Paramount Quality+ scheme using the existing project, upload 1.30 (2), and wait for processing. Set the editable macOS listing version to 1.30 and select the new build.
4. From each purchase's Add for Review action, include all three consumables in the same submission as the corrected app version. Inspect the submission summary for four items: one app version and three consumables. Do not submit a purchase-only review or confuse saved metadata with attachment.
5. Update review notes and the recording; update product verification notes only with actually observed results. Send the reviewer response after its claims are true, then resubmit. Preserve the existing automatic-release setting.

## Recording checklist

Capture on a physical Mac running the latest released macOS; identify the actual OS and build. Begin by launching 1.30 (2), show Safari setup and permissions, authorized Paramount+ playback, popup resolution and quality choices, close the Mac window and show continued Safari playback and quality controls, then reopen Support options and show optional tips. Use a camera if DRM suppresses screen capture, as with the existing attachment. Avoid credentials and private account details. Include no-charge purchase/cancellation only if the environment is visibly confirmed. Keep the old recording until the replacement has been reviewed.

## Reviewer response draft — send only after completion

Thank you for the review. We have addressed the three reported issues in version 1.30, build 2:

- Guideline 4: This is a single-window containing app. Closing its main window now quits the app; the Safari extension operates independently. The app can be launched again for setup and optional tips.
- Guideline 1.5: The Support URL now opens https://chaseos.app/extensions/paramount-quality-plus/support, with setup and troubleshooting guidance and a direct support email address.
- Guideline 2.1(b): Small Tip, Standard Tip and Generous Tip are included with this app version in the same submission. These are optional repeatable consumables and unlock no features or content.

The review notes and physical-device demonstration have been updated for this build. All extension functionality remains free.

## App Review Notes draft

### 1. Demonstration and reviewer access

The demonstration must be refreshed for 1.30 (2) before using this draft. The existing video was filmed with a phone because screen capture suppresses DRM-protected playback. Paramount Quality+ has no account or login. Playback on Paramount+ requires an authorized subscription to that unrelated service. No personal credentials are supplied. If live reviewer access is still required, please advise which secure alternative Apple will accept. Source: https://github.com/Chaseos/ParamountQualityPlus.

### 2. Purpose and target audience

Paramount Quality+ is a free, open-source Safari extension for Paramount+ subscribers who want to inspect and choose playback quality on paramountplus.com. It reports resolution and manifest-estimated bitrate for native HLS, lists available quality levels, and supports Auto, a selected resolution, or Force Highest. Safari manages native buffering and retries. The extension does not supply content or subscriptions.

### 3. Setup and main features

Install and launch the Mac app. Select Open Safari Extension Settings, enable Paramount Quality+, and allow access to paramountplus.com. Open Paramount+ in Safari, sign in with an authorized account, start playback, and open the extension's toolbar popup. Select Auto, an available resolution, or Force Highest; native HLS may briefly reload. Closing the containing app's main window quits it without disabling the extension. Reopen the app for setup or select its heart button, Support options, for optional tips. All features work without tips. No sample files or app-specific credentials are required. Help: https://chaseos.app/extensions/paramount-quality-plus/support.

### 4. External services and platforms

Paramount+ provides authentication, programming, manifests, DRM and media streams, with its CDN providers including Google DAI for some live streams. Safari/macOS provides extension APIs, local browser storage, networking and playback. Apple StoreKit handles optional consumable tips. GitHub hosts source, privacy policy and issue tracking; chaseos.app provides support information. Neither support site is required for playback. There is no developer playback backend, app account system, analytics, advertising SDK, telemetry or AI service.

### 5. Regional differences

There is no region-specific feature logic or bypass of geographic restrictions. Paramount+ determines service/catalog availability, access and supplied quality, which vary by country, subscription, device and stream. The interface supports English, German, Spanish, Latin American Spanish, French, Italian, Korean and Brazilian Portuguese.

### 6. Regulated services and protected material

The app is not a regulated service. It does not bundle, host, redistribute or independently decrypt Paramount+ programming, or bypass subscriptions, authentication, DRM or regional restrictions. It inspects playback information and selects representations already supplied to an authorized user through the official website/player. It identifies Paramount+ as the compatible service and states that it is independent and not affiliated with, endorsed by or sponsored by Paramount. No regulated-industry credentials apply. This description does not claim third-party branding authorization.
