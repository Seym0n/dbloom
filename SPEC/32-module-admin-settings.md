# 32 — Module spec: `admin-settings` (settings editor, locks, change audit, login notice, information banner, maintenance mode)

**Implementation: all 6 tasks done 2026-11-04, acceptance in `reviews/admin-settings-acceptance.md`. Status: APPROVED by the owner (2026-11-03), Q1 to Q7 all as recommended (auth keys plus the three site keys; code bounds, no per-key `.env` min/max, `DBLOOM_SETTINGS_LOCK` as the fence; uniform step-up; login notice on the sign-in page only; sessions kept in maintenance; no automatic migration switch; CLI `list`, `reset`, `maintenance off`). Written plan and tasks: `tasks/plan-admin-settings.md`, `tasks/todo-admin-settings.md`.** Written with the spec-driven-development skill (Phase 1) for module id `admin-settings` of `SPEC/28-admin-capability-map.md`. Depends on `admin-audit` (built, `SPEC/29`: `auditRequired`). `admin-plane` is deferred, so the page is reachable by any administrator from any address. `admin-protect` (step-up set, lockout warning, auto-revert) comes after this module. No plan, task list or code exists yet; planning starts after this spec is approved.

## 0. Gap analysis (map versus code)
| Row | State today | What this module does |
|---|---|---|
| FR-TGT-141 (administrators change "UI within ENV bounds" settings in the UI) | `AUTH_SETTINGS` (`src/server/auth/types.ts`, 36 keys) with `source`, `floor`, `default`, `ceiling`, zod schema; resolver in `src/server/auth/settings.ts`; table `settings` and `setSetting`. `write()` accepts only the wizard's keys (`SETUP_SITE_SETTING_KEYS`). **No editing UI, no admin write path, no delete** | Admin write path for every editable key, page `/admin/settings` |
| SEC-TGT-142 (limits from `.env`; reject on write, clamp on read with audit) | Clamp on read exists; write clamps silently instead of rejecting; no audit of clamps | Write rejects out-of-range; clamp-on-read raises one audit entry per distinct clamp |
| SEC-TGT-150 (page shows stored X, effective Y, source, range, locked read-only, reset) | Precedence implemented; nothing shows it | `describe()` and the page |
| NFR-TGT-145 / ST-092 (change audited with old and new value; failed audit aborts) | `auditRequired` exists, no caller | First real caller |
| ST-056 narrowing preview | Resolver narrows; nothing counts affected users | Preview with count; refuse when it would strand a user |
| ST-216, ST-218, ST-219 | Not built (moved here from `admin-users`) | Three site settings: login notice, maintenance mode, information banner |
| Non-auth rows (target policy, io, display, history: ST-101 to ST-164, ST-209 to ST-215) | Their consumers read `Config` (environment) directly, not the resolver; no stored value would ever be read | **Not editable in this module** (Q1) |
| ST-220 settings export/import | Not built | Out (FUTURE.md) |
| ST-021 / hardening items | unchanged | Out |

## 1. Assumptions (correct me now)
1. The existing precedence stays (`SPEC/12` section 2, SEC-TGT-150): `.env` limit, then stored value, then `.env` default, then built-in. In the code the bounds of a number are the floor and ceiling of `AUTH_SETTINGS`; the `.env` value is the default, except for the five keys whose `.env` value is a limit by rule (`mfaScope` floor, `mfaRoles` floor, `mfaGraceMs` ceiling, `mfaFactors` and `primaryCredentials` envelope). No new per-setting min/max variables (Q2).
2. Keys with `source: 'env'` (`totpWindow`, `argon2*`, `setupTokenValidityMs`, `loginRecall`, `stepUpWindowMs`) and `wizard` (`loginMode`) are shown read-only with their source. `loginAutofocus` (`source: 'ui'`) is a per-user preference elsewhere and is not on this page.
3. Account mode with the SQLite store only. Direct mode and stateless installs have no store: the page is read-only with source `.env` (map Q7). The login notice in direct mode comes from `.env` only (`DBLOOM_LOGIN_NOTICE`). Maintenance mode and the information banner do not exist in direct mode (no administrators to exempt, no stored settings; `DBLOOM_MAINTENANCE` is ignored there).
4. Every write needs administrator role, a completed second factor state (`full` session) and **step-up** (`requireRecentFactor`, purpose `settings.write`), including the banner. The relaxation for the banner (ST-219 says step-up only if shown pre-login) and the "step-up set" belong to `admin-protect`; this module is uniformly strict (Q3).
5. A write is one request per setting row ("save" on a row). Concurrent edits by two administrators: the write carries the `updatedAt` it was based on and is refused with `settings_conflict` when the stored row changed since.
6. The resolver caches for 5 s in two places (`runtime.ts`, `signin-runtime.ts`). A write invalidates both caches in the same process, so the writer sees the effect at once and nobody waits longer than 5 s.
7. No commit and no new dependency without a go. None is needed.

