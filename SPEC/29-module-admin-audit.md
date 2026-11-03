# 29 — Module spec: `admin-audit` (audit store, retention, viewer, export, external sink)

**Implementation: all 10 tasks done 2026-11-03, acceptance in `reviews/admin-audit-acceptance.md` (one deviation: median insert about 2 ms, not under 1 ms). Status: APPROVED by the owner (2026-11-03): Q1 to Q7 of section 10 all as recommended (no hash chain; write the table in direct mode with a store; keep `sql.statement` and `rows.change`; file sink only; own events on the account page; export 1 000 000 rows, CSV and NDJSON; viewer without admin-network restriction accepted). Plan: `tasks/plan-admin-audit.md`; tasks: `tasks/todo-admin-audit.md`.** Written with the spec-driven-development skill, in the format of files 22 to 27. Module id `admin-audit` of the map in `28-admin-capability-map.md`; depends on `auth-account` and `server`. Scope inventory: `reviews/admin-scope.md` group C. Requirements marked PROPOSED are new (`FR-AAU-nnn`, subsystem AAU, to be added to the README table on acceptance). Existing requirements (`NFR-TGT-090`, `107`, `145` as far as it concerns the audit write, `FR-AUT-027`, `ST-092`, `ST-203` to `206`) are not reopened.

Owner decisions that shape this spec (2026-11-03): audit store is a SQLite table in account mode; direct mode has stdout and the external sink only; retention default 365 days (floor 90, ceiling 1095); `admin-plane` is **not** in the first admin release, so the audit viewer is protected by the admin role alone (see assumption 6).

## 0. Assumptions (correct me now)
1. Audit today is one JSON line on stdout from `audit()` in `src/server/audit.ts`, called from about 20 files (auth services, io, rows, sql, structure, CLI). Those call sites keep their signature; the change is behind `audit()`.
2. The store is the existing SQLite file (`node:sqlite`, migrations in `src/server/store/sqlite-store.ts`, next migration is number 6 on top of the current list). Stateless mode (`DBLOOM_STORE=none`) and direct login mode on a store keep stdout and the external sink only; there is no viewer without the audit table. A direct-mode deployment that has the store still writes the table (events such as `sql.run` exist there too); the viewer is account mode only because the viewer needs administrators. *(Q2)*
3. Fail closed only where a spec says so: a change of an administrator setting is aborted when its audit entry cannot be written (NFR-TGT-145, ST-092, C-19). Logins, queries and everything else continue when the audit write fails; the failure is logged and shown to administrators. This module provides the two entry points; the settings editor that needs the fatal one is `admin-settings`.
4. Audit rows never contain secrets: passwords, tokens, codes, TOTP secrets, recovery keys, key material, SQL text, cell values. The existing field redaction of `src/server/log.ts` (`redactFields`) is reused as the last line of defence; each call site already limits its own fields.
5. Ordinary users may see their own events (D-19). This module provides the query and a read-only list on the account page; it does not add new event types.
6. With `admin-plane` deferred, nothing restricts the viewer to administration networks (SEC-TGT-147 is not enforced for admin routes in this release). The viewer and export need role `admin`; export also needs step-up. The deploy guide states the gap. When `admin-plane` ships, it adds one check in front of these routes and nothing here changes.
7. No commit and no new dependency without a go. None is needed (`node:sqlite`, `node:fs`, `node:dgram` only if the syslog sink is chosen, Q4).

## 1. Objective
Make the audit trail a durable, append-only record that administrators can read and export, that survives restarts, that is retained for a bounded time, and that can be copied to a place the administrator cannot rewrite. Success: every event the auth, io, rows, sql and structure modules already emit lands in the table in account mode; no UI path edits or deletes a row; a failing write is visible; a settings change cannot proceed without its audit row (provided as an API, exercised by test here).

Users: administrators (full viewer, export), ordinary users (own events), operators (stdout and external sink, retention variable).

## 2. Commands
```
Build:         npm run build
Unit/integr.:  npx vitest run tests/audit-*.test.ts
All tests:     npm test
Typecheck:     npm run typecheck
Lint:          npm run lint
UI mock specs: npm run test:e2e:auth-ui
Live account:  npm run test:e2e:auth-live
CLI:           node .output/cli/dbloom.mjs audit export --since 2026-11-01   # new, operator without UI
```

