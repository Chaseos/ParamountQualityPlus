# Paramount Quality+ — Apple release guide

Updated 2026-08-31. This is a macOS-only containing app and Safari Web Extension. Implementation and local verification do not authorize publication or establish release readiness.

## Manual checklist result and shipping status

After the batched manual-test handoff, the user reported that everything appeared to work. Record this as an overall user-reported local pass, superseding the earlier automation-only checkout uncertainty for the scenarios they exercised. Individual transaction completion records and a case-by-case result list were not supplied; do not invent them or mark exact-artifact release gates from this general report. No additional local retest loop is requested. The next stage is a fresh distribution/TestFlight candidate, subject to separate archive/upload authorization. TestFlight/sandbox, Intel/older macOS, store assets, privacy publication, compliance confirmations and authorized review access remain separate release gates.

## Precommit audit (2026-08-31)

Review reproduced a Safari-only race: a delayed `play()` rejection belonging to a completed source switch could roll back a newer queued quality choice. Completed switches now ignore that obsolete error. The new executable regression failed before the guard and passed afterward. All 248 JavaScript and 9 Swift tests pass, and the development-signed Release build passes bundle/resource validation. This small follow-up is covered by automated regression; the user's earlier manual results apply to the preceding build.

Candidate-file privacy review found no credentials or absolute user paths. Test URL query values are synthetic; generated icon EXIF contains only pixel dimensions. Build products, local reports/screenshots, signing files and Xcode user state are excluded. Approved public app identifiers, signing team identifier, GitHub identity and copyright are intentionally present. No commit or push was performed by the audit. Source-control readiness does not imply App Store release readiness.

## Caption restoration build for manual testing (2026-08-31)

The Safari-only source-switch path now rebuilds Avia's native caption surface through the player's existing factory before replacing the HLS source, including rollback and Auto. It retains the site's live language/on/off settings and custom cue renderer, clears obsolete track descriptors, and lets the site handle late tracks and teardown. It adds no persistent preference, native-caption substitution, or renderer of its own. The bridge is guarded for the observed `html5` adapter and in-band tracks; external track resources and unsupported player APIs are left untouched. This integration depends on Avia's adapter surface and must be rechecked when Paramount changes its player.

All 247 JavaScript and 9 Swift tests passed. An additional isolated check using the public Avia 2.62.0 text-track surface reproduced the original disabled/disconnected replacement-track failure, then verified reconnection, late Spanish tracks, repeated switches without duplicate cue delivery, Off/language changes during loading, re-enablement, and site teardown. That check used synthetic media/cues in jsdom, not Safari playback or visible caption rendering.

Development-signed Release and the existing Xcode Debug app were rebuilt and passed bundle/resource validation. Chromium and Firefox packages are byte-for-byte unchanged from the start of this fix. No new project, commit, push, archive, or upload was created. The user subsequently confirmed that the subtitle fix worked after the requested Safari manual retest. **Subtitle restoration is passed by user confirmation for the tested playback.** This closes the reported caption regression; it does not establish coverage of every program/live stream, compatibility target, or native purchase flow. Sanitized local evidence is under ignored `build/release-check/caption-*`.

## Shared-code follow-up (2026-08-31)

Program-playlist classification, UTF-8 popup encoding, and the content-script reinjection guard now live in shared sources. Safari still owns the native HLS adapter, local-storage transformation, and Apple actions. The narrow program-playlist exception does not allow ad segments or arbitrary ad-host paths. Shared regressions cover retrying an unchanged program manifest without speculative segment prefetch.

The optional **Apply immediately** experiment was removed in full after the user reported that Chrome paused playback and required manual restart. Its button, message handler, resume storage, and new strings are absent; ordinary browser selection behavior is unchanged.

233 JavaScript tests and 9 Swift tests pass. Existing development-signed Debug and Release builds and the existing Xcode Debug output were refreshed; no new projects, archives, uploads, or Git publication were created. Safari displayed the six-rendition Challenge ladder again after refreshing the development extension state. Duplicate development registrations can expose different popup/content runtime IDs; an absent response is not proof that the manifest parser failed.

Safari's advanced controls were exercised in the real extension document opened in a Safari tab: retry count 3→4 and prefetch count 5→7, both toggles disabled, then values and disabled inputs verified after reopening. Original enabled/3/5 settings were restored. Popover AX clicks remained unreliable, so this is not a passed popover-input test. A separate real Safari HTTP fixture using the production network hooks verified four attempts recovering after three 503 responses, one attempt with retries disabled, exactly seven then two future-segment requests as prefetch count changed, and no future requests when disabled. This confirms hook behavior in Safari, not control over native HLS segment retries or native buffer depth. Initial footer focus was absent in the updated popup, while deliberate Tab focus retained its visible indicator.