## 2. Objective
Let administrators view and change the editable settings from the application, with the same limits, audit and recovery the specs promise, and give them the three site settings that need the editor (login notice, information banner, maintenance mode). Users: administrators. Success: every editable key can be changed and reset from `/admin/settings` within its bounds; every change writes an audit row with old and new value first and is aborted when that write fails; the page shows stored, effective, source, range and lock per key; maintenance mode keeps users out and administrators in; nothing outside the bounds is accepted.

## 3. Commands
```
Build:         npm run build
Unit/integr.:  npx vitest run tests/settings-*.test.ts
All tests:     npm test
Typecheck:     npm run typecheck
Lint:          npm run lint
UI mock specs: npm run test:e2e:auth-ui
Live account:  npm run test:e2e:auth-live
CLI:           node .output/cli/dbloom.mjs settings list | reset <key> | maintenance off
```

## 4. Project structure
```
src/server/auth/types.ts                 registry: group + label key + kind per key; three new keys; AuthSettingsResolver += describe, set, reset, invalidate (changed)
src/server/auth/settings.ts              describe(), validated set(), reset(), clamp notices                                                      (changed)
src/server/settings-service.ts           admin service: role check, step-up, audit-first write, conflict check, narrowing preview               (new)
src/server/settings-runtime.ts           wiring, cache invalidation of both resolvers                                                            (new)
src/server/settings.functions.ts         getSettings, setSetting, resetSetting, previewSetting (thin imports only)                               (new)
src/server/maintenance.ts                state from the resolver (on, ends at, forced by env); guard used by the server-function middleware     (new)
src/server/middleware.ts                 maintenance check for non-administrators                                                                (changed)
src/server/store/sqlite-store.ts         deleteSetting                                                                                           (changed)
src/server/audit/events.ts               settings.change, settings.reset, settings.clamp                                                         (changed)
src/server/env-registry.ts, config.ts    DBLOOM_SETTINGS_LOCK, DBLOOM_MAINTENANCE                                                                (changed)
src/server/auth/cli/main.ts              settings list, settings reset, maintenance off                                                          (changed)
src/routes/admin.settings.tsx            page                                                                                                    (new)
src/components/auth/settings/            page, row editor, preview dialog                                                                         (new)
src/components/auth/auth-home.tsx, ...   login notice on the sign-in page, information banner after login, maintenance state                        (changed)
src/lib/auth/mock-settings.ts, mock-api.ts, api.ts    mock layer                                                                                (new/changed)
src/i18n/settings.json                   texts                                                                                                   (new)
tests/settings-*.test.ts, e2e/auth-ui-settings.spec.ts, e2e/auth-live-settings.spec.ts
docs/deploy.md                           section "Settings and maintenance mode"                                                                 (changed)
```

## 5. Requirements

