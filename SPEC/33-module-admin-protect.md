# 33 — Module spec: `admin-protect` (step-up set, auto-revert)

**Status: APPROVED by the owner (2026-11-04), open questions all as recommended. Plan and tasks: `tasks/plan-admin-protect.md`, `tasks/todo-admin-protect.md`. Owner decisions so far: apply at once, auto-revert kept, no countdown display, no impact count, no info banner.** Written with the spec-driven-development skill (Phase 1) for module id `admin-protect` of `SPEC/28-admin-capability-map.md`. Depends on `admin-settings` (built, `SPEC/32`: writer, service, preview, page) and `admin-audit` (built, `SPEC/29`). `admin-plane` is deferred, so IP allow/deny lists (ST-011, 012, 014) do not exist and are not guarded here. No plan, task list or code exists yet; planning starts after this spec is approved.

## 0. Gap analysis (map versus code)
| Row | State today | What this module does |
|---|---|---|
| SEC-TGT-143, ST-093 (step-up set) | `requireRecentFactor` is called with a purpose on every admin write: `settings.write`, `user.create`, `user.status`, `user.role`, `user.delete`, `user.revoke_sessions`, `invite.issue`, `invite.revoke`, `recovery.issue`, `audit.export`. The set is implicit: scattered call sites, no single list, nothing fails when a new action forgets step-up. `admin-settings` is uniformly strict | One declared `STEP_UP_SET` in code, a test that scans admin functions and fails on an action outside it. Step-up stays uniform (no banner relaxation: owner sees no need for the info banner, 2026-11-04) |
| ST-034 (step-up window, ENV-only 1 to 15 min, default 5) | **Done**: `stepUpWindowMs`, `source: 'env'`, `DBLOOM_STEPUP_MINUTES`, used by `stepup.ts` | Nothing |
| SEC-TGT-144 (impact warning with affected-user count, explicit confirmation) | `previewSetting` refuses a narrowing of `mfaFactors` or `primaryCredentials` that strands users (FR-ASE-008) | **Dropped by the owner (2026-11-04)**: no impact count, no count confirmation. FR-ASE-008 stays. Deviation from SEC-TGT-144 recorded in FUTURE.md |
| SEC-TGT-144, ST-035 (auto-revert, persisted absolute deadline, restart-safe) | **Not built**: no `DBLOOM_AUTOREVERT_MINUTES`, no `pending_settings` table, no timer, no sweep | New table (migration 8), timer plus startup sweep, confirm and cancel, page banner |
| SEC-TGT-144 (lockout by IP lists, effective client address, SEC-TGT-127) | IP lists not built (`admin-plane` deferred) | **Out**; `GUARDED_KEYS` is the place the lists plug into later |
| SEC-TGT-144 (CLI reset restores access) | `settings reset <key>` and `maintenance off` exist | Reset also cancels a pending change of that key; new `settings pending` |
| SEC-TGT-143 (cooling-off for loosening, ST-036) | Not built | **Deferred** (map Q5), recorded in FUTURE.md |
| SEC-TGT-144 (versioned settings, one-click rollback for non-lockout settings) | Those settings are not editable yet (`admin-settings` Q1) | **Out** (FUTURE.md); revert here covers the guarded keys only |

## 1. Assumptions (correct me now)
1. Account mode with the SQLite store only, as `admin-settings`. Direct mode has no store and no editor, so nothing here applies.
2. Step-up stays one window for every purpose (ST-034); this module does not add per-action windows.
3. **Guarded set** (code constant, not configurable): the keys whose change can lock administrators or users out of DBLoom itself (SPEC/12 C-02):
   - second factor: `mfaScope`, `mfaRoles`, `mfaFactors`, `primaryCredentials` (ST-054, 056, 057)
   - login throttling: `loginFailures` and the two ST-077 keys and the ST-078 key (names from the registry)
   - session lifetimes: `adminSessionIdleMs`, `adminSessionAbsoluteMs` (ST-069, 070)
   Everything else in the editor applies at once as today. `sessionsPerUser` (ST-071) is not in the C-02 list and stays unguarded.
