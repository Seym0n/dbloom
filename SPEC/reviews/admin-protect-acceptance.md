# Acceptance: admin-protect (SPEC/33)

Date: 2026-11-04. Tasks 1 to 6 done.

## Results

| Check | Result |
|---|---|
| `npm test` | 132 files, 3212 passed, 4 skipped, 0 failed |
| `npm run test:e2e:auth-ui` (`e2e/auth-ui-protect.spec.ts`, 9 tests, axe light/dark, 375 px) | passed (task 5) |
| `npx playwright test -c playwright.account.config.ts auth-live-protect` (5 tests, `DBLOOM_AUTOREVERT_MINUTES=1`) | 5 passed, 4.4 min |
| typecheck, eslint | clean |

## Requirements

| FR | Evidence |
|---|---|
| FR-APR-001 step-up set | `tests/protect-stepup-set.test.ts` |
| FR-APR-003 guarded set | `tests/protect-guarded.test.ts` |
| FR-APR-006 apply and arm | `tests/protect-pending.test.ts`; live test 1 (row, `revert_to` null, `settings.pending`) |
| FR-APR-007 confirm | `tests/protect-service.test.ts`; live test 3 (same session refused, new session confirms, value kept past the deadline) |
| FR-APR-008 cancel | unit; auth-ui "Revert now" |
| FR-APR-009 revert | unit with fake clock; live test 2 (nobody signed in, `settings.revert`, old value back) |
| FR-APR-010 timer and restart | unit; live test 4 (restart keeps `deadline_at`, `revert_to`; overdue change reverted) |
| FR-APR-011 page | auth-ui spec; live test 1 (row note, pending line) |
| FR-APR-012 describe | `tests/protect-guarded.test.ts` |
| FR-APR-013 CLI | `tests/protect-cli.test.ts`; live test 5 (`reset` marks `superseded`, old timer leaves it alone, `settings pending` empty) |
| FR-APR-014, 015 | unit |
| FR-APR-002, 004, 005 | removed by the owner 2026-11-04 |

## Deviations

- No runtime guard on unknown step-up purposes (FR-APR-001): the source scan covers every call.
- No `listPending` function: `describe()` carries `pending` (FR-APR-012).
- No impact count (SEC-TGT-144) and no countdown: owner decision, `SPEC/FUTURE.md` FU-protect-impact-count.

## Open

- Owner visual review of the settings page pending line and the one-line link on the other admin pages.
- Deferred ideas: FU-protect-cooling-off, FU-protect-versioned-rollback.