## 3. Project structure
```
src/server/audit.ts                 existing entry points (audit, auditSqlRun, ...); delegates to the sink registry
src/server/audit/sink.ts            AuditSink interface, registry, fan-out, failure state          (new)
src/server/audit/store-sink.ts      table writer, append-only triggers, retention purge            (new)
src/server/audit/file-sink.ts       external append-only file sink (ST-206)                        (new)
src/server/audit/query.ts           keyset paging, filters, own-events query, export stream       (new)
src/server/audit/events.ts          event catalog: name, actor kind, whether required            (new)
src/server/audit.functions.ts       server functions: list, export, own events, sink status        (new)
src/server/store/sqlite-store.ts    migration 6: audit_log
src/routes/admin.audit.tsx          viewer page (admin role)                                       (new)
src/components/auth/account/        own-events list on the account page
tests/audit-*.test.ts, e2e/audit-*.spec.ts
```

## 4. Requirements

### 4.1 Triage of the rows this module takes
| ID | Wording (one line) | Where |
|---|---|---|
| NFR-TGT-090 | Audit log with logins, 2FA, connections, config changes, destructive statements; retention in bounds; no UI delete or edit; access admin plane except own events; export needs step-up and is logged; external append-only sink. | IN (FR-AAU-001 to 009); admin-plane part OTHER: admin-plane |
| NFR-TGT-107 | User create, invite, role, disable, delete, recovery are audited. | IN (events exist; FR-AAU-002 makes them durable) |
| NFR-TGT-145 | Settings change audited with old and new value; failed write aborts the change. | IN as API (FR-AAU-004); the setting writes are OTHER: admin-settings |
| FR-AUT-027 | Audit lines of auth-account; storage and viewer left to admin. | IN (FR-AAU-002, 006) |
| ST-092 | Account events fixed on, no UI to disable or delete; failed write aborts a settings change. | IN (FR-AAU-004, 008) |
| ST-203 | Log destinations ENV-only; default stdout JSON lines. | IN (FR-AAU-009, unchanged default) |
| ST-204 | Audit retention, UI within ENV bounds 90/365/1095 days. | IN as `.env` value and a defined setting key (FR-AAU-005); the editor is OTHER: admin-settings |
| ST-205 | Audit view = admin plane, export step-up and logged, no delete in UI. | IN (FR-AAU-006, 007); admin plane OTHER: admin-plane |
| ST-206 | External sink and IP anonymisation, ENV-only. | IN (FR-AAU-009) |
| ST-221 | Store backup, no UI download. | OTHER: not this module (operator task in `docs/deploy.md`) |