4. A guarded change **applies at once** and is reverted by a timer unless confirmed (SEC-TGT-144: "apply with automatic revert"). It is not held back.
5. The revert target is the last confirmed configuration: the stored value (or none) as it was before the first unconfirmed change of that key.
6. **Confirmation proves the new configuration works**: it needs an administrator session in state `full` that was **created after** the change (a sign-in made under the new settings), or the same account signing in again. Step-up is not required for confirming or reverting (SEC-TGT-143: "automatic revert needs no step-up").
7. One pending row per key. A further guarded change of a key that is already pending keeps the original revert target and restarts the deadline.
8. The revert is a safety net and must not depend on the audit sink: its audit write is best-effort (like the CLI), the revert itself always happens.
9. Single process, single SQLite file. No multi-instance coordination beyond an atomic status update.
10. New `.env` variable: `DBLOOM_AUTOREVERT_MINUTES` (ST-035, 1 to 15, default 5). Step-up window variable already exists. No new dependency; one migration (8).

## 2. Objective
Make a stolen or careless administrator session unable to lock everybody out or silently weaken sign-in, without slowing ordinary settings work: every admin write is covered by one declared step-up set; a change in the guarded set shows who it affects and needs explicit confirmation; and it reverts by itself after the auto-revert period unless an administrator confirms it from a session that signed in under the new configuration, including after a restart. Users: administrators. Success: a guarded change that breaks sign-in is gone within the period without anyone's help; one that works becomes permanent with one click.

## 3. Commands
```
Build:         npm run build
Unit/integr.:  npx vitest run tests/protect-*.test.ts tests/settings-*.test.ts
All tests:     npm test
Typecheck:     npm run typecheck
Lint:          npm run lint
UI mock specs: npm run test:e2e:auth-ui
Live account:  npm run test:e2e:auth-live
CLI:           node .output/cli/dbloom.mjs settings pending | settings reset <key>
```

## 4. Project structure
```
src/server/auth/step-up-set.ts           STEP_UP_SET (purpose id, area, relaxation), isInStepUpSet()                                  (new)
src/server/settings-guard.ts             GUARDED_KEYS, guarded(key)                                                               (new)
src/server/settings-pending.ts           pending store ops, apply/confirm/cancel/revert, sweep, timer                                (new)
src/server/settings-service.ts           guard in set/reset, confirm and cancel                                        (changed)
src/server/settings-admin-runtime.ts     wiring, timer start, startup sweep                                                          (changed)
src/server/settings.functions.ts         confirmPending, cancelPending, listPending (thin imports only)                              (changed)
src/server/store/sqlite-store.ts         pending_settings table ops, migration 8                                                     (changed)
src/server/audit/events.ts               settings.pending, settings.confirm, settings.cancel, settings.revert                        (changed)
src/server/env-registry.ts, config.ts    DBLOOM_AUTOREVERT_MINUTES                                                                   (changed)
src/server/auth/cli/main.ts              settings pending; settings reset cancels pending                                            (changed)
src/components/auth/settings/            guarded row note, pending line (no countdown), confirm and cancel                  (changed)
src/lib/auth/mock-settings.ts, mock-api.ts, api.ts    mock layer                                                                     (changed)
src/i18n/settings.json                   texts                                                                                       (changed)
tests/protect-*.test.ts, e2e/auth-ui-protect.spec.ts, e2e/auth-live-protect.spec.ts
docs/deploy.md                           section "Protected settings and auto-revert"                                                (changed)
```

## 5. Requirements

