# Apple attestations — owner review required

Prepared 2026-08-30. These are proposed answers grounded in the current macOS implementation. No answers below have been submitted. The account holder must confirm them against the final app, distribution regions, contracts, and current App Store Connect questionnaire.

## App privacy

Proposed: **Data Not Collected**, with no developer tracking, subject to owner confirmation of the final implementation and support practices.

The containing app has no account, analytics SDK, receipt server, or developer-operated network endpoint. It reads StoreKit products and verified consumable transactions locally and finishes accepted transactions through Apple. Safari preferences, manifest parsing, native HLS master selection, and diagnostics run on the device. The extension requests Paramount/CDN resources as part of playback; it does not upload them to the developer. The native HLS adapter retains signed playlist URLs temporarily in page memory and does not persist or log its inline master.

Apple excludes processing confined to the device and data Apple itself collects from the developer's collection disclosure. This supports the proposal but does not replace an audit of all final dependencies or any separately collected support data. Public GitHub Issues are optional external support; users must not post accounts, payment data, signed URLs, or raw logs. Review any future support collection separately. [Apple privacy definitions](https://developer.apple.com/app-store/app-privacy-details/).

## Age rating

Proposed utility-content answers: no in-app messaging/chat, user-generated content, advertising, gambling, contests, medical advice, or objectionable material supplied by this app. Optional tips are consumable purchases, with no random rewards or benefits. The app is not intended for the Kids category and does not implement parental controls or age assurance.

The containing app does not embed a general browser; help/privacy links open externally. **Confirm how Apple expects the questionnaire to treat the extension's interaction with Paramount+ programming**, which can include mature content. Do not infer a 4+ rating solely from the setup screen. Let the current questionnaire calculate the rating after the owner confirms the interpretation; do not submit a specific rating from this draft. [Age-rating definitions](https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions/).

## Content rights and affiliation

The app modifies playback controls on a third-party service and does not bundle, redistribute, decrypt independently, or provide subscription access to programming. It does not claim Paramount affiliation. **Rights/permission confirmation remains unresolved**: a content-rights attestation must account for access to third-party content and the app's name/artwork, not merely the absence of bundled videos. The owner must establish the appropriate answer and supporting rights or legal basis for every selected region. [Apple content-rights requirements](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information).

## Export compliance

Proposed technical characterization: encryption is provided by Safari/macOS networking, the site's existing playback/DRM stack, and StoreKit. The extension does not implement encryption algorithms, alter DRM keys, or ship a cryptographic library. Native HLS quality selection retains the publisher's DRM metadata and uses the existing authorized player session.

Ask the account holder to confirm whether this final binary qualifies for the operating-system encryption exemption and whether any regional documentation is required. Do not submit an exemption or set a non-exempt-encryption declaration based solely on this draft. [Apple export-compliance overview](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance).

## Other owner-owned release gates

- EU trader status and any identity/address verification.
- An authorized, reviewable Paramount+ subscription-access path. Do not give Apple a personal account by default.
- Public privacy-policy publication after separately authorized push.
- Final rights, privacy, age, and export attestations.
- Any App Review decision about the extension's native support handoff under §4.4.

No legal, banking, tax, identity, trader, or submission actions are authorized by this document.
