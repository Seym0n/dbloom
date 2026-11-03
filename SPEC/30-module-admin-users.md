# 30 — Module spec: `admin-users` (security notices for administrators, user activity link, live coverage of the Users page)

**Implementation: all 5 tasks done 2026-11-03, acceptance in `reviews/admin-users-acceptance.md`. Status: APPROVED by the owner (2026-11-03), Q1 to Q7 all as recommended (ST-216, ST-218, ST-219 move to `admin-settings`; notices to administrators only; burst range 3 to 20; failed attempts per account and per address; 90-day /24 and /48 location memory; `detail` column; Activity link).** Written with the spec-driven-development skill (Phase 1) for module id `admin-users` of `SPEC/28-admin-capability-map.md`. Depends on `admin-audit` (built, `SPEC/29`). `admin-plane` is deferred, so nothing here is restricted to administration networks. No plan, task list or code exists yet; planning starts after this spec is approved.

## 0. Gap analysis (what the map said versus what the code has)
The map listed the Users page as the "smallest visible gain: services exist, only buttons missing". Reading the code shows the buttons exist: `src/components/auth/users/users-page.tsx` already offers create, role change, disable and enable, delete with confirmation, sign-out of all sessions, issue recovery link, invites (issue, list, revoke), each behind the administrator role check and step-up where the services demand it, with mock-layer specs (`auth-ui-users.spec.ts`) and live specs for create, invite and the CLI recovery (`auth-live-users.spec.ts`). The last-administrator guard is in `UserService`. So FR-TGT-105, FR-AUT-028 and the issue side of FR-AUT-016 are built; what is missing is narrower.

| Row | State today | What this module does |
|---|---|---|
| FR-TGT-149 (notices about new-location logins and failed-attempt bursts) | Notice storage and the per-user display exist (`user_notices`, `NoticesSection`); **nothing detects either event** | Detection, two new notice kinds, an administrator panel on the Users page |
| ST-207 (thresholds, definition of "new location") | Not defined | Three ENV variables now; setting keys defined for `admin-settings` later |
| ST-085 display (recovery notice to all administrators) | `notify()` writes one notice per active administrator; shown on each administrator's own account page | Also shown in the new panel (same data), plus dismiss |
| FR-TGT-105, FR-AUT-028 (disable, delete, role, recovery) | Built, mock-tested; no live spec for disable, role change, delete, sign-out of sessions | Live spec |
| ST-216, ST-218, ST-219 (login notice, maintenance mode, banner) | Not built | **Proposed to move to `admin-settings`** (Q1) |
| FR-SRV-042 (drop the same-named database on user delete) | Out of scope since map Q8 | unchanged |
| New, small | A user's audit history is one click away | "Activity" action on a user opens `/admin/audit` with the actor filter set |

## 1. Objective
Give administrators the in-app security signals that the specs promise instead of email (FR-TGT-149), and close the verification gap of the existing Users page. Users: administrators. Success: simulated failed attempts above the threshold and a sign-in from an unseen network each produce one notice that an administrator sees on the Users page, can dismiss, and can follow to the audit viewer; thresholds come from the environment; the whole Users page is covered by a live spec.

## 2. Assumptions (correct me now)
1. A "failed attempt" is a failed password or passkey sign-in step recorded by `signin.ts` (`auth.signin` with outcome `failed`), counted per known account (user id) and per client address (the effective address, FR-SVR-005). Throttling stays as it is; notices are information only.
2. A "new location" is the client address reduced to /24 (IPv4) or /48 (IPv6) that the account has not signed in from within the last 90 days (ST-207 text; the AS-98 variant of /56 is not used). The very first successful sign-in of an account is not a new location (no baseline). Only successful, fully completed sign-ins count (state `full` after the second factor).
3. Recipients are all active administrators (the existing `notify()` rule). The affected user does not get a notice of their own new-location sign-in in this module (Q2).
4. Burst notices are deduplicated: at most one per account and one per address per window.
5. Notices carry a small detail (account name or address prefix, count, window) so the panel can say what happened. `user_notices` has no detail column today; migration 7 adds one. Detail never holds a secret; addresses follow the anonymise setting of `admin-audit` (`DBLOOM_AUDIT_ANONYMISE_IP`) so a hashed address is shown hashed.
6. Account mode only. Direct mode has no administrators.
7. No commit and no new dependency without a go. None is needed.

## 3. Commands
```
Build:         npm run build
Unit/integr.:  npx vitest run tests/notices-*.test.ts
All tests:     npm test
Typecheck:     npm run typecheck
Lint:          npm run lint
UI mock specs: npm run test:e2e:auth-ui
Live account:  npm run test:e2e:auth-live
```