### 4.2 Functional requirements
| ID | Requirement | Verification |
|---|---|---|
| FR-AAU-001 | **Table.** Migration 6 creates `audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, outcome TEXT, actor_id TEXT, actor_name TEXT, actor_kind TEXT NOT NULL, subject TEXT, address TEXT, fields TEXT NOT NULL) STRICT` with indexes on `at`, `event`, `actor_id`. No foreign key: deleting a user must not delete their history; `actor_name` is a snapshot. `fields` is a JSON object of the call's remaining fields after redaction. | Migration test; delete a user, rows stay. |
| FR-AAU-002 | **Sink fan-out.** `audit()` and the typed wrappers write to every configured sink: stdout JSON line (always, unchanged format), the table when the store is open in account mode, the external file sink when configured. A sink that throws never throws into the caller of a non-required event; the failure is counted and logged once per minute. | Sink throws: event call returns; stdout line still written. |
| FR-AAU-003 | **Actor and address.** The writer fills actor id, name and kind (`user`, `system`, `cli`, `anonymous`) and the effective client address from the request context (`currentClientAddress`, FR-SVR-005) when the call site did not. `IP anonymisation` (FR-AAU-009) applies to the stored and exported address, not to the stdout line unless the operator sets it for all sinks. | Unit: address filled from context; CLI events carry kind `cli`. |
| FR-AAU-004 | **Required write.** `auditRequired(event, fields)` writes to the table and returns only after the row is committed; it throws `AuditUnavailable` when the table is not writable, in stateless mode or when the write fails. Callers that must abort (settings changes, later) use it inside the same transaction as their change where the store allows. `audit()` stays best effort. | Locked store: `auditRequired` throws, `audit` does not; a test helper change aborts. |
| FR-AAU-005 | **Retention.** `DBLOOM_AUDIT_RETENTION_DAYS` (int, 90 to 1095, default 365; startup refuses values outside the range) and a defined setting key `auditRetentionDays` with the same bounds so `admin-settings` can edit it later. A purge runs at start and then daily: deletes rows older than the effective retention in batches and writes one `audit.purge` row with the count. The purge is the only code path that deletes rows. | Fake clock: rows older than the limit go, one purge row appears. |
| FR-AAU-006 | **Append-only.** SQLite triggers abort `UPDATE` on `audit_log` always, and abort `DELETE` unless the row is older than the retention cutoff held in `site.audit_cutoff` (set by the purge in the same transaction). No server function, route or CLI command offers update or delete. | Direct SQL `UPDATE`/`DELETE` through the store handle fails; purge works. |
| FR-AAU-007 | **Viewer.** Page `/admin/audit` for role `admin`: newest first, keyset paging (page size 50, cap 200), filters time range, event prefix, actor, outcome, free text on subject; detail panel with the redacted `fields`; read only. A banner states the sink status (FR-AAU-009) and that an unwritable audit table is active. Direct and stateless mode show a notice that audit goes to stdout and the sink. | Playwright: filters, paging, role gate (user gets the standard denied page). |
| FR-AAU-008 | **Own events and export.** Ordinary users see their own events (actor id equals session user, last 90 days, no fields beyond event, outcome, time, subject, address) on the account page. Export (CSV and NDJSON, filter-bound, streamed, row cap 1 000 000) needs role `admin` and step-up (`requireRecentFactor`, ST-034 window), is capped by the retention window and writes `audit.export` (actor, filter, format, row count) **before** streaming. The CLI `audit export` runs as the operator on the host (same trust as the other CLI commands) and also writes `audit.export` with kind `cli`. | Export without step-up refused; export row exists even when the stream is cancelled. |
| FR-AAU-009 | **External sink and anonymisation (ENV-only).** `DBLOOM_AUDIT_SINK`: `stdout` (default, nothing extra) or `file:/absolute/path` (append only, mode 0600, one JSON line per event, fsync on a batch every second). `DBLOOM_AUDIT_ANONYMISE_IP`: `off` (default), `truncate` (IPv4 to /24, IPv6 to /48), `hash` (HMAC of the address under a subkey of the server key). A failing external sink buffers up to 10 000 events in memory, retries every 5 s, drops the oldest beyond the cap and counts drops; status (`ok`, `degraded`, drops, last error text without paths of secrets) is part of the viewer banner and of the exposure report later. Syslog is not built (Q4). | Sink path unwritable: events buffer, status degraded, recover on fix; anonymise modes. |
| FR-AAU-010 | **Event catalog.** `events.ts` lists every event name that may be written, with its actor kind and whether it is required. `audit()` refuses (throws in tests, logs in production) an event not in the catalog so a typo or a new unlisted event is caught. The catalog is generated for the viewer filter. Existing events are listed as they are today (`setup.*`, `auth.*`, `session.*`, `user.*`, `invite.*`, `recovery.*`, `factor.*`, `codes.regenerated`, `webauthn.counter`, `vault.*`, `profile.*`, `connection.*`, `prefs.import`, `secret.unreadable`, `structure.statement`, `sql.run`, `sql.statement`, `rows.change`, `rows.refused`, `io.*`, `cli.command`) plus `audit.purge`, `audit.export`, `audit.sink`. | Test greps the source for `audit('...')` names and compares with the catalog. |
| FR-AAU-011 | **No secrets.** A log-capture test writes events carrying known secret values in every field position of every wrapper and finds none in stdout, the table, the file sink or an export. | Test with seeded secrets. |

### 4.3 Non-functional
- Write cost: one prepared insert, synchronous on `node:sqlite`; the event path adds under 1 ms median (measured in a micro test, not a promise for a loaded server).
- The table grows with traffic: `sql.statement` and `rows.change` events can be many. A per-event size cap of 8 KiB for `fields` (truncate with a marker) keeps rows bounded.
- Accessibility and i18n for the viewer follow the existing rules (labels, keyboard, axe clean, English strings through the i18n layer).

## 5. Code style
```ts
// src/server/audit/store-sink.ts (shape, not final)
export function createStoreSink(db: DatabaseSync, now = Date.now): AuditSink {
  const insert = db.prepare(
    'INSERT INTO audit_log (at, event, outcome, actor_id, actor_name, actor_kind, subject, address, fields) VALUES (?,?,?,?,?,?,?,?,?)',
  )
  return {
    name: 'store',
    write(e) {
      insert.run(now(), e.event, e.outcome ?? null, e.actor?.id ?? null, e.actor?.name ?? null, e.actor?.kind ?? 'system',
        e.subject ?? null, e.address ?? null, JSON.stringify(redactFields(e.fields)))
    },
  }
}
```
Conventions as in the repo: strict TypeScript, zod at server-function boundaries, no ORM, tests next to behaviour in `tests/`, snake_case columns mapped to camelCase in one row mapper.