### 5.1 Functional
| ID | Requirement | Verification |
|---|---|---|
| FR-ASE-001 | **Description.** `describe()` returns for every key of the registry: group, kind (number, boolean, choice, list, text), unit, the stored value or none, the effective value, the source (`limit`, `ui override`, `.env default`, `built-in`), floor and ceiling or envelope, whether it is locked, and whether it is editable. Stored and effective differ visibly when the effective value was clamped or narrowed. The values of secret-bearing settings do not exist (none of the keys holds a secret; a test pins this against the registry). | Unit: each source; clamp case shows stored and effective; locked and env-only keys not editable. |
| FR-ASE-002 | **Write.** `set(key, value, basedOn)` validates with the key's schema and refuses (`settings_invalid`) a value outside floor and ceiling or outside the envelope (no silent clamp on write, SEC-TGT-142). It refuses `env`, `wizard` and locked keys (`settings_locked`) and a stale `basedOn` (`settings_conflict`). | Unit: range edges, list envelope, locked, conflict. |
| FR-ASE-003 | **Audit first.** Before the store write the service calls `auditRequired('settings.change', {key, old, new, actor})`; when that throws, nothing is stored and the caller gets a refusal (NFR-TGT-145). `old` and `new` are the effective values. | Unit: audit before write; failing audit leaves the store unchanged; row has both values. |
| FR-ASE-004 | **Reset.** `reset(key)` deletes the stored value (the key returns to `.env` default or built-in), same role, step-up and audit-first rule (`settings.reset`, old and new effective). | Unit and live. |
| FR-ASE-005 | **Step-up and role.** Every write and reset needs an administrator session in state `full` and a recent factor. Reading the page data needs the administrator role only. Non-administrators and direct mode get the same answers as `exposure.functions`. | Function test matrix (role, state, step-up, mode). |
| FR-ASE-006 | **Lock.** `DBLOOM_SETTINGS_LOCK` (comma list of registry keys) locks those keys: shown read-only with source `.env (locked)`, writes and resets refused. An unknown key in the list refuses startup (strict config). | Config test, service test. |
| FR-ASE-007 | **Clamp audit.** When a stored value is outside its current limits the resolver uses the clamped value and `settings.clamp` is written once per distinct (key, stored, effective) per process, not per read (`SPEC/12` section 2). It never rewrites the store. | Unit with repeated resolves. |
| FR-ASE-008 | **Narrowing preview (ST-056, ST-057).** Before saving a narrowed `mfaFactors` or `primaryCredentials`, `previewSetting` returns the number of active users who would be left without any allowed factor or primary credential. A count above zero refuses the write (`settings_strands_users`); the page shows the count. Widening and other keys: no preview. | Unit with users holding only TOTP, only passkey, both. |
| FR-ASE-009 | **Login notice (ST-216).** Key `loginNotice`: plain text, 0 to 300 characters, default empty. Shown on the sign-in page above the form as text only (never HTML); no other pre-login page (Q4). Audit with old and new text. Direct mode: `DBLOOM_LOGIN_NOTICE`. | Unit (length), mock spec (shown, escaped), live. |
| FR-ASE-010 | **Information banner (ST-219).** Key `infoBanner`: plain text, 0 to 500 characters, default empty, shown to every signed-in user on the connection home and the admin pages as a dismiss-free, non-blocking banner. Not shown before login. | Mock spec, live. |
| FR-ASE-011 | **Maintenance mode (ST-218).** Keys `maintenanceOn` (boolean, default off) and `maintenanceEndsAt` (absolute time in ms, optional); `DBLOOM_MAINTENANCE` truthy forces it on and the UI cannot switch it off (locked, source `.env`). Active means: forced, or on with no end time, or on with end time in the future; it ends by itself at the end time (computed on read, no timer). While active a non-administrator gets the refusal `maintenance` from every server function except the ones the sign-in page needs to show the state, and cannot complete a sign-in; administrators and the CLI are exempt. `/api/ready` and `/api/health` stay as they are. Existing user sessions are kept, only blocked. The sign-in page and the home page show "Maintenance" with the end time when set. | Unit (active rules, end time), function test (user blocked, administrator allowed), live: user refused, administrator works, switch off, user works. |
| FR-ASE-012 | **Owner can always switch off.** `dbloom maintenance off` (CLI, store access, no HTTP) deletes the stored `maintenanceOn`; with `DBLOOM_MAINTENANCE` set the command says so and does nothing. It writes the audit row through the sink (actor `cli`). `dbloom settings list` prints the `describe()` text; `dbloom settings reset <key>` resets one key (also the recovery path for a bad value, same rules except step-up and role). | CLI integration test. |
| FR-ASE-013 | **Page.** `/admin/settings` (administrators only; direct mode and no session go to the front page like `/admin/exposure`): sections by group, per row label, effective value, source pill, range text, an input matching the kind, Save and Reset, the stored value when it differs, an error text per row, the preview count for narrowing. Locked and env-only rows read-only. Link from the connection home and the switcher next to Users, Audit, Exposure. Exposure banner is shown like on the other admin pages. | Mock spec: view, change, reset, refuse, conflict, locked, preview, axe light and dark, phone width. |
| FR-ASE-014 | **Propagation.** A successful write or reset invalidates the resolver caches of the process (both) so the next request sees the new value. | Unit: effective value changes at once. |
| FR-ASE-015 | **Existing consumers.** The notice thresholds (`noticeBurst*`, `noticeLocationDays`) and `auditRetentionDays` become editable through this page with no consumer change (they already read the resolver). A test iterates the registry and checks that every `ui_within_env` key has at least one reader of the resolved value, so a key never appears on the page with no effect. | Test over `src`. |

### 5.2 Non-functional
- A write is audit, then one store statement. A crash between the two leaves an audit row for a change that did not happen; the page then shows the stored value unchanged. Accepted and documented (audit first is the rule, NFR-TGT-145).
- `describe()` is computed from the registry and the store in one read; no per-key query.
- Accessibility: same checks as the other admin pages (labels, errors in text, axe clean light and dark, no horizontal scroll at 375 px). Texts in `src/i18n/settings.json` with the existing translation pattern.
- The `*.functions.ts` import list is pinned by a test (thin modules only), as for `exposure.functions.ts`.
- No secret appears in the page, audit row or CLI output (`redact.ts` stays in the path).

