# Scope inventory: module `admin` (SPEC/21 section 0, line 15: "Users, settings UI, audit viewer", depends on auth-account)

Date 2026-11-03. Read-only inventory. Line numbers: SPEC/11 = `11-target-security.md`, SPEC/12 = `12-settings.md`, SPEC/26 = `26-module-auth-account.md`, SPEC/27 = `27-module-server.md`. No ID invented; "ST rows" are listed by range from SPEC/12.

Handover statements: SPEC/26:8 (what admin owns), 26:9 (resolver until admin exists), 26:165 (OTHER: admin list), 26:467 (Q5), 26:468 (Q6), 25:220, 27:29, 27:64, 27:172, 27:178.

## 1. Requirement table

| ID | source file:line | requirement (one line) | state | evidence |
|---|---|---|---|---|
| FR-TGT-141 | SPEC/11:234 | Administrators change all "UI within ENV bounds" settings of SPEC/12 from the UI, stored in the store | PARTLY | Table `settings` (sqlite-store.ts:159), `resolveAuthSettings`/`setSetting` (src/server/auth/settings.ts:93,141), `AUTH_SETTINGS` (auth/types.ts:737); no editing UI |
| SEC-TGT-142 | SPEC/11:235 | `.env` floor/ceiling/envelope/lock per setting; reject on write, clamp on read with audit | PARTLY | Clamp-on-read for auth keys only (SPEC/26:9, 26:160; settings.ts); other modules' keys read `Config` (SPEC/25:220) |
| SEC-TGT-150 | SPEC/11:244 | Precedence env limit > stored > env default > built-in; page shows "stored X, effective Y", locked shown read-only | PARTLY | Precedence implemented (SPEC/26:160, settings.ts); display "stored/effective/source" OPEN |
| NFR-TGT-145 | SPEC/11:238 | Every setting change audited with old/new value, actor, secrets masked; failed audit write aborts the change | OPEN | `audit()` is stdout JSON only (src/server/audit.ts:4-6); no old/new, no abort path |
| ST-092 | SPEC/12:134 | Account-event audit fixed on, no UI to disable/delete, failed audit write aborts a settings change | PARTLY | Events emitted (SPEC/26:158); abort rule needs audit store (OPEN) |
| SEC-TGT-143 | SPEC/11:236 | Step-up (fresh factor within window) for setting changes and user actions; optional cooling-off for loosening | PARTLY | Primitive `requireRecentFactor` (src/server/auth/stepup.ts, SPEC/26:144); `stepUpWindowMs` ST-034 (auth/types.ts:~870); applied to user actions (admin-users.ts); not applied to settings (none exist yet) |
| ST-093 | SPEC/12:135 | Fixed set of settings/actions needing step-up | PARTLY | Applied to user actions and invites (SPEC/26:144); settings part OPEN |
| ST-034 | SPEC/12:82 | Step-up window, ENV-only F1/D5/C15 min | ALREADY BUILT | `stepUpWindowMs` in AUTH_SETTINGS (auth/types.ts); SPEC/26:144 |
| ST-036 | SPEC/12:84 | Cooling-off delay for loosening changes (PROPOSED), pending and cancellable | OPEN | No code (grep) |
| SEC-TGT-144 | SPEC/11:237 | Lockout warning with affected-user count; auto-revert persisted across restart | OPEN | No code; SPEC/26:165 assigns to admin |
| ST-035 | SPEC/12:83 | Auto-revert period, ENV-only F1/D5/C15 min | OPEN | No setting defined in AUTH_SETTINGS |
| ST-056 (preview) | SPEC/12:98, SPEC/26:99 | Narrowing preview for allowed second factors | OPEN | SPEC/26:99 says OTHER: admin |
| ST-054..057, 063, 066, 068..072, 076..078, 081, 084, 087, 089, 090, 123, 124 | SPEC/12:96-132,164-165 | Auth-read settings, "UI within ENV bounds" | PARTLY | Resolved with `source: 'ui_within_env'` (auth/types.ts:737+); UI OPEN |
| ST-011, 012, 014 | SPEC/12:59-62 | IP allow list, deny list, per-role rules (UI, within ST-010) | OPEN | No UI; no stored-list consumer found in src/server/auth |
| ST-101..105, 109..115, 118, 121, 125, 164 | SPEC/12:142-166,189 | Target policy, timeouts, limits, SQL guard settings (UI within ENV bounds) | OPEN | Read from `Config`; SPEC/22:75,180, 23:89,95 ("settings UI OTHER: admin") |
| SEC-TGT-052 (UI) | SPEC/22:75, 23:89 | Settings UI for the three read-only levels | OPEN | Modules read `DBLOOM_READ_ONLY` / Config only |
| ST-150, 152, 156..158, 160 | SPEC/12:175-185 | Import/export limits, formats, defaults | OPEN | SPEC/25:220 "this module reads `Config` until it exists" |
| ST-161, 163, 164 | SPEC/12:186,188,189 | SQL history/bookmark limits, console shortcuts, SQL console availability | OPEN | SPEC/23 (reads Config) |
| ST-162 | SPEC/12:187, SPEC/23:98 | Export of a user's own state | OPEN | Provider `exportOwnSqlState(ownerKey)` is in sql-tab (SPEC/23:98); settings-page button OPEN |
| ST-113, 117, 212..215 | SPEC/12:154,158,207-210 | Rows per page cap, display truncation, language, theme, time zone (user pref within admin limits) | OPEN | No admin-limit UI |
| ST-202, 204, 207, 209, 213, 225 | SPEC/12:197,199,202,204,208,220 | Log level, audit retention, notice thresholds, version check, languages, AI on/off | OPEN | None in AUTH_SETTINGS |
| ST-216, 218, 219 | SPEC/12:211,213,214 | Login-page notice, maintenance mode, information banner | OPEN | No code (grep) |
| NFR-TGT-090 | SPEC/11:101 | Audit storage, retention 90-1095 d, no UI delete/edit, own events visible to users, export needs step-up, external sink | OPEN | Stdout only (src/server/audit.ts); no audit table in store (sqlite-store.ts schema) |
| FR-AUT-027 (storage/viewer) | SPEC/26:158 | Audit lines emitted by auth-account; "storage and viewer OTHER: admin" | PARTLY | Lines emitted via `audit()`; storage/viewer OPEN |
| ST-204 | SPEC/12:199 | Audit retention, UI within ENV bounds F90/D365/C1095 d | OPEN | Not defined (see C-12 conflict note in SPEC/12) |
| ST-205 | SPEC/12:200 | Audit access: view = admin plane, export step-up and logged, no delete | OPEN | none |
| ST-206 | SPEC/12:201 | External audit sink, IP anonymisation, ENV-only | OPEN | none |
| NFR-TGT-107 | SPEC/11:119 | User create/invite/role/disable/delete/recovery recorded in audit | PARTLY | Emitted by UserService/admin-users.ts (SPEC/26:145); storage OPEN |
| FR-TGT-105 | SPEC/11:117 | Admin disables, deletes, changes role, issues recovery link | PARTLY | Services: src/server/auth/admin-users.ts; server fns `setUserStatus`, `setUserRole`, `deleteUser`, `revokeUserSessions` (auth.functions.ts:399-435); `issueRecovery` (auth/recovery.functions.ts:9); UI buttons OPEN |
| FR-AUT-028 / Q5 | SPEC/26:159,467 | Minimal Users page built; full screen and move to administration plane left to admin | PARTLY | src/routes/admin.users.tsx (admin-role gate only; list, create, invites); disable/delete/role/recovery buttons OPEN |
| FR-AUT-016 (issue UI) | SPEC/26:147 | Recovery link issued by admin module or CLI | PARTLY | `recovery.issue` service and server fn exist; admin UI OPEN; CLI exists (src/server/auth/cli) |
| FR-SRV-042 | SPEC/22:66 | Delete users and optionally same-named database | OPEN | Needs structure module's drop-database function; not wired into `deleteUser` |
| FR-TGT-149 | SPEC/11:242 | Admin sees in-app notices (new-location login, failed-attempt burst) | PARTLY | `user_notices` table, `addNotice`/`listNotices` (sqlite-store.ts:182,359-361), user view in components/auth/account/sessions-section.tsx:79; admin view and new-location/burst detection OPEN |
| ST-085 (notice display) | SPEC/12:127, SPEC/26:119 | Recovery notices shown to user and all administrators | PARTLY | Notices written (auth/links.ts:69); admin display OPEN |
| SEC-TGT-147 | SPEC/11:240 | Admin functions and admin logins only from administration networks | PARTLY | `DBLOOM_ADMIN_NETWORKS` parsed (auth/setup.ts:55-57,128-130; env-registry.ts:84), used by setup wizard check (setup.ts:456); no enforcement on admin routes or admin sign-in found (grep: only setup.ts) |
| ST-013 | SPEC/12:61 | Administration networks, ENV-only, default loopback | ALREADY BUILT | setup.ts:55-57,128-130; .env.example:97 (consumption OPEN, see SEC-TGT-147) |
| SEC-TGT-125 | SPEC/11:189, SPEC/27:29 | Persistent warning to administrators on risky exposure; startup log in server module | PARTLY | Startup log and report built (src/server/exposure.ts, SPEC/27:178); admin-page banner OPEN |
| ST-032 | SPEC/12:80 | Exposure warnings computed; administrator acknowledgement audited and re-shown after restart | OPEN | Computation built (exposure.ts); acknowledgement OPEN |
| FR-TGT-146 | SPEC/11:239 | Admin page shows exposure report and warnings, same values as CLI | OPEN | `buildExposure` is a pure function for reuse (SPEC/27:64,178) |
| FR-SVR-011 | SPEC/27:64 | Exposure report function "feeds the admin page later" | PARTLY | src/server/exposure.ts, tests/exposure.test.ts; page OPEN |
| FR-SVR-010 / SEC-TGT-132 | SPEC/27:63,34,172 | `/api/ready` detail for administrator session (loopback today) | PARTLY | src/server/lifecycle/ready-response.ts:8 (loopback only); admin session OPEN |
| ST-021 | SPEC/12:69 | Readiness detail/metrics/version, ENV-only default off; content needs admin session or loopback | PARTLY | Same as FR-SVR-010 |

