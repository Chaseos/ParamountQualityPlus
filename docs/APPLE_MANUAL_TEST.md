# Paramount Quality+ — one-pass Mac test

Prepared 2026-08-31. Use the existing **Paramount Quality+** Xcode window, **StoreKit Testing (macOS)** scheme, and **My Mac**. Do not use the similarly named configuration in another project's window. No new project, reinstall, or transaction-history reset is needed.

**Safety:** confirm the purchase dialog explicitly identifies an Xcode test purchase with no charge. If it does not, cancel. Do not enter payment information or use a production purchase. Leave **Dialogs Enabled** throughout: automatic dialog-free purchases cannot pass the interactive checkout test.

## Controls you will use

- App: **Support options** opens the tip sheet.
- Xcode project navigator: **Native and Configuration → ../Configurations/TipProducts.storekit → Configuration Settings**. Baseline: Dialogs Enabled; Ask to Buy and Interrupted Purchases Not Enabled; all simulated-failure checkboxes unchecked.
- Transaction window: **Debug → StoreKit → Manage Transactions** (or the Manage StoreKit Transactions button in the debug bar). Select **Paramount Quality+** under My Mac. Inspect each new row's details and unfinished warning; a success message alone does not prove completion.
- Only change the setting named in a test, then restore it. No rebuild between cases; use Command-R in the Paramount Xcode window only when a case requires relaunching.

## Run in this order

Write **pass**, **fail**, or **blocked** beside each ID. If a dialog disappears or stalls, record the exact symptom once, cancel if possible, and continue independent tests. Do not spend time repeating the same failure.

| ID | Do this | Expected result |
| --- | --- | --- |
| P1 | Open Small Tip, then cancel the actual purchase dialog. | Cancellation message; all tip buttons become usable; Done/Escape closes support. |
| P2 | Buy Small, Standard, Generous, then Small again, confirming each no-charge dialog. | Four separate successful purchases, correct products/prices, no stuck spinner. Each new transaction is finished in Xcode. No history deletion needed to repeat Small. |
| P3 | Start another Small purchase. While its confirmation is open, try another tip and Done/Escape on the support sheet; then cancel the purchase dialog. | No second checkout or premature support dismissal. Cancellation restores all controls. |
| F1 | Enable **Load Products** failure. Close/reopen support. Disable that failure and click **Try Again**. | Load error is shown; retry loads all three tips. |
| F2 | Enable **Purchase** failure. Attempt Small. Disable the failure and retry Small. | An error, no success claim, and usable controls; retry succeeds. |
| F3 | Enable **Verification** failure. Attempt Small. Disable it afterward. | Verification failure, no accepted-tip success, usable controls. Keep the transaction for inspection; do not delete it to hide an unfinished result. |
| A1 | Enable **Ask to Buy**. Request Small and choose Ask. Close support. In the transaction window, approve that new pending row; reopen support. | Pending does not lock the app. Delivery is handled with support closed; reopening shows verified delivery and the approved transaction is finished. |
| A2 | With Ask to Buy still enabled, request Standard, then decline that new pending row in Xcode. Turn Ask to Buy off. | No false success and no disabled controls. The app may retain its general pending notice because a decline sends no completed transaction. |
| I1 | Enable **Interrupted Purchases**, attempt Small, then resolve the new interrupted row in Xcode. Turn Interrupted Purchases off. | No premature success; resolved purchase is delivered/finished and controls recover. Record what the initial dialog/message shows. |
| R1 | With no active checkout, quit the app. In the transaction window use **+** to create one new Small Tip transaction for Paramount, leaving defaults. Confirm it is unfinished. Run the same StoreKit testing scheme again, without buying anything. | The previously unfinished transaction becomes finished after launch. Open support to inspect delivery. Relaunch once more: no new purchase or recurring unfinished transaction. If Xcode cannot create it while stopped, mark blocked; a normal restart alone is not a recovery pass. |

Ask to Buy, interrupted purchases, transaction creation, and completion inspection follow Apple's [transaction-manager guide](https://developer.apple.com/documentation/xcode/testing-in-app-purchases-with-storekit-transaction-manager-in-code) and [Ask to Buy guide](https://developer.apple.com/documentation/storekit/testing-ask-to-buy-in-xcode). Creating a transaction directly tests delivery/recovery, not the interactive payment dialog.

## Quick extension/UI pass

You already confirmed the subtitle fix; do not repeat that whole investigation.

| ID | Do this | Expected result |
| --- | --- | --- |
| S1 | On a full movie and one live stream you can access, choose a lower quality, then higher/Auto; seek on the movie. | Program keeps playing with sound; displayed resolution changes; captions remain usable where available. Mark inaccessible content blocked. Ads/previews do not count. |
| S2 | Open/close the popup; use keyboard navigation; open heart twice; dismiss support with Done and Escape. Test the heart once with the app quit. | Usable focus, one support sheet, no automatic purchase; warm/cold opening works. The unpublished rating explanation is expected. |
| S3 | Switch light/dark appearance, enlarge text where supported, and briefly check VoiceOver/Reduce Motion if available. | Readable labels/prices, no clipping or keyboard trap. Restore your original settings. Record unavailable checks rather than guessing. |

## Finish and report once

Restore baseline StoreKit settings, save the configuration, and leave transaction history intact. Do not run a preparation/build script while testing: it regenerates the configuration. No account credentials, signed video URLs, receipts, or personal screenshots are needed.

Copy this into one reply (group passes together if easier):

```text
P1 cancel:
P2 Small / Standard / Generous / repeat Small; transactions finished:
P3 concurrent checkout/dismissal:
F1 load failure/retry:
F2 purchase failure/retry:
F3 verification failure:
A1 approval with support closed:
A2 decline:
I1 interruption/resolution:
R1 unfinished transaction after relaunch:
S1 movie/live:
S2 popup/support/keyboard:
S3 appearance/accessibility:
Baseline settings restored:
Failures: ID + exact message/what happened
```

Passing this local run does not pass TestFlight/sandbox, Intel, older macOS, store assets, or owner-confirmation gates. Those are separate checks; do not upload or submit anything during this run.
