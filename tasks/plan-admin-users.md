# Plan: module `admin-users`
Spec: SPEC/30-module-admin-users.md (approved 2026-11-03, Q1 to Q7 as recommended). Map: SPEC/28-admin-capability-map.md. Depends on auth-account, admin-audit.

Order (sequential; each ends at a green checkpoint: typecheck, lint, vitest, relevant e2e, and `vite build` when a `*.functions.ts` or its imports changed):
1. Schema and settings: migration 7 (`user_notices.detail`, `seen_locations`), notice kinds, `detail` in the notice type and store, `seen_locations` store methods and sweep purge, three variables (registry, config, `.env.example`, generated deploy table), setting keys, notice strings (FR-AUS-004; groundwork for 001, 002).
2. Detector and sign-in hook: `src/server/auth/notices.ts`, calls from `signin.ts` on failed steps and completed sign-ins (FR-AUS-001, 002).
3. Server side of the panel: `dismissNotice` server function (list reuses `listNotices`, which now returns detail), gate lists, own-notices-only tests (FR-AUS-003 server).
4. UI: notices panel on the Users page, Activity action, `actor` search parameter on `/admin/audit`, mock layer, auth-ui spec extension (FR-AUS-003, 005).
5. Live spec for the Users page and the notice flow, deploy note, acceptance walk-through (FR-AUS-006, 007).

Dependency graph: 1 → 2 → 3 → 4 → 5 (4 can start on the mock layer once 3 fixes the function shapes).

## Risks
- **Sign-in path.** The detector runs inside `signin.ts`; an exception there must never fail a sign-in. Mitigation: wrap in a try/catch that logs once per minute; a test makes the detector throw and checks the sign-in still succeeds.
- **Store schema 7 and the CLI bundle.** An older `.output/cli/dbloom.mjs` refuses schema 7 (as happened at schema 6). Mitigation: rebuild the CLI bundle in the task 1 checkpoint and name it in the todo.
- **Client chunk rule.** Any server-only import reachable from a `*.functions.ts` breaks `vite build` or the browser (found twice in admin-audit). Mitigation: keep `auth.functions.ts` additions thin; run `vite build` after tasks 3 and 4.
- **Burst counter memory.** An in-memory map keyed by account and address can grow under a spray. Mitigation: prune entries older than the window on each call and cap the map size (oldest dropped); unit test for the cap.
- **Address source.** The detector needs the effective client address (FR-SVR-005), which the sign-in services receive as `address` today; confirm both password and passkey paths pass it. Mitigation: task 2 reads both paths first and tests both.
- **Detail leaks.** Notice detail holds an account name and an address prefix. Mitigation: address goes through the audit anonymiser; a test seeds a secret-shaped value and finds it nowhere.
- **Existing Users specs.** The panel adds a landmark to the page; existing `auth-ui-users` specs must stay green (list selectors are scoped by role and name).

## Verification checkpoints
After 1: migration test, config tests, `gen-env-docs --check`, CLI bundle rebuilt. After 2: detector unit tests, full vitest. After 3: server function tests, `vite build`. After 4: `npm run test:e2e:auth-ui`. After 5: `npm run test:e2e:auth-live`, full vitest, lint, typecheck, build.