## 2. Proposed capability groups (independently testable)

A. **Settings editor** (settings UI, effective/stored display, write validation, locks): FR-TGT-141, SEC-TGT-142, SEC-TGT-150, NFR-TGT-145, ST-092, ST-056 preview, the ST ranges for auth, target policy, io, display and site settings. Depends on audit store (C) for NFR-TGT-145.
B. **Change protection** (step-up on settings, cooling-off, lockout preview, auto-revert): SEC-TGT-143, ST-093, ST-034, ST-035, ST-036, SEC-TGT-144. Needs A.
C. **Audit store and viewer**: NFR-TGT-090, FR-AUT-027 storage, NFR-TGT-107, ST-204, ST-205, ST-206, ST-092. No UI dependency; unblocks A and D.
D. **User management completion**: FR-TGT-105, FR-AUT-028/Q5, FR-AUT-016 issue UI, FR-SRV-042, ST-085 display. Services exist; UI plus drop-database hook.
E. **Notices**: FR-TGT-149, ST-207, ST-085 display, ST-216/218/219 banners (site notice settings). Can ship with D.
F. **Administration plane**: SEC-TGT-147, ST-013, ST-014, ST-011, ST-012 (address rules UI). Route and sign-in enforcement independent of the UI groups.
G. **Exposure and status page**: SEC-TGT-125, ST-032, FR-TGT-146, FR-SVR-011, FR-SVR-010, SEC-TGT-132, ST-021.

