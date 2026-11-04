# Plan: module `admin-settings`
Spec: SPEC/32-module-admin-settings.md (approved 2026-11-03, Q1 to Q7 as recommended; Q2 confirmed: no per-key `.env` min/max). Map: SPEC/28-admin-capability-map.md. Depends on admin-audit (`auditRequired`), admin-users (notice keys already in the registry), admin-exposure (banner placement, page pattern).

Order (sequential; each ends at a green checkpoint: typecheck, lint, vitest, relevant e2e, `vite build` when functions files change, CLI rebuild after the server build):
1. Registry and description: group, label key and kind per key; four new keys; `DBLOOM_SETTINGS_LOCK`; `describe()`; clamp audit (FR-ASE-001, 006, 007, 015 part).
2. Write path: validated `set`, `reset`, `deleteSetting`, audit first, conflict, cache invalidation, narrowing preview (FR-ASE-002, 003, 004, 008, 014).
3. Service, functions, CLI: role and step-up matrix, thin functions file, gate lists, `settings list`, `settings reset`, `maintenance off` (FR-ASE-005, 012).
4. Site settings on the server: login notice, information banner, maintenance rules, middleware block, boot data (FR-ASE-009, 010, 011).
5. UI: `/admin/settings`, row editor, preview, banners, mock layer, auth-ui spec (FR-ASE-013, 009, 010 display).
6. Live spec, deploy note, acceptance walk-through.

Dependency graph: 1 → 2 → 3 → 4 → 5 → 6 (4 needs the write path only for live tests; its unit tests could run after 1).

## Risks
- **Silent clamp on write today.** `write()` clamps; the admin path must refuse. Mitigation: the wizard keeps `write()` as is (its own tests stay), the admin path is a new `set()` with strict parse; tests for both.
- **Key without a reader.** A key on the page with no effect is a lie. Mitigation: registry-wide test that each `ui_within_env` key is read somewhere under `src` (FR-ASE-015); keys found without a reader are marked read-only or removed from the editable set and listed in the review.
- **Two resolver caches.** `runtime.ts` and `signin-runtime.ts` each cache for 5 s. Mitigation: one `invalidate` hook both register with; test that a write is seen at once.
- **Audit-first and crash.** An audit row can exist for a change that did not happen. Mitigation: accepted, documented; tests only pin the order and the abort on failure.
- **Maintenance lockout.** A stolen administrator session or a mistake could block users, and the owner must always get back in. Mitigation: administrators and CLI exempt, `.env` flag as forced-on only (never traps the UI off-switch the other way), `dbloom maintenance off`, end time computed on read (no timer to lose on restart), live test of switching off.
- **Middleware cost.** Maintenance check runs on every server function. Mitigation: read from the cached resolved settings; no store read per request; exempt list pinned by a test.
- **Client chunk rule.** `settings.functions.ts` imports only thin modules; pin test plus `vite build` after tasks 3 and 5.
- **Pre-login text.** Login notice is a phishing channel and reaches unauthenticated users. Mitigation: plain text only, length and control-character checks on the server, rendered as text node, mock and live check that markup is shown literally.
- **Narrowing preview.** Counting stranded users needs a store read of factors per active user. Mitigation: one query, run only on narrowing writes; tests with TOTP-only, passkey-only and both.
- **Build flakes.** `EBUSY` on `vite build` (retry), CLI bundle must be rebuilt after the server build.

## Verification checkpoints
After 1: resolver unit tests, existing `tests/auth-settings*.test.ts` unchanged and green. After 2: write-path tests, audit-order test with failing sink. After 3: function tests, gate test, import-list pin, `vite build`, CLI integration. After 4: maintenance and site-text tests. After 5: `npm run test:e2e:auth-ui`. After 6: `npm run test:e2e:auth-live`, full vitest, lint, typecheck, build (server then CLI), `gen-env-docs --check`.