## 4. Project structure
```
src/server/store/sqlite-store.ts          migration 7: user_notices.detail, seen_locations         (changed)
src/server/auth/notices.ts                detection: burst counter, location check, notice writers (new)
src/server/auth/signin.ts                 calls the detector on failed and on completed sign-in     (changed)
src/server/auth/types.ts                  NOTICE_KINDS += new_location, failed_burst; settings keys  (changed)
src/server/auth.functions.ts              listAdminNotices, dismissNotice (names to confirm)         (changed)
src/server/env-registry.ts, config.ts     three variables                                            (changed)
src/components/auth/users/notices-panel.tsx  panel on the Users page                                 (new)
src/components/auth/users/users-page.tsx  "Activity" action, panel                                  (changed)
src/routes/admin.audit.tsx                reads an `actor` search parameter                          (changed)
src/lib/auth/mock-api.ts, mock-connections.ts  mock notices                                          (changed)
tests/notices-*.test.ts, e2e/auth-ui-users.spec.ts (extended), e2e/auth-live-users-admin.spec.ts (new)
```

## 5. Requirements

### 5.1 Functional
| ID | Requirement | Verification |
|---|---|---|
| FR-AUS-001 | **Failed-attempt burst.** When failed sign-in steps for one account, or from one address, reach `DBLOOM_NOTICE_BURST_FAILURES` (int, 3 to 20, default 10) within `DBLOOM_NOTICE_BURST_MINUTES` (int, 1 to 60, default 10), one notice `failed_burst` goes to every active administrator, with detail (account name or address prefix, count, window). The same account or address does not raise another notice until its window has passed. Counting uses the sign-in path only; it adds no writes for single failures. | Unit with fake clock: below threshold none, at threshold one, repeat none, after window again; address and account counted separately. Live: simulated failures produce the notice. |
| FR-AUS-002 | **New location.** A completed sign-in from a /24 or /48 prefix not seen for this account within `DBLOOM_NOTICE_LOCATION_DAYS` (int, 7 to 365, default 90) raises one `new_location` notice to every active administrator (detail: account name, address prefix). The prefix is recorded in `seen_locations (user_id, prefix, last_seen_at)` on every completed sign-in; rows older than the window are deleted by the existing session sweep; rows go with the user (cascade). The first completed sign-in of an account records the prefix and raises nothing. | Unit: first sign-in silent; same prefix silent; other prefix notice; after 90 days notice again; IPv4 /24 and IPv6 /48 reduction; user delete removes rows. |
| FR-AUS-003 | **Administrator panel.** The Users page shows a "Security notices" panel for administrators: unread notices newest first (kind text, detail, time), a dismiss action per notice, and "show earlier" for read ones. The existing kinds (`recovery_redeemed`, `admin_invite_issued`, `sessions_revoked` for others, ...) appear in the same list when they were addressed to this administrator. Dismissing marks the notice read (`markNoticeRead` exists in the store). No notice is deleted by the UI. | Mock-layer spec: list, dismiss, empty state, axe light and dark, phone width. Server function test: only the caller's own notices, dismiss only own. |
| FR-AUS-004 | **Settings readiness.** The three thresholds are defined as setting keys (`noticeBurstFailures`, `noticeBurstMinutes`, `noticeLocationDays`, `ui_within_env`, ranges as above) so `admin-settings` can edit them; until then only the environment sets them. Out-of-range environment values refuse startup (config strict parsing, like `DBLOOM_AUDIT_RETENTION_DAYS`). | Config test, resolver test. |
| FR-AUS-005 | **Activity link.** Each user row has an "Activity" action that opens `/admin/audit?actor=<user id>`; the viewer reads the parameter into its actor filter and applies it on load. | Mock-layer spec: action present for every user including the own row, filter applied. |
| FR-AUS-006 | **Live coverage.** A live spec on a built server covers: disable and enable a user (a disabled user cannot sign in, sessions end), change a role (and the last administrator cannot be demoted), sign out all sessions of a user, delete a user (rows of the audit log stay, the user's sign-in then fails), recovery link issue (already live via CLI; the UI path with step-up is added), a failed-attempt burst notice and a new-location notice reaching the administrator panel. | The spec itself. |
| FR-AUS-007 | **Audit.** New notices write no new audit event; detection reads the existing `auth.signin` path. Dismissal writes none. The Users page actions keep the audit events they already write (`user.*`, `invite.*`, `recovery.*`). | Event catalog test stays green; no new event names. |

### 5.2 Non-functional
- Detection runs inside the sign-in request: no extra database round trip on a successful sign-in beyond one indexed read and one upsert (`seen_locations` primary key on `user_id, prefix`).
- The failed-attempt counter lives in memory per process (as the throttle does): a restart resets it. The single-instance rule of the server module makes that sufficient.
- English strings through the i18n layer; the panel is keyboard operable; axe clean in both themes; phone width without horizontal scroll.

## 6. Code style
```ts
// src/server/auth/notices.ts (shape, not final)
export function createNoticeDetector(d: { store: AccountStore; settings: () => NoticeSettings; now?: () => number }) {
  const failures = new Map<string, number[]>() // key: `acct:<id>` or `addr:<prefix>`
  return {
    failedAttempt(userId: string | undefined, address: string): void { /* count, notify once per window */ },
    completedSignIn(user: Pick<User, 'id' | 'username'>, address: string): void { /* prefix lookup, upsert, notify */ },
  }
}
```
Conventions as in the repo: strict TypeScript, zod at server-function boundaries, snake_case columns mapped in one row mapper, no ORM.

## 7. Testing strategy
- Unit (vitest): detector with a fake clock (thresholds, dedupe, prefix reduction, first sign-in), migration 7, cascade on user delete, settings resolver and config bounds, server functions (own notices only).
- Mock layer (`auth-ui-users.spec.ts` extended): panel, dismiss, activity link, axe, phone width.
- Live (`auth-live-users-admin.spec.ts`): FR-AUS-006 end to end on a built server with the Docker test databases.
- Not tested: real email (none exists), many administrators at scale.

## 8. Boundaries
- **Always:** keep notices free of secrets; keep detection off the failure path of sign-in (a detector error never fails a sign-in); extend `NOTICE_KINDS` and the account-page strings together.
- **Ask first:** sending notices to the affected user, any new event name in the audit catalog, changing throttle behaviour, a new dependency.
- **Never:** block or slow a sign-in because of a notice; store a full client address in `seen_locations`; delete notices from the UI.

## 9. Success criteria
1. Failed attempts at the threshold produce exactly one `failed_burst` notice per account and window, visible to every active administrator.
2. A completed sign-in from an unseen /24 or /48 produces one `new_location` notice; the first sign-in of an account produces none.
3. Thresholds come from the environment, out-of-range values refuse startup, setting keys exist.
4. The Users page shows, dismisses and links notices; the Activity action opens the viewer filtered to that user.
5. The live spec passes for disable, role change, sign-out of sessions, delete and the notice flow.
6. `docs/deploy.md` documents the three variables (generated table) and the 90-day location memory.

## 10. Plan sketch (for review, not yet a plan)
1. Migration 7, notice kinds, settings keys, config and registry entries (004).
2. Detector and sign-in hook, unit tests (001, 002).
3. Server functions for list and dismiss, route search parameter for the viewer (003, 005).
4. Panel and Activity action, mock layer and specs (003, 005).
5. Live spec, deploy note, acceptance walk-through (006).

## 11. Open questions for the owner
| # | Question | Recommendation |
|---|---|---|
| Q1 | ST-216 login-page notice, ST-218 maintenance mode, ST-219 information banner: keep in this module (a bespoke form) or move to `admin-settings`? | Move to `admin-settings`. They are settings with step-up and old/new audit, and the generic editor gives exactly that; a bespoke form here would be rebuilt. Maintenance mode also needs session handling and deserves its own review there. The map entry for `admin-users` shrinks accordingly. |
| Q2 | Should the signed-in user also get a notice about a sign-in from a new location on their own account? | No in this module (FR-TGT-149 names administrators only). Record as a follow-up in `SPEC/FUTURE.md`; it is a small addition once the detector exists. |
| Q3 | Threshold ranges: ST-207 says burst 3 to 20, the older AS-98 note says 5 to 50. | 3 to 20 as in ST-207. |
| Q4 | Count failed attempts per address as well as per account? Per account alone misses a spray over many names. | Both, as in assumption 1. |
| Q5 | Add the `detail` column to `user_notices` (migration 7) so the panel can say which account or address? | Yes; without it a burst notice says only "a burst happened". |
| Q6 | Location memory lives 90 days per account as /24 or /48 prefixes. Acceptable for privacy (it is personal data of users)? | Yes, with the deploy note; it is deleted with the user and bounded by the window variable. |
| Q7 | "Activity" opens the audit viewer in the same tab with the actor filter; acceptable that the viewer has no admin-network restriction yet? | Yes (known gap, stated in the deploy guide). |

## 12. Notes for `docs/deploy.md`
Three variables in the generated table. One paragraph: the server remembers, per account, the /24 or /48 networks of completed sign-ins for the configured number of days to raise "new location" notices; the memory is deleted with the account; failed-attempt counts are kept in memory only.