## 3. Questions for the owner

1. SEC-TGT-147 requires refusing admin sign-in and admin routes outside `DBLOOM_ADMIN_NETWORKS`, but only setup uses it today; does admin ship enforcement (F) in its first release? Recommend yes, before any admin UI is exposed.
2. Settings outside auth (target policy, io, display): does admin's settings editor extend `resolveAuthSettings` to all ST rows or give each module its own resolver (SPEC/26:9 limits clamping to auth keys)? Recommend one generalised resolver, same table meaning (SPEC/26:160).
3. NFR-TGT-145 aborts a settings change if the audit write fails, but audit is stdout only; where is the audit store (SQLite table in the account store, direct mode has no store)? Recommend SQLite table in account mode, ST-206 sink or stdout only in direct mode, per ST-206's "only audit route in direct mode".
4. ST-204 audit retention default conflicts (D 365 d in SPEC/12:199 vs AS-96 D 90 d noted there, "see C-12"); recommend 365 d.
5. ST-035 and ST-036 are not in `AUTH_SETTINGS` and ST-036's default is marked "?"/PROPOSED; is cooling-off in scope for the first release? Recommend defer ST-036 to FUTURE.md, keep auto-revert.
6. SEC-TGT-144 auto-revert requires a persisted pending change with an absolute deadline; recommend a `pending_settings` table, applied and reverted by a timer plus startup sweep.
7. Direct login mode has no store (UI override "account mode only", SEC-TGT-150); should the settings page be read-only with source `.env` in direct mode? Recommend yes.
8. FR-SRV-042 (drop same-named database on user delete) needs a user-to-database mapping that SPEC/26 does not define; recommend drop from admin scope (not applicable to account mode) unless the owner confirms.
9. ST-014 per-role address rules vs SEC-TGT-147 (admin role follows ST-013 only, D-03 no per-user rules): recommend roles-only UI for non-admin roles, as decided.
10. FR-TGT-146 says the admin page shows the exposure report, but `/api/ready` detail (FR-SVR-010) may overlap; recommend ready detail for admin sessions reuses the same `buildExposure` data, one source of truth.