### 5.1 Functional
| ID | Requirement | Verification |
|---|---|---|
| FR-APR-001 | **Step-up set.** `STEP_UP_SET` lists every purpose that needs step-up (16 entries after the scan: the ten of section 0 plus `passkey.add`, `passkey.remove`, `totp.add`, `totp.remove`, `recovery.regenerate`, `mfa.disable` from `account-security.ts`), each with its area. A static test scans `src/server` for `requireRecentFactor(` and `sensitive(` calls and fails on a literal purpose outside the set, on a set entry with no caller, and on a non-literal purpose outside the known pass-through files. No runtime check (deviation, 2026-11-04: existing tests call `requireRecentFactor` with ad-hoc purposes and the scan already covers every call site). | Unit plus source scan. |
| FR-APR-002 | *(removed 2026-11-04: banner relaxation, owner sees no need for the info banner. Step-up stays uniform for every key.)* | |
| FR-APR-003 | **Guarded set.** `GUARDED_KEYS` is the constant of section 1.3; a test pins it against the registry (every entry exists, `ui_within_env`; a registry key is guarded only when listed). | Unit. |
| FR-APR-004 | *(removed 2026-11-04: impact count dropped by the owner. FR-ASE-008 keeps refusing a narrowing that strands users.)* | |
| FR-APR-005 | *(removed 2026-11-04: count confirmation dropped with FR-APR-004.)* | |
| FR-APR-006 | **Apply and arm.** An accepted guarded write follows `admin-settings` (audit first, store write) and in the same transaction inserts or updates `pending_settings` (`key`, `revert_to` stored value or null, `new_value`, `new_updated_at`, `actor`, `created_at`, `deadline_at` absolute ms, `status = pending`). `settings.pending` is audited with old, new and deadline. The deadline is `now + autoRevertMs`, `autoRevertMs` from `DBLOOM_AUTOREVERT_MINUTES`. | Unit: row, deadline, audit; second write keeps `revert_to`, moves deadline. |
| FR-APR-007 | **Confirm.** `confirmPending(key)` needs an administrator session in state `full` with `session.createdAt >= pending.created_at` (sign-in after the change); else refuses `settings_confirm_session` ("sign in again with the new settings, then confirm"). On success status becomes `confirmed`, the stored value stays, `settings.confirm` is audited. No step-up. | Service matrix: old session refused, new session passes, user and anonymous refused. |
| FR-APR-008 | **Cancel.** `cancelPending(key)` (administrator, `full`, step-up not required) reverts at once, same effect as the deadline passing, audited as `settings.cancel`. | Unit. |
| FR-APR-009 | **Revert.** When `deadline_at` passes and status is still `pending`, one atomic update (`WHERE status = 'pending'`) sets `reverted` and restores `revert_to` (delete the stored row when null); caches of both resolvers are invalidated; `settings.revert` is audited best-effort with actor `system`. If the stored row's `updatedAt` no longer equals `new_updated_at` (changed by the CLI or another write) the pending row becomes `superseded` and nothing is restored. Revert needs no step-up and no session. | Unit with fake clock: revert, null target, superseded, double fire safe. |
| FR-APR-010 | **Timer and restart.** The service arms one timer for the nearest deadline (`unref`, re-armed after each change) and runs a sweep at process start, so an overdue change reverts at boot and a future one is re-armed with its original deadline. Every settings service call and `describe()` also runs the sweep first, so a missed timer (suspended process) cannot leave an expired change in force. | Integration: pending row, restart simulated with a new service instance, deadline kept; overdue reverted at boot. |
| FR-APR-011 | **Page.** `/admin/settings` marks guarded keys with a short note on the row ("reverts in N minutes unless confirmed after signing in again") and, for pending changes, shows a static line at the top (no live countdown, owner 2026-11-04): key, new value, the deadline as an absolute local time, Confirm and Revert now buttons, and the text that confirming needs a sign-in made after the change. The pending state also appears in the exposure banner area of the other admin pages as one line with a link. | Mock spec: row note, pending line, confirm refused for old session, confirm, cancel, axe light and dark, phone width. |
| FR-APR-012 | **Describe.** `describe()` marks a guarded key (`guarded: true`) and a pending key (`pending: { newValue, deadlineAt, actor }`); the value shown as effective is the applied new value. | Unit. |
| FR-APR-013 | **CLI.** `settings pending` lists pending rows (key, new value, deadline); `settings reset <key>` and `maintenance off` cancel the pending row of the key as `superseded` (store access, no HTTP, actor `cli`, no step-up). | CLI integration test. |
| FR-APR-014 | **Reset and maintenance.** `reset` of a guarded key follows the same guard as `set` (pending with `revert_to` the value before the reset). The maintenance keys are not guarded (`admin-settings` already keeps the owner's off switch). | Unit. |
| FR-APR-015 | **Hook for later keys.** A key becomes guarded by adding it to `GUARDED_KEYS`; the IP lists of `admin-plane` and the effective client address check (SEC-TGT-127) plug in there with no change to the pending table or the page. | Unit with a fake guarded key. |

### 5.2 Non-functional
- One extra table read per settings call (indexed on `status`); the sweep does nothing when no row is pending.
- A crash between the audit row and the store write follows `admin-settings` (audit first, accepted); the pending row and the setting change commit in one SQLite transaction.
- The revert never depends on the audit sink or a session; a failing sink only loses its audit row, which is itself logged to stderr.
- Accessibility, translations, thin functions file and import-list pin as in `admin-settings`; the deadline is plain text, no ticking timer.
- No secret appears in the pending table, audit rows or CLI output.

### 5.3 Security notes
- A stolen administrator session can still make a guarded change once it passes step-up, but cannot make it permanent: confirming needs a later sign-in, which needs a credential the thief lacks.
- Guarded changes are the lockout vector; the failure mode is covered by revert, the owner's recovery path stays the CLI (`settings reset`), and the CLI is not subject to the timer.
- Without an impact warning, an administrator gets no preview of who a guarded change affects; the auto-revert is the only cover (owner decision 2026-11-04).
- Cooling-off (ST-036) is not built, so a thief's loosening takes effect at once for unguarded keys; the mitigations are step-up and the audit row.

## 6. Testing strategy
- Unit and integration (`vitest`, real SQLite store, fake clock): set and scan test, guarded-key pin, pending lifecycle (arm, re-arm, confirm, cancel, revert, superseded), restart simulation, timer with fake timers, best-effort audit on revert.
- Mock layer (`auth-ui-protect.spec.ts`): row note, pending line with deadline time, confirm and revert, refusals, axe, phone width.
- Live (`auth-live-protect.spec.ts`) on a built server with `DBLOOM_AUTOREVERT_MINUTES=1`: change `mfaScope` so the tester needs a factor, wait, see the revert without action; change, sign in again, confirm, wait, still applied; restart server during a pending change and see the deadline kept; CLI `settings reset` clears it.
- CLI integration against the built bundle (rebuild the CLI after the server build).

## 7. Boundaries
- Always: absolute deadlines in the store; revert independent of audit and sessions; text and counts rendered as text; run `vite build` after touching `*.functions.ts`.
- Ask first: further `.env` variables beyond `DBLOOM_AUTOREVERT_MINUTES`; adding a key to `GUARDED_KEYS`; another migration.
- Never: let the UI set the auto-revert period (ENV-only, ST-035); require step-up to confirm or revert; make a pending change permanent without a post-change sign-in; edit settings from the browser without step-up.

## 8. Success criteria
1. Every admin write purpose is in `STEP_UP_SET`; a new write that forgets step-up fails the scan test.
2. A guarded row says it reverts unless confirmed; a guarded save creates a pending row with the deadline.
3. An unconfirmed guarded change is reverted at the deadline with no one signed in, and the page and audit viewer show `settings.revert`.
4. A restart during a pending change keeps the original deadline; an overdue change is reverted at boot.
5. Confirming works only from a session signed in after the change; afterwards the change stays and `settings.confirm` is audited.
6. The CLI reset restores a guarded key and clears its pending row while the server runs.
7. `docs/deploy.md` describes the guarded keys, the auto-revert period, confirming and the CLI recovery.

## 9. Out of scope (recorded in `SPEC/FUTURE.md` when the module is accepted)
Impact count and count confirmation of SEC-TGT-144 (owner, 2026-11-04); step-up relaxation for the info banner (owner sees no need for the banner); cooling-off for loosening (ST-036); IP allow/deny lists, effective-address lockout check and administrator-network rule (`admin-plane`, SEC-TGT-127, 147); versioned settings with one-click rollback for non-lockout settings (SEC-TGT-144, after their consumers move to the resolver); per-action step-up windows; multi-instance pending coordination.

## 10. Questions for the owner
Recommendations are the assistant's; 1 and 3 change behaviour you may have an opinion on.

| # | Question | Recommendation |
|---|---|---|
Owner decisions 2026-11-04: info banner not needed (old Q1 void), impact count not needed (old Q5 void). Remaining, renumbered:

| # | Question | Recommendation |
|---|---|---|
| 1 | Guarded set (section 1.3): includes the throttling keys and both admin session lifetimes, not `sessionsPerUser`. Right set? | As listed; follows SPEC/12 C-02. |
| 2 | A guarded change applies at once and reverts unless confirmed (SEC-TGT-144 wording), versus held back until confirmed. | Apply at once: it tests the real configuration, which is the point of the sign-in confirmation. |
| 3 | Confirming needs a session created after the change. Accept the same account signing in again, or require a different administrator when more than one exists? | Same account may confirm; the point is proving sign-in works, not four-eyes. |
| 4 | `DBLOOM_AUTOREVERT_MINUTES` default 5 (range 1 to 15, ST-035) or 3 (APP-38 note)? | 5, same as the step-up window. |
| 5 | Revert audit best-effort (FR-APR-009, assumption 8) rather than fail-closed like other settings writes? | Best-effort: a safety net that stops when the sink is down is worse than a missing row. |