The user clarified that the missing-ladder report concerned Mac, not iOS, and confirmed the ladder is visible again. No mobile issue or target is in scope. The Safari-specific status paragraph below the controls was removed at the user’s request; native resolution and estimated-bitrate formatting remain.

## Earlier local check: caption failure (2026-08-31)

The focused Challenge S42E1 pass verified actual English caption rendering and a ten-second rewind followed by advancing playback. Force Highest persisted through the settings-document reload and the episode subsequently reported 1080p. Selecting 360p in the real extension document changed the live popup resolution to 360p and playback continued, but **visible captions stopped after the source switch**. Reselecting English did not restore them; Auto plus an episode reload restored baseline captions. This is a release-blocking playback finding, not a passed subtitle-preservation test.

The site uses a hidden text track for its custom caption renderer. A controlled comparison found a replacement disabled track after the switch. Temporarily restoring hidden mode loaded cues but did not restore the visible renderer. At the time, the Safari session only restored showing tracks. No runtime workaround was applied during that check; the later caption restoration build above still requires visible-playback verification.

The actual popup's selected-state appearance also needs review: Force Highest had a checkmark while Auto remained blue. Automated popover clicks remained unreliable; selection tests used the extension document in a Safari tab and are recorded as such.

The current Xcode development app passed universal-architecture, app/extension identity/version, sandbox/signature, configuration, localization-resource and exact Safari-resource checks. All 233 JavaScript and 9 Swift tests passed again. A further local Standard Tip attempt encountered a macOS ScreenCaptureKit capture failure; manual no-charge confirmation was requested to distinguish automation limitations from checkout behavior. Successful checkout and recovery remain unverified pending that result.

Auto and the original Off subtitle preference were restored, playback was paused, the temporary extension-document tab was closed, page-local diagnostic references were removed by reload, and Safari developer features were restored off. Broader movie/live, accessibility, Intel/older-macOS and TestFlight checks remain outstanding.

## Chrome comparison and Safari subtitle-restoration scope (2026-08-31)

Chrome's full Avatar Aang playback passed the tested 1080p-to-360p caption check. The user selected 360p because browser policy prevents automation of its extension page; independent DOM readback confirmed decoded height 360, advancing playback, a retained MediaSource/blob source, and updated caption dialogue. The user also confirmed captions stayed on. This narrows the observed failure to the Safari source-switch path for these tested streams; Firefox and other Chrome paths were not exercised.

The public Avia native-video adapter does not implement manual bitrate switching, so merely removing the Safari source reload would remove the current quality enforcement. Its subtitle handling caches track identities and rejects replacement tracks with matching language/label/kind as duplicates. Saving enabled state alone is therefore insufficient. The subsequent Safari-only bridge described above reconnects that subsystem while preserving the site's settings; the user has confirmed the fix works for the tested playback.

## Source and identity

`apple/Configuration.json` owns bundle IDs, team, Apple version/build, support scheme, listing ID, URLs, and consumable definitions. `npm run prepare:apple` generates `Shared.xcconfig`, local StoreKit products, Safari resources, and icon sizes from the existing artwork. Do not regenerate the converter project over the native implementation. There are no mobile targets.

The registered Mac app is **Paramount Quality+**, Apple ID **6806901993**, SKU **PQP-MAC-001**, version/build **1.27 / 1**. App and extension IDs are `app.chaseos.ParamountQualityPlus` and `app.chaseos.ParamountQualityPlus.Extension`. These are public product identifiers, not credentials. Signing material, account data, receipts, raw diagnostics, and screenshots must remain outside version control.

