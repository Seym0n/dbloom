# Acceptance walk-through: module `admin-audit` (SPEC/29 section 8)

Date: 2026-11-03. Run on Windows 11, Node 24, MySQL 8.4 and MariaDB 10.11 in Docker, Chromium via Playwright. Commands: `npx tsc --noEmit`, `npx eslint .`, `npx vitest run` (113 files, 2960 passed, 4 skipped), `npm run test:e2e:auth-ui` (104 passed, 19 of them in `auth-ui-audit.spec.ts`), `npm run test:e2e:auth-live` (38 passed, 2 skipped, 4 of them in `auth-live-audit.spec.ts`), `node scripts/gen-env-docs.mjs --check`, `vite build` for the server and the CLI.

| # | Criterion | Result | Evidence and limits |
|---|---|---|---|
| 1 | Events written in the live run are in `audit_log` with actor and address | Met for the events that run writes | `auth-live-audit.spec.ts` checks `setup.token`, `setup.complete`, `auth.signin` (ok and failed), `user.create`, `audit.export` in the table, `user.create` with address, the actor name in the viewer detail. It does not write every one of the 70 catalog names: the catalog test (`tests/audit-catalog.test.ts`) proves only that every name written in source is listed. Events written by the CLI or at setup have no client address by nature. |
| 2 | Direct `UPDATE` and `DELETE` fail; only the purge deletes and writes `audit.purge` | Met | `tests/audit-store.test.ts`, `tests/audit-retention.test.ts`, and the live spec (writable handle on the live store). |
| 3 | `auditRequired` throws on an unwritable table, `audit` does not; a stand-in change aborts without its row | Met | `tests/audit-required.test.ts` (locked store, read-only handle, stateless, forced insert failure inside a transaction). Not yet used by a real change: `admin-settings` is the first caller. |
| 4 | Retention 90, 365, 1095 applies; outside the range refuses startup | Met | `tests/audit-retention.test.ts` (boundaries, purge at each, 89 and 1096 and non-numbers refused). The daily timer is not tested with a real day; the purge function is called directly. |
| 5 | Viewer shows, filters and pages for an admin; a user gets the denied page; a user sees only their own events | Met | Mock layer: `auth-ui-audit.spec.ts` (paging to the end, every filter, detail, role gate, direct-mode notice). Live: viewer, filter, detail, own events. Service role matrix: `tests/audit-functions.test.ts`. The denied page for a signed-in ordinary user is shown on the mock layer only, not on the live server. |
| 6 | Export needs step-up, writes `audit.export` first, respects filter and cap | Met | `tests/audit-export.test.ts` (no step-up refused, row before first byte and after cancel, cap, window, formats, single-use token, CLI). Live: browser download, header line, `audit.export` row. The 1 000 000 cap is tested with a cap parameter of 10, not with a million rows. |
| 7 | A failing file sink buffers, reports degraded and recovers; no event written twice | Met | `tests/audit-file-sink.test.ts`; live run: file sink configured, one line per event, one `audit.export` line, one `user.create` line. The recovery of the live server's sink was not exercised. |
| 8 | Secrets test finds nothing in any sink or export | Met for stdout, table, file sink | `tests/audit-secrets.test.ts`. The export is read from the same table text; it is not in the seeded test. Limits: only secret-named fields, `Bearer` and `Basic` text and URL query values are redacted, not an arbitrary secret in a field like `table`. |
| 9 | Deploy guide documents the sink variables, retention variable and missing admin-network restriction | Met | `docs/deploy.md` section "Audit log" and the generated variable table. |

## Findings during the work (all fixed)
- Stdout lines, column fields and the file sink's address were not redacted until the secrets test ran.
- `runtime` importing `net/current` (which imports `runtime`) made the build bundle the runtime twice and left `-wal` and `-shm` files at shutdown; the lifecycle integration tests caught it.
- `audit.functions.ts` exported a helper that imported the runtime, and then `anonymise.ts` (with `randomBytes` at load) reached the browser chunk: the first broke `vite build`, the second made every audit call fail in the browser while the mock layer passed. Only the live spec found the second one. `tests/audit-functions.test.ts` now pins the import list of that file.
- `auth.*`, `account.*` and `session.*` events name the user in `subject` and carry no `actor`; without a rule the own-activity list was empty. The store writer now takes the subject as actor for those prefixes.

## Row growth and cost (measured)
- Live account run: 12 rows, 930 bytes of payload, 78 bytes per row (sign-in, setup, one user action, one export; no statement-level events).
- Statement-level event (`rows.change`, typical fields): 150 to 200 bytes of payload per row (`tests/audit-store.test.ts`, micro test). A row costs more on disk (indexes on `at`, `event`, `actor_id`, row header); not measured.
- Write cost: **the median insert is about 2 ms on this machine, not under 1 ms** as the NFR in section 4.3 hoped (p99 about 4 ms). Each event is its own committed SQLite transaction, so the cost is the WAL commit. The store runs with SQLite's default `synchronous`; lowering it would speed this up for the whole store and weaken durability, so it was not changed. A batching writer is possible if `sql.statement` volume makes this matter.
- A busy installation with statement-level events at, say, 100 000 rows a day and 365 days of retention would hold about 36.5 million rows, roughly 10 GB with indexes (estimate from the numbers above, not measured). Lower retention or the external sink only for those events is the lever; `reviews` Q3 asked to keep them and revisit after real use.

## Not done or not run
- No hash chain (Q1); the external file is the tamper-resistant copy.
- The viewer has no event-name catalog grouping and no saved filters.
- `/admin/audit` and the export are reachable by an administrator from any address (admin-plane deferred).
- Direct mode writes the table when a store exists but no viewer shows it (Q2).
- The CLI `audit export` reads rows into stdout through the same code as the web export; no test with a million rows.
- Mutation of the retention setting from a UI waits for `admin-settings`.
