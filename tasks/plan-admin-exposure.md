# Plan: module `admin-exposure`
Spec: SPEC/31-module-admin-exposure.md (approved 2026-11-03, Q1 to Q6 as recommended). Map: SPEC/28-admin-capability-map.md. Depends on server (`buildExposure`), admin-audit. Independent of admin-users; either can go first.

Order (sequential; each ends at a green checkpoint: typecheck, lint, vitest, relevant e2e, `vite build` when functions files change):
1. Warning ids: `ExposureReport.items` with stable ids next to the unchanged texts; page-versus-CLI equality test (FR-AEX-001, 007).
2. Runtime state: runtime warnings, acknowledgement memory with the required `exposure.ack` audit row, catalog entry (FR-AEX-002, 005).
3. Server surface: `getExposure` and `acknowledgeExposure` functions, administrator-session branch of `/api/ready`, gate lists (FR-AEX-003 server, 006).
4. UI: page, banner on the connection home and admin pages, mock layer, auth-ui spec (FR-AEX-003, 004).
5. Live spec, deploy note, acceptance walk-through.

Dependency graph: 1 → 2 → 3 → 4 → 5.

## Risks
- **CLI and log output must not change.** `warnings` (texts) stays as is; `items` is additive. Mitigation: existing `tests/exposure.test.ts` snapshots stay unchanged and run in the task 1 checkpoint.
- **Runtime warnings need state the report builder does not have.** Mitigation: they live in `exposure-state.ts`, which takes a small deps object (settings, setup state, sink status, config), so tests use fakes and the pure builder stays pure.
- **Readiness route and sessions.** `/api/ready` is a raw route answered early; resolving an administrator session there must not add a store read to the unauthenticated path. Mitigation: look at the cookie only when the peer is not loopback and a session cookie is present; fixed body otherwise; test that an anonymous request does no session lookup.
- **Acknowledgement is process-local.** A second process cannot exist (single-instance rule), so memory is enough; tested by creating a new state object.
- **Client chunk rule.** `exposure.functions.ts` must import only thin modules (found twice in admin-audit); `vite build` runs after tasks 3 and 4, and a test pins the import list like the audit functions test.
- **Banner on every admin page.** Mistaken placement could show it to users or on loopback. Mitigation: the rule is a pure function with a unit test (role, bind, acknowledged state).
- **Live test cannot bind a public interface.** Stated in the spec; the live spec uses an https public origin on loopback, and the banner rule is covered by unit tests.

## Verification checkpoints
After 1: `tests/exposure.test.ts` unchanged and green. After 2: unit tests, catalog test. After 3: function tests, `vite build`, gate test. After 4: `npm run test:e2e:auth-ui`. After 5: `npm run test:e2e:auth-live`, full vitest, lint, typecheck, build, `gen-env-docs --check`.