### 5.3 Security notes
- Every key is declared in code with its bounds, so the API cannot invent a key or set a bound.
- Text settings are stored and rendered as plain text (React text node, never `dangerouslySetInnerHTML`), length-checked on the server, control characters (except newline in the banner) refused.
- Maintenance mode is a lever for denial of service by a stolen administrator session; the answers are step-up on the write, the CLI and `.env` as the owner's off switch, and the audit row. Stronger cover (cooling-off, auto-revert) is `admin-protect`.

## 6. Testing strategy
- Unit and integration (`vitest`, real SQLite store): resolver `describe`, `set`, `reset`, clamp audit, locks, conflict, audit-first order with a failing sink, narrowing count, maintenance rules with a fake clock, text length and control characters, registry-wide checks (every key has a group and label, every editable key has a reader, import list of the functions file).
- Mock layer (`auth-ui-settings.spec.ts`): whole page flow, error states, banner and notice rendering, axe in both themes, phone width.
- Live (`auth-live-settings.spec.ts`) on a built server: change and reset a number and a list, audit rows with old and new in the viewer, locked key refused, failing audit sink aborts the change (file sink on an unwritable path), maintenance on, user refused, administrator allowed, off, user allowed, login notice visible on the sign-in page, banner visible after sign-in, CLI `maintenance off` while on.
- CLI integration against the built bundle (rebuild the CLI after the server build).

## 7. Boundaries
- Always: audit before write; reject out-of-range, never clamp on write; text as text; settings page for administrators only; run `vite build` after touching `*.functions.ts`.
- Ask first: new dependency; new `.env` variable beyond the two listed; a migration (none planned: the `settings` table is key/value).
- Never: edit a setting from the browser without step-up in this module; store a secret in `settings`; hide a clamped value; render stored text as HTML.

## 8. Success criteria
1. For one environment, `describe()` and the page agree and show stored, effective, source and range per key; locked and env-only keys cannot be changed.
2. A change writes `settings.change` with old and new first; with a failing audit write the value is unchanged and the page says the change was not made.
3. Out-of-range values and stale edits are refused with a row-level text; reset returns the key to its default.
4. Narrowing the second factors or primary credentials that would strand users is refused with the count.
5. Login notice shows on the sign-in page and the banner after sign-in, as plain text.
6. Maintenance mode blocks non-administrators and not administrators, ends at its end time, is forced by `DBLOOM_MAINTENANCE`, and `dbloom maintenance off` works while the server runs.
7. `docs/deploy.md` describes the page, locks, maintenance mode and the CLI switch.

## 9. Out of scope (recorded in `SPEC/FUTURE.md` when the module is accepted)
Editing target policy, io, display and history settings (consumers must move to the resolver first); per-user preferences (ST-113, ST-117, ST-212 to ST-215); settings export and import (ST-220); AI settings (ST-225); version check (ST-209); the step-up set, lockout warning, auto-revert and cooling-off (`admin-protect`); the administration plane (`admin-plane`).

## 10. Questions for the owner
Recommendations are the assistant's; 1 and 3 change module scope.

| # | Question | Recommendation |
|---|---|---|
| 1 | The map lists target, io, display and site settings. Their consumers read the environment, not the resolver, so a stored value would do nothing. Edit only the 36 auth keys plus the three site keys now, or move the consumers of the others into this module? | Auth keys plus the three site keys now. Later modules move their own consumers (`hardening`, a settings follow-up) and register their keys; the registry and page take them with no change. |
| 2 | SEC-TGT-142 says `.env` gives floor and ceiling per setting. The code has fixed floors and ceilings and uses the `.env` value as the default (limits only for five keys). Add per-key `.env` min and max variables? | No. Keep the code bounds; `DBLOOM_SETTINGS_LOCK` is the owner's fence. A deployment that needs a tighter bound locks the key at its `.env` value. |
| 3 | Step-up on every write now (including the banner), or the per-key set of ST-216/219 right away? | Uniform step-up now; the set is `admin-protect`. |
| 4 | Login notice on the sign-in page only, or also on other pre-login pages (invite, recovery, setup)? | Sign-in page only; fewer pre-login surfaces for a phishing text. |
| 5 | Maintenance mode blocks non-administrators from every server function and from sign-in, existing sessions kept. Also end existing user sessions when it starts? | Keep sessions (blocking is enough, and ending them logs users out of unsaved work). |
| 6 | "Schema migrations set maintenance mode automatically" (ST-218): migrations run at start, before the server listens, so nobody is served during one. Build an automatic switch anyway? | No; note it in the deploy guide as covered by start order. |
| 7 | Settings CLI: only `maintenance off` and `settings reset <key>` plus `list`, or also `settings set`? | The three; `set` needs the full validation path from the shell and adds nothing the UI lacks. |
