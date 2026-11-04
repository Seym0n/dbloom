# Plan: module `admin-protect`
Spec: SPEC/33-module-admin-protect.md (approved 2026-11-04: apply at once, auto-revert kept, no countdown, no impact count, no info-banner relaxation; open questions all as recommended: default 5 min, same account may confirm, revert audit best-effort). Map: SPEC/28-admin-capability-map.md. Depends on admin-settings (writer, service, page) and admin-audit.

Order (sequential; each ends at a green checkpoint: typecheck, lint, vitest, relevant e2e, `vite build` when functions files change, CLI rebuild after the server build):
1. Step-up set: `STEP_UP_SET`, scan test, non-production guard in `requireRecentFactor` (FR-APR-001).
2. Guarded set and storage: `GUARDED_KEYS`, `describe()` flags, migration 8 `pending_settings`, store ops, `DBLOOM_AUTOREVERT_MINUTES` (FR-APR-003, 012, part of 006).
3. Pending lifecycle: apply and arm in the same transaction as the write, confirm (post-change session), cancel, revert with superseded rule, timer, startup and per-call sweep, audit events (FR-APR-006 to 010, 014, 015).
4. Service, functions, CLI: wire into `settings-service.ts`, `confirmPending`/`cancelPending`/`listPending` (thin imports), `settings pending`, reset and `maintenance off` supersede pending (FR-APR-013).
5. UI: guarded row note, static pending line with deadline time, Confirm and Revert now, line on other admin pages, mock layer, auth-ui spec (FR-APR-011).
6. Live spec with `DBLOOM_AUTOREVERT_MINUTES=1`, deploy section, acceptance walk-through, FUTURE.md entries.

Dependency graph: 1 independent; 2 → 3 → 4 → 5 → 6.

## Risks
- **Revert vs concurrent change.** Another write or the CLI changes the key after the guarded change. Mitigation: `new_updated_at` compare, status `superseded`, nothing restored; test.
- **Timer missed (suspended process).** Mitigation: sweep at boot and at the start of every settings call and `describe()`; test with fake clock.
- **Double fire.** Timer and a settings call both revert. Mitigation: atomic `UPDATE ... WHERE status = 'pending'`; test.
- **Revert depends on audit.** Mitigation: best-effort audit, stderr on failure; test with failing sink.
- **Confirm proves nothing.** Mitigation: require `session.createdAt >= pending.created_at` and `full` state; test with old and new session.
- **Step-up scan false positives.** Non-literal purposes. Mitigation: scan only literal calls, require purposes to be constants from `STEP_UP_SET`.
- **Client chunk rule.** `settings.functions.ts` stays thin; pin test plus `vite build` after tasks 4 and 5.
- **Migration.** One migration (8), additive. Mitigation: migration test on a store at version 7.
- **Build flakes.** `EBUSY` on `vite build` (retry); rebuild CLI after server build.

## Verification checkpoints
After 1: scan test green, existing step-up tests unchanged. After 2: describe and store tests, migration 7 to 8. After 3: lifecycle tests with fake clock and simulated restart. After 4: function matrix, gate list, import pin, `vite build`, CLI integration. After 5: `npm run test:e2e:auth-ui`, axe light and dark. After 6: `npm run test:e2e:auth-live`, `npm test`, acceptance in `SPEC/reviews/admin-protect-acceptance.md`.
