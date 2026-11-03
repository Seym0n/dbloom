# Acceptance walk-through: module `admin-users` (SPEC/30 section 9)

Date: 2026-11-03. Windows 11, Node 24, Chromium via Playwright. Commands: `npx tsc --noEmit`, `npx eslint .`, `npx vitest run` (117 files, 2993 passed, 4 skipped), `npm run test:e2e:auth-ui` (109 passed, of which 5 new for this module and 1 changed expectation), `npm run test:e2e:auth-live` (46 passed, 2 skipped, 8 of them in `auth-live-users-admin.spec.ts`), `node scripts/gen-env-docs.mjs --check`, `vite build` (server, then CLI).

| # | Criterion | Result | Evidence and limits |
|---|---|---|---|
| 1 | Failed attempts at the threshold produce exactly one `failed_burst` notice per account and window, visible to every active administrator | Met | `tests/notices-detector.test.ts` (below, at, repeat, after the window; account and address counted separately; both sign-in services). Live: three wrong passwords for one account raise one account notice and one address notice; the address counter also counts failures of other names from the same /24, which the live spec shows by accident (an earlier failed sign-in of another user from the same network is part of the count). Only one administrator exists in the live run; "every administrator" is covered by the unit tests with two. |
| 2 | A completed sign-in from an unseen /24 or /48 produces one `new_location` notice; the first sign-in produces none | Met | Unit tests for IPv4, IPv6 /48, mapped IPv4, 90-day expiry, first sign-in. Live: first sign-in silent, another address of the same /24 silent, another network raises exactly one notice (through a trusted loopback proxy with `X-Forwarded-For`). IPv6 is not exercised live. |
| 3 | Thresholds come from the environment, out-of-range values refuse startup, setting keys exist | Met | `tests/notices-config.test.ts`. The keys are not editable anywhere yet (`admin-settings`). |
| 4 | The Users page shows, dismisses and links notices; Activity opens the viewer filtered to that user | Met | Mock layer: list, detail, dismiss, earlier notices, empty state, reload, Activity for bob and the own row, `?actor=` in the viewer. Live: panel content, dismiss and reload (dismissal is stored), Activity filter shows only that user's rows. |
| 5 | The live spec passes for disable, role change, sign-out of sessions, delete and the notice flow | Met with one gap | Disable and enable (the disabled user's open session ends, sign-in fails, enable restores it), role change both ways (audit rows counted), sign-out everywhere, recovery link from the page with step-up and audit row, delete (account gone, audit history kept, `seen_locations` rows gone, sign-in fails). **Gap:** the "last administrator cannot be demoted" rule is not reachable through the UI (the own role select is disabled, and with one administrator nobody else can act); the live spec checks the disabled select, and the service guard is covered by `tests/auth-account-security.test.ts`. |
| 6 | `docs/deploy.md` documents the variables and the 90-day location memory | Met | Generated variable table and the section "Security notices for administrators". |

## Findings during the work
- **Menu closes on scroll.** The popup menu closes on any scroll event. With the notices panel above the list, a layout shift made Playwright's scroll close an open menu and broke two existing specs. The panel therefore sits below the user list. This is a latent behaviour of `ActionsMenu` that a real user could also meet when the page shifts while a menu is open; it was not changed.
- **Mock-only strings.** The mock recovery token has a `rec-` prefix, the real one does not; the live spec checks the real shape.
- **Passwords containing the user name are refused** by the policy (the first live run chose such a password), which is the intended behaviour.
- **Builds fail now and then with `EBUSY`** copying a `node_modules` file into `.output`; a retry passes. Cause not found. The server build also wipes `.output/cli`, so the CLI bundle must be rebuilt after it.

## Not done or not run
- Notices to the affected user (`SPEC/FUTURE.md`, FU-user-notices).
- No settings UI for the thresholds; ST-216, ST-218, ST-219 moved to `admin-settings`.
- No test with many administrators or with a long spray over thousands of names beyond the counter-cap smoke test.
- The failed-attempt counter is per process and resets at restart (stated in the deploy guide).
- `/admin/users` and the Activity link are reachable by an administrator from any address (admin-plane deferred).