Support is [GitHub Issues](https://github.com/Chaseos/ParamountQualityPlus/issues). Privacy is [PRIVACYPOLICY.md on main](https://github.com/Chaseos/ParamountQualityPlus/blob/main/PRIVACYPOLICY.md). The revised local policy must be reviewed and separately authorized for push before its public contents match this implementation. No chaseos.app dependency was added.

## Commands and boundaries

```sh
npm run prepare:apple
npm run build:apple:debug
npm run build:apple:release
npm run build:apple:debug -- --development-signed
npm run build:apple:release -- --development-signed
npm run test:apple
npm run validate:apple:release -- --app="/path/to/fresh/distribution/Paramount Quality+.app" --signed
```

Builds are sequential, limited to two Xcode jobs, and use separate Debug/Release and unsigned/development output directories. They never archive or upload. Use the existing project only; do not create diagnostic Xcode projects or launch parallel build jobs during testing.

The normal **Paramount Quality+** scheme has no local StoreKit binding and archives with Release. **StoreKit Testing (macOS)** binds `TipProducts.storekit` only for local testing and disables archive builds. Confirm Xcode's no-charge test environment before any transaction. Do not purchase in production while testing.

`validate:apple:release` intentionally fails until artifact inspection and all recorded release gates pass. It requires App Store distribution signing, matching bundled resources/configuration, universal binaries, sandboxing, and an evidence fingerprint for the entire exact app bundle. Evidence belongs in ignored `build/release-check/release-gates.json`; never set a gate true merely because a build passed. A changed bundle requires new evidence. Older macOS, Intel runtime, and sandbox/TestFlight are separate runtime checks.

## Packaging and native behavior

Shared manifest parsing and representation selection remain the source of truth. Safari-specific code lives under `platforms/safari/` and is included only in Safari output; shared changes are limited to the approved program-playlist classification, content-script reinjection guard, and UTF-8 popup declaration. Safari transformations are excluded from Chromium/Firefox packages. Safari builds use local extension storage with existing keys, preserve configuration-before-injection ordering, and retain only the existing Paramount+ host permission plus `storage`. Chrome/Firefox retain sync storage, branding, promotions, and review behavior. Explicit package allowlists exclude development files.

Safari's native HLS engine bypasses JavaScript fetch/XHR hooks. The Safari adapter reads the current master, reuses the shared parser/selection, and creates an inline master restricted to the selected rendition URLs while preserving alternate audio, subtitles, and DRM metadata. Auto restores the original URL. Signed URLs remain in page memory, never in preferences or developer logs. Native bitrate is labeled as a manifest estimate; Safari manages native segment retries/prefetch. Loading, switching, rollback, stale-source protection, and retry have executable tests, but those tests are not runtime evidence.

The Safari popup keeps its approximately 372px width. Its star opens this app's direct write-review URL; missing IDs and unpublished development destinations have explanatory messages. `appStorePublished` controls only that development explanation, not access to features. The heart opens only `paramountqualityplus://support`; paths, credentials, ports, query actions, and fragments are rejected. Routes never purchase.

Native setup reports Safari's enabled/disabled/unknown extension state; it cannot inspect website permissions. One app-owned store listens for transaction updates and reconciles unfinished consumables. Direct results, updates, and recovery share verified product checking and idempotent completion. The visible support sheet supplies the purchase window on macOS 15.2+, with the supported earlier API below that. Tips unlock nothing and have no restore button or receipt backend.

The requested support handoff remains a review risk under [App Review §4.4](https://developer.apple.com/app-store/review/guidelines/#extensions). If Apple objects, obtain a product decision about a neutral Open App/help action; do not silently change it.

## Portal drafts

Both approved identifiers and one macOS app record have been created. Utilities, free pricing, all 175 storefronts, manual release, version 1.27, description, keywords, copyright, and GitHub links were drafted. These settings are not a submission, release, or compliance attestation.

| Consumable | Product suffix | US price | Apple product ID |
| --- | --- | --- | --- |
| Small Tip | `.tip.small` | $0.99 | 6806903292 |
| Standard Tip | `.tip.standard` | $2.99 | 6806903613 |
| Generous Tip | `.tip.generous` | $4.99 | 6806904232 |

Product IDs use the app bundle ID plus the suffix. English localizations, Apple-generated regional prices, all-region availability, and draft review notes were entered. Each remains **Prepare for Submission**, not approved. Read back final fields before submission. Real IAP review screenshots and listing screenshots are still required; diagnostic captures are not store-ready assets.

Accepted Mac listing sizes currently include 1280×800, 1440×900, 2560×1600, and 2880×1800, all 16:10. Verify [Apple's screenshot requirements](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications) again before upload. Capture actual UI; validate format, size, and no transparency. Keep separate directories for listing images and IAP review images.

## Runtime evidence and remaining gates

Sanitized, scenario-specific results are maintained locally in `build/release-check/REPORT.md`. Automated tests include executable browser storage/bootstrap checks and injectable native commerce/routing tests; they do not prove Safari playback or native checkout.

Latest local verification: 247 JavaScript tests and 9 Swift tests passed. The caption fix has fresh development-signed Release and existing Xcode Debug bundle validation; unsigned variants passed earlier checks. The user confirmed subtitle restoration works. The strict release command remains blocked by other runtime and owner-confirmation gates.

The current source reference was inspected read-only at `2a397da`. The user reports its latest build succeeds on all platforms; its saved report describes older local checkout/recovery failures. Do not override the user's observed success with that older report, or claim a working reference proves this app's runtime behavior.

Local Paramount testing has reached real Challenge S42E1 playback. Trailer/ad observations do not count. The original native HLS path exposed no popup ladder. A direct rendition URL changed decoded video to 360p but lost audio, so that approach was rejected. A controlled inline-master test reached 360p with two audio tracks, one text track, and advancing playback. The integrated adapter subsequently passed 1080p → 360p → 1080p → Auto through its real Safari local-storage change listener on the full episode: actual decoded heights changed, playback advanced, two audio tracks remained available, and Auto restored the original HTTPS master. The popup automatically displayed all six qualities. These tests used Web Inspector to change the saved preference; popup input itself, Force Highest, forced-quality reload persistence, other VOD/live paths, and audible sound/rendered captions remain unverified before setting `safariPlayback` true. Safari also showed duplicate development entries and a duplicate content-script declaration; the shared bootstrap now guards reinjection. Real Safari diagnosis found two additional issues: the shared ad-host heuristic excluded full-program Google DAI playlists, and a detached fetch call used the session object as its receiver. Shared classification now recognizes the specific HTTPS program-playlist route, and the Safari native adapter calls fetch through the global receiver. Executable regressions cover these narrow changes; broad Chromium/Firefox runtime equivalence is not established by unit tests alone. Safari was observed loading older cached extension resources despite current built resources; confirm the live code generation before counting a runtime test. Existing captured cases include Starfleet Academy S1E1, Strange New Worlds S1E1/S4E1, Survivor S50E8, Avatar Aang, Roofman, classic movie paths, and Big Brother live.

Native setup and support opening, local product loading, Escape, and a Small Tip cancellation have been exercised. The 2026-08-31 retest used the existing StoreKit Testing (macOS) scheme: all three products loaded, cancellation restored controls, Escape dismissed support, and the native rating action explained that the listing is unpublished. The no-charge checkout briefly exposed a Purchase button, but it disappeared before confirmation and remained absent on retry. Successful interactive checkout is still unresolved; its cause has not been isolated from focus/automation behavior. Successful purchases, repeats, interruptions, pending approval/decline, sheet-closed delivery, and relaunch recovery remain unverified in this app. A temporary diagnostic project was stopped and removed at the user's request; no further projects should be created.

Before release also verify keyboard navigation, long translations, RTL, larger text, light/dark contrast, Reduce Motion, VoiceOver, enabled/disabled states, denied/granted site access, cold/warm support links, duplicates, and Done/Escape around active checkout. The temporary Safari developer-features and full Tab-navigation settings were restored off after this run. Auto was restored and the page reloaded. Preserve installations and transaction history.

Legal/privacy/age/content/export answers require user confirmation; see `docs/APPLE_ATTESTATIONS_DRAFT.md`. EU trader compliance and an authorized subscription-access path for App Review remain user-owned gates. Do not provide a personal Paramount+ account to App Review.

Commit, push, public privacy publication, archive, upload, tester invitations, beta review, App Review submission, and public release remain separate explicit authorizations. Rebuild/re-archive after changes; never reuse a stale archive or equate upload with processing completion.

## Remaining prerelease sequence (2026-08-31)

Further ad-blocker testing is excluded at the user's request. The user reports that enabling uBlock prevents Paramount+ videos from playing; this is a reported compatibility limitation, not an independently isolated extension defect. Do not promise ad-blocker compatibility.

1. Accept the user's overall local checklist result without repeating the same interactive loop. Before release, reconcile the preserved transaction evidence and verify test overrides are restored; any scenario not actually exercised remains unverified.
2. Preserve the user-confirmed caption fix and local playback results. Broader platform coverage remains separate. Native HLS retry and buffering control remains unsupported by the current JavaScript hooks; do not market those controls as verified for that playback path.
3. After separate archive/upload authorization, test a fresh private TestFlight build for installation, extension enablement, playback, and sandbox purchases. This does not authorize public release. Exercise Intel and the supported older macOS runtime on suitable hardware; build architectures alone do not pass these checks.
4. Finish screenshots and store metadata, obtain owner confirmation for attestations and review access, publish the reviewed privacy policy only after push authorization, and address trader compliance. Submission and public release require their own authorization.
