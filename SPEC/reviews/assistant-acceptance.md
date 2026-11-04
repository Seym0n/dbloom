# Acceptance: assistant (SPEC/34)

Date: 2026-11-04. Tasks 0 to 7 done.

## Results

| Check | Result |
|---|---|
| `npm test` | 145 files; 3497 passed, 4 skipped, 1 failed: `sql-run.integration` timing (a different test each full run; the file passes alone, 84 of 84) |
| `npm run test:e2e:auth-ui` (mock layer, whole suite) | 191 passed, 31 of them for the assistant (`auth-ui-assistant` 15, `auth-ui-assistant-admin` 16), axe light and dark, 375 px |
| `npx playwright test -c playwright.account.config.ts auth-live-assistant` (real server, MySQL 8.4 and MariaDB 10.11, mock AI service) | 11 passed, 24 s |
| `auth-live-settings`, `auth-live-audit`, `auth-live-exposure` after the new settings group | 16 passed |
| typecheck, eslint, `vite build` (after the `EBUSY` retry), CLI rebuilt | clean |

## Requirements

| FR | Evidence |
|---|---|
| FR-AST-001 availability | `assistant-config.test.ts` (reasons), `assistant-service.test.ts` status; live: no endpoint = "Not configured" and zero requests to the mock service; opening the sidebar sends nothing |
| FR-AST-002 tools | `assistant-engine-approval.test.ts` (schemas, strict arguments, fixed messages, outline), orchestrator tests (describe, unknown tool) |
| FR-AST-003 manual mode | orchestrator and service tests (waits, approve, deny, expiry, two calls in one answer); live tests 2, 4; auth-ui |
| FR-AST-004 auto mode | policy matrix, orchestrator tests (read runs, write asks, administrators can switch it off), service `setMode` (audited first, server held); live test 5 |
| FR-AST-005 approval binding | `assistant-engine-approval.test.ts` (user, session, conversation, changed statement, single use, expiry), service test (another session of the same user cannot approve) |
| FR-AST-006 markings | `assistant-pii-core.test.ts`; admin page and `assistant-admin.test.ts`; live test 9 (a marking made on the page applies to the next result) |
| FR-AST-007 tokens, FR-AST-008 taint | `assistant-pii-taint.test.ts` (76), `assistant-canary.test.ts` (12 query shapes over real HTTP); live tests 2, 3, 8 |
| FR-AST-009 inference guard | taint tests (23 refused, 18 allowed forms), canary and orchestrator tests, live test 6; five mutations of guard and taint caught |
| FR-AST-010 tokens in SQL | tokens tests (whole literal only, foreign, embedded, unsafe), orchestrator, live tests 3 and 10 |
| FR-AST-011 run and guard, writes | `assistant-hook.integration.test.ts` (12, both servers): INSERT and UPDATE only with approval, nothing else; live tests 4, 5, 6, 7 |
| FR-AST-012 inline result and tab | auth-ui specs (table, Open in SQL tab unrun) |
| FR-AST-013 limits | orchestrator tests (steps, tokens, stop, busy, rate limit, AI failure) |
| FR-AST-014 injection | orchestrator test, live test 7 (an injected cell changes nothing), `assistant-ui.test.ts` (no HTML, no images, links only http, https, mailto) |
| FR-AST-015 conversations | `assistant-store.test.ts`, `assistant-service.test.ts`; live test 10 (reopened as text after a restart, no rows) |
| FR-AST-016 hidden names | tokens/names tests, orchestrator test (col_n out, real name back) |
| FR-AST-017 outbound | `assistant-engine-client.test.ts` (22: redirects, private addresses, size, timeout, no key in errors) |
| FR-AST-018 audit | orchestrator and service tests (write audited before it runs, failing sink stops the call, tokenized SQL); live tests scan the table |
| FR-AST-019 admin page | `assistant-admin.test.ts` (21), `auth-ui-assistant-admin` (16), live test 9 |
| FR-AST-020 layout | `auth-ui-assistant` (large dialog keeps conversation, draft and scroll; focus back; 375 px) |

**Success criterion 3 (the canary scan).** The planted PII values appear in no request body to the AI service, no audit row, no log line and no stored history, for SELECT *, alias, join, concat, CTE, union, derived table, scalar subquery, an aggregate, nested functions, an unknown column, and a token round trip, on MySQL and MariaDB.

## Deviations

- Approval records are a server-side map, not signed tokens (`assistant/approval.ts`): nothing leaves the server, so signing adds nothing.
- Turns run in the background and the page polls, instead of one long request or a stream (a turn can outlast a proxy's read timeout). `FU-assistant-stream`.
- No proxy setting of DBLoom's own: Node's `NODE_USE_ENV_PROXY` applies (`docs/deploy.md`). `FU-assistant-outbound-proxy`.
- Audit fields are plain values; a field named `code` is redacted by the logger, so refusals use `reason`.
- In stateless mode the audit rows go to standard output and the file sink only (there is no table).
- Retention of conversations follows `DBLOOM_AUDIT_RETENTION_DAYS`.

## Open

- Owner visual review of the sidebar, the approval and result cards, the large dialog and `/admin/assistant`.
- Unmarked columns, and personal data inside free text or JSON, are not protected: the deploy guide and the page say so.
- Deferred: `FU-assistant-delete-ddl`, `FU-assistant-aggregates`, `FU-assistant-token-store`, `FU-assistant-outbound-proxy`, `FU-assistant-stream`, `FU-assistant-skills`, `FU-assistant-endpoints`.