## 6. Testing strategy
- Unit (vitest): sink fan-out and failure isolation, catalog check, redaction, anonymisation, retention with a fake clock, trigger behaviour, keyset paging and filters, export format.
- Integration: built server in account mode with the existing live fixtures: sign-in, a user action and a failed sign-in appear in the table; the viewer functions return them to an admin and refuse a user; export refuses without step-up.
- UI: Playwright on the mock layer (`auth-ui`) for the viewer and the own-events list (filters, paging, empty state, axe light and dark, phone width); one live spec for the end-to-end path.
- Property: no sequence of server-function calls available to a logged-in admin edits or deletes a row (route inventory test over `audit.functions.ts`).
- Fault: unwritable table (read-only handle), unwritable sink path, full disk is simulated by a throwing writer.

## 7. Boundaries
- **Always:** write audit rows through the one `audit()` path; keep secrets out; run `npm test` and the auth-ui specs before a commit; extend the event catalog with any new event.
- **Ask first:** a new dependency (for example a syslog client), a change of retention bounds, any change to the trigger rules, a decision to write more events than today, a change to existing event field names (the stdout format is a public contract for operators).
- **Never:** a UI or API path that edits or deletes audit rows outside the purge; secrets or SQL text in an audit row; a foreign key from `audit_log` to `users`; dropping the stdout line.

## 8. Success criteria
1. In account mode every event of the catalog written during the live e2e run is in `audit_log` with actor and address.
2. Direct SQL `UPDATE` and `DELETE` on the table fail; only the purge deletes, and writes `audit.purge`.
3. `auditRequired` throws on an unwritable table and `audit` does not; a stand-in settings change aborts without its row.
4. Retention at 90, 365 and 1095 days applies; a value outside the range refuses startup.
5. The viewer shows, filters and pages the rows for an admin; a user gets the denied page; a user sees only their own events on the account page.
6. Export needs step-up, writes `audit.export` first, and respects filter and cap.
7. A failing file sink buffers, reports degraded and recovers; no event is written twice.
8. The secrets test finds nothing in any sink or export.
9. The deploy guide documents the sink variables, the retention variable, and the missing admin-network restriction.

## 9. Plan sketch (for review, not yet a plan)
1. Event catalog and sink interface; `audit()` delegates; stdout unchanged (002, 010).
2. Migration 6, store sink, triggers, retention purge (001, 005, 006).
3. Actor and address filling, `auditRequired` (003, 004).
4. File sink, anonymisation, failure buffer and status (009).
5. Query layer and server functions, own events, export, CLI (007, 008).
6. Viewer page and account list, deploy guide update, secrets test (007, 011).

## 10. Open questions for the owner
| # | Question | Recommendation |
|---|---|---|
| Q1 | Tamper evidence: add a hash chain (each row stores the hash of the previous row) so a stolen-store edit is detectable? Not required by the specs; the append-only triggers do not stop someone with the file. | Skip in this module; the external file sink is the tamper-resistant copy. Revisit with `hardening`. |
| Q2 | Direct login mode with a store: write the table (so events like `sql.run` are kept) even though no administrator can view it? | Yes, write it; viewer and own-events stay account mode only. |
| Q3 | Row volume: keep `sql.statement` and `rows.change` in the table, or stdout and sink only? | Keep all; the per-row size cap and retention bound the growth; revisit after real use. |
| Q4 | External sink types: `file` only now, syslog (UDP/TCP) later? | File only now; syslog is a small follow-up if you want it, but TCP syslog needs reconnect logic. |
| Q5 | Own-events list: show it on the existing account page, or a separate `Activity` page? | Section on the account page. |
| Q6 | Export row cap and formats. | 1 000 000 rows, CSV and NDJSON. |
| Q7 | The viewer without the admin network restriction (assumption 6): accept for this release, or build `admin-plane` first? You decided to defer it; the deploy guide will say so. | Accept as decided. |

## 11. Notes for `docs/deploy.md`
Audit variables (`DBLOOM_AUDIT_RETENTION_DAYS`, `DBLOOM_AUDIT_SINK`, `DBLOOM_AUDIT_ANONYMISE_IP`) are added to the registry, so the generated table and `.env.example` pick them up. The guide says: the audit table lives in the store volume (back it up with the store, ST-221); stolen volume means readable audit, so use the external sink on another host if that matters; administrators reach the viewer from any address until `admin-plane` ships.
