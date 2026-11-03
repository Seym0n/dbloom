# Plan: module `admin-audit`
Spec: SPEC/29-module-admin-audit.md (approved 2026-11-03, Q1 to Q7 as recommended). Map: SPEC/28-admin-capability-map.md. Depends on auth-account, server.

Order (sequential; each ends at a green checkpoint: typecheck, lint, vitest, relevant e2e):
1. Event catalog and sink interface; `audit()` delegates, stdout line unchanged (FR-AAU-002, 010).
2. Migration 6, append-only triggers, store sink, wiring at runtime and in the CLI (001, 006).
3. Actor and address filling, `auditRequired` (003, 004).
4. Retention: variable, setting key, purge with cutoff, schedule (005).
5. External file sink, IP anonymisation, failure buffer and status (009).
6. Secrets test over every sink and wrapper (011).
7. Query layer and server functions: list, own events, sink status; role gates (007, 008 read side).
8. Export: stream, step-up, `audit.export` first, CLI `audit export` (008).
9. Viewer page, own-events list on the account page, mock layer, auth-ui specs (007, 008 UI).
10. Live e2e, deploy guide update, acceptance walk-through against SPEC/29 section 8.

Dependency graph: 1 → 2 → 3, 4, 5 (3, 4, 5 independent after 2) → 6 (after 5) → 7 (after 2, 3) → 8 (after 7) → 9 (after 7, 8) → 10. 4 and 5 can run in parallel with 3.

## Risks
- **Call sites.** About 20 files call `audit()`; some receive it as a dependency (`deps.audit`, CLI writes to stderr). Mitigation: task 1 adds a test that greps the source for audit event names and for any `console.log(JSON.stringify({ ... audit` outside `src/server/audit/`; the CLI gets its own sink registration in task 2.
- **Two processes, one file.** The CLI opens the same SQLite file as the server. Mitigation: WAL and the store's busy timeout already apply; task 2 tests a CLI write while the server holds the store.
- **Required write inside a transaction.** `auditRequired` must join the caller's transaction where the store allows it, or the change and its row can diverge. Mitigation: task 3 offers a variant that takes the open `DatabaseSync` transaction; tested with a stand-in change.
- **Trigger-based append-only is bypassable** by anyone holding the file (accepted, Q1: no hash chain; the external sink is the tamper-resistant copy).
- **Row volume** from `sql.statement` and `rows.change`. Mitigation: 8 KiB cap per `fields` (task 2), retention purge in batches (task 4); measure on the live run in task 10.
- **Gate inventory test.** `tests/gate-routes.test.ts` fails when a new server function is in neither the credential list nor the non-credential list; task 7 adds the new functions to the non-credential list.
- **Event catalog drift.** Other modules add events later; the catalog test makes an unlisted event a test failure, which is the intent, and the task 1 note says where to add one.

## Verification checkpoints
After 2: migration test, trigger test. After 5: sink tests, secrets test. After 8: integration run on the built server in account mode. After 9: `npm run test:e2e:auth-ui` and the live account suite. After 10: full vitest, lint, typecheck, proxy suite unaffected.
