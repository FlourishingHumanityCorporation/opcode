# Mobile TestFlight Internal Release Checklist

Updated on **February 9, 2026**.

## Scope

Internal iOS-only TestFlight release for the mobile sync companion.

## Preconditions

1. Desktop branch merged with `P0-P3` mobile sync changes.
2. `mobile-sync-pr` required check is green on the release branch.
3. Latest `mobile-sync-nightly` run is green or has only acknowledged non-blocking issues.
4. Manual soak scenarios completed on:
   - same Wi-Fi
   - cellular + Tailscale

## Build and Signing

1. Confirm Apple Developer team and bundle ID are set in Expo/EAS config.
2. Confirm provisioning profile/certificates are valid.
3. Build command:
   - `cd /Users/paulrohde/CodeProjects/external/opcode/apps/mobile`
   - `npx expo prebuild --platform ios` (if native sync needed)
   - `eas build --platform ios --profile internal`
4. Verify build metadata:
   - version
   - build number
   - changelog notes for internal testers

## Verification Before Upload

1. Pair once from phone and confirm reconnect after app restart.
2. Confirm mirror updates for workspace/tab/session/terminal context.
3. Confirm action roundtrip:
   - workspace activate
   - terminal input
   - execute/resume/cancel
4. Confirm revoke-device behavior:
   - access denied on next authenticated operation
   - app returns to pairing state
5. Confirm embedded terminal UX:
   - wheel scroll works (single and split pane)
   - terminal viewport fits pane (no bottom clipping)

## Go / No-Go Thresholds

1. Connect success rate: **>= 98%** in internal soak cohort.
2. Auth failure rate: **<= 1%** excluding intentional revoke/unpair tests.
3. Action failure rate: **<= 2%** excluding user-guard-blocked actions.
4. Median mirror lag (active context): **<= 2 seconds**.

## Release Steps

1. Submit internal TestFlight build.
2. Add initial internal tester cohort only.
3. Distribute release notes with known limitations and rollback note.
4. Monitor first 24 hours of logs/feedback.

## Rollback Plan

1. Disable mobile sync from desktop settings toggle if severe issue is detected.
2. Revoke affected devices from desktop device management panel.
3. Pull TestFlight build from testing if issue is critical.
4. Publish a follow-up build with fix and migration note.

## Sign-Off

1. Engineering owner.
2. QA owner.
3. Product/ops owner (internal release approval).
