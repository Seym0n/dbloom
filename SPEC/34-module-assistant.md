# 34 — Module spec: `assistant` (AI sidebar with approved tool calls on the target database)

**Status: APPROVED by the owner 2026-11-04 (Q1 to Q10 decided; Q3, Q7 to Q10 "Agree" with the recommended defaults, Q1 with DELETE and DDL out).** Written with the spec-driven-development skill, in the format of `32-module-admin-settings.md`. It builds FR-TGT-250, FR-TGT-251 and SEC-TGT-158 (`11-target-security.md` section 16), ST-223 to ST-225 (`12-settings.md`), SCN-011 (`19-scenarios.md`) and the hook FR-SQL-027 (`23-module-sql-tab.md`, built in `src/server/sql/assistant.ts`). Depends on `skeleton`, `sql-tab`, `auth-account` and `admin-settings`. No code is written before approval.

**Owner statements of 2026-11-04 that change SEC-TGT-158:** (1) the assistant calls tools on the database; (2) values of PII-marked columns are **anonymized** for the AI, not withheld as whole results; (3) **every tool call on the database must be approved**; (4) two modes: **manual** and **auto**. Section 2 records how these replace the earlier "metadata only" rule and the open parts of OPEN item 19.

## 1. Assumptions (correct me now)
1. One OpenAI-compatible chat endpoint with tool calling (FR-TGT-251). Base URL and key are `.env`-only (ST-223, ST-224); model name and on/off are administrator settings (ST-225). No endpoint, no outbound request, sidebar shown as unavailable.
2. **Manual mode:** every tool call that touches the target database is shown to the user and runs only after they press Approve. **Auto mode:** the user has switched the conversation to run tool calls without asking each time; the server still checks every call against the same rules (read-only class, guards, PII rules) and refuses what the rules refuse. "Approved" therefore means: approved by the user per call (manual) or by the user's mode choice plus the server's policy (auto). A call outside the policy is never run silently in either mode.
3. **Approval covers reads and writes** (owner, 2026-11-04): `SELECT` and also `INSERT` and `UPDATE`. A write is **always approved per call, in manual and in auto mode** (auto mode runs reads only). Writes go through the SQL tab's write guard and confirmation token, so the card shows the statement class and the guard's checks before Approve. `DELETE`, DDL, privileges and multi-statement text are not run by the assistant; they are offered as a button that opens an SQL tab prefilled and not run (Q1). This replaces SEC-TGT-158 (5) "read-only".
4. Anonymization is pseudonymization: a PII value becomes a stable token inside one conversation (same value, same token, so the model can group, join and count). The user always sees real values on screen if their own rights allow it. The token map lives in server memory per conversation and is never stored or logged.
5. The target's privileges stay the security boundary (SEC-TGT-050). The assistant runs with the user's own connection, under the guards of the SQL tab (timeout, result caps, audit). Everything here is a guard rail on top of that.
6. Direct mode, account mode and stateless mode all get the assistant (SCN-011 is A and D). Conversations persist only where a store and a user exist (account mode, Q4).
7. The parser is `@guanmingchiu/sqlparser-ts` (already in use). No new dependency is planned; the HTTP client is `fetch`. No commit without a go.

## 2. Objective
A user asks a question in the right sidebar. The assistant answers by calling tools on the user's target: `describe_tables` (columns and types from the schema) and `run_query` (one read-only statement). The user approves each call in manual mode, or lets the assistant run in auto mode. The result appears inline as a table with the SQL, and a button opens the full result in an SQL tab of the same browser tab. The AI service never receives a real value of a PII column: it receives tokens such as `<email:3>`; it never receives credentials, session data or the connection. Every call, approval and refusal is audited without PII values.

**Replaces:** SEC-TGT-158 (4) "the model receives only metadata when a statement touches a PII column" is replaced by "the model receives the rows with PII cells replaced by tokens"; when the parser cannot tell which output columns carry PII, the old rule applies (metadata only). SEC-TGT-158 (1), (2), (3), (5), (6) stay. OPEN item 19: prompt-injection rules and the PII screen are specified here.

## 3. Commands
```
Build:          npm run build
Unit/integr.:   npx vitest run tests/assistant-*.test.ts
All tests:      npm test
Typecheck:      npm run typecheck
Lint:           npm run lint
UI mock specs:  npm run test:e2e:auth-ui   (mock AI endpoint in the mock layer)
Live:           npm run test:e2e:auth-live (e2e/auth-live-assistant.spec.ts; mock AI server from fixtures, MySQL and MariaDB from compose.test.yaml)
```

## 4. Project structure
```
src/server/assistant/config.ts          endpoint, model, on/off, allow-private, mode ceiling (resolver, no secrets in logs)
src/server/assistant/client.ts          OpenAI-compatible client: fetch, timeout, proxy, TLS verify, redirect refusal, size caps
src/server/assistant/orchestrator.ts    turn loop: model -> tool call -> policy -> approval or auto -> anonymize -> model; step cap
src/server/assistant/tools.ts           tool schemas, argument validation (zod), tool results
src/server/assistant/pii/rules.ts       rule matching (db.table.column with wildcards), env list plus stored rules
src/server/assistant/pii/taint.ts       parser analysis: which output columns carry PII; inference guard; "cannot decide"
src/server/assistant/pii/tokens.ts      per-conversation token map, tokenize rows, detokenize string literals in SQL
src/server/assistant/approval.ts        pending calls, approval tokens bound to user, session, conversation, statement hash
src/server/assistant/policy.ts          what runs in auto mode; refusals and reasons
src/server/assistant/store.ts           conversations, messages, PII rules (migration 9)
src/server/assistant.functions.ts       thin server functions (send, approve, deny, setMode, conversations, rules)
src/server/audit/events.ts              assistant.call|approve|deny|refuse|mode|rule
src/components/assistant/*              sidebar, modal, message list, approval card, inline table, mode switch
src/components/auth/assistant/*         admin page /admin/assistant (PII rules, on/off, model, auto allowed)
src/routes/admin.assistant.tsx          route
tests/assistant-*.test.ts   e2e/auth-ui-assistant.spec.ts   e2e/auth-live-assistant.spec.ts
docs/deploy.md              section "AI assistant"
```

## 5. Requirements

### 5.1 Functional
| ID | Requirement | Verification |
|---|---|---|
| FR-AST-001 | **Availability.** The sidebar works when `DBLOOM_AI_BASE_URL` is set, the setting `assistantEnabled` is on and the user has a target connection. Otherwise it shows "not available" and the server makes no outbound request. | Unit: no fetch without config; mock server receives nothing. |
| FR-AST-002 | **Tools.** Two tools. `describe_tables({db, tables[]})` returns columns, types, keys and comments from the schema. `run_query({db, sql, purpose})` runs exactly one statement through `runForAssistant`. The first message of a conversation carries the schema outline (database and table names, columns up to a size budget) so tools are needed only for large schemas. Arguments are validated; unknown tools and extra arguments are refused to the model with a fixed message. | Unit: schema validation, unknown tool. |
| FR-AST-003 | **Manual mode.** A `run_query` call creates a pending call and an approval card (SQL, database, class, "values of PII columns in this statement are shown as typed by you / as tokens" note). Nothing runs until **Approve**. `describe_tables` reads schema metadata only (no row data, no PII) and runs without a prompt in both modes, shown as a visible step in the conversation (Q6, proposed). **Deny** returns "the user declined" to the model. **Open in SQL tab** hands the statement over unrun. A pending call expires after 10 minutes (`denied: expired`). | Service and UI specs: no DB call before approve; deny; expiry. |
| FR-AST-004 | **Auto mode.** Per conversation, chosen by the user, shown in the header of the sidebar at all times, default **manual** for every new conversation. In auto mode the server runs a call without asking only when `policy` accepts it (read-only class, one statement, no inference-guard hit, within caps); a refused call is returned to the model with the reason and shown to the user; a write in auto mode becomes a pending call that waits for Approve like in manual mode. The mode is held on the server; a request cannot claim it. Switching is audited (`assistant.mode`). An administrator setting `assistantAutoAllowed` (default on) can take auto mode away for everybody. | Unit: policy matrix; client cannot force auto; switch audited. |
| FR-AST-005 | **Approval binding.** An approval is a server-side record bound to user, session, conversation, call id and the hash of the exact statement. It is single use. A changed statement, another session or an expired record is refused (`assistant_approval_invalid`). Reuses `confirm-token.ts` primitives. | Unit: replay, changed SQL, other session. |
| FR-AST-006 | **PII rules.** A rule is `db.table.column` where each part may be `*` (for example `*.*.email`, `shop.customers.*`), matched case-insensitively per the target's collation rules, scoped to a normalised target (DATA-TGT-095) or all targets. Effective rules = rules from `DBLOOM_PII_COLUMNS` (the only source in direct and stateless mode) plus stored rules (account mode, administrator page). A column matched by any rule is PII. With no rules at all the assistant works but every result is treated per FR-AST-010 (see Q7). | Unit: matching, union, wildcard, case. |
| FR-AST-007 | **Anonymize results.** Before a result goes to the model, every cell of an output column that carries PII is replaced by a token `<label:n>` (`label` from the column name, `n` by first appearance within the conversation, same value same token, per column group; each token map carries a random 4-character epoch so tokens of an earlier map can never be mistaken for new ones: `<email:k7x2:3>`). `NULL` stays `NULL`. The inline table for the user and the full result in the SQL tab show real values. Tokens are never shown to the user except in the model's own text, where the page replaces a token in the assistant's answer with the real value only when the user has the matching result open (Q2). | Unit: tokenizer; recorded outbound request contains no PII value. |
| FR-AST-008 | **Taint analysis.** With the parser, every output column is classified `clean`, `pii` (references a PII column directly, through alias, `SELECT *`, join, subquery, CTE, `UNION` branch, expression such as `CONCAT(first, ' ', last)`, `CASE`, window or aggregate other than `COUNT`) or `unknown`. `SELECT *` expands from the schema. A statement with any `unknown` output column, or that the parser cannot analyse, sends **metadata only** (column names, types, row count) to the model, and the user is told why. | Unit: SELECT *, alias, concat, join, subquery, CTE, union, view, parser failure. |
| FR-AST-009 | **Inference guard.** A PII column must not be usable to read its value through the answer shape. In `WHERE`, `HAVING`, `JOIN ... ON`, `ORDER BY`, `GROUP BY` a PII column (or an expression over it) is allowed only in `=`, `<>`, `IN`, `IS [NOT] NULL` against a token issued in this conversation, against another column, or as a plain `GROUP BY`/`DISTINCT`/`COUNT(DISTINCT)` key. `LIKE`, `REGEXP`, range comparisons, `SUBSTRING`, `LEFT`, `ASCII`, `ORD`, `HEX`, `MIN`, `MAX` and similar over PII are refused (`assistant_inference_refused`), in both modes. | Unit: probes (`email LIKE 'a%'`, `SUBSTR(email,1,1)='a'`, `MAX(salary)`) refused. |
| FR-AST-010 | **Tokens in SQL.** A string literal in the model's SQL that equals a token issued in this conversation is replaced by the real value before the statement is shown for approval and before it runs. A token not issued in this conversation (guessed, or lost after a restart) is refused. The approval card shows the statement as it will run; the audit log and the model's history keep the tokenized form. | Unit: substitution, foreign token, audit form. |
| FR-AST-011 | **Run and guard.** `run_query` runs one statement through the SQL tab's guard: statement timeout, caps (inline 100 rows, rows to the model default 50, `DBLOOM_AI_MAX_ROWS` within 1 to 200), audit source `assistant`, history source `assistant` (hidden by default). Reads (class none, `readOnlySafe`): by approval or auto policy. `INSERT` and `UPDATE`: always by per-call approval, through `assertWritable` and the confirmation token (the write guard decides, for example the refusal of an `UPDATE` without `WHERE` and the affected-rows check of the sql-tab module); the model receives only the affected-row count and the guard message, never rows. `DELETE`, DDL, privileges, multi-statement: `needsUser` card with an "open in SQL tab" button, never run. `FR-SQL-027` gets a small additive change for the write path (task 0). | Test double: DROP, DELETE, multi-statement never run; UPDATE and INSERT run only after Approve, also in auto mode. |
| FR-AST-012 | **Inline result and tab.** The card shows the SQL, status, timing, an inline table (real values, capped) and "Open result in a tab", which opens an SQL tab of the same browser tab prefilled with the statement (real-value form), not run (FR-SQL-027). | UI spec. |
| FR-AST-013 | **Turn limits.** At most 8 model-to-tool round trips per user message (`DBLOOM_AI_MAX_STEPS`, 1 to 20), a request timeout (default 60 s), a per-turn token budget, and a per-user rate limit (default 20 messages per 10 minutes). The user can stop a running turn; a stopped turn runs no further call. | Unit: caps, stop. |
| FR-AST-014 | **Prompt injection.** Everything that comes from the database or from the model is untrusted (SEC-TGT-112). Tool results go to the model as data in a fixed envelope. The model cannot change the mode, the target, the rules, the approval or the policy; the only effects it has are `describe_tables` and `run_query`, both under the rules above. Assistant text is rendered as text with a small safe subset of Markdown: no raw HTML, no images, no automatic link loading, links show their address and open only on click with `rel="noopener noreferrer"`. | Unit and UI: injected "ignore previous instructions" in a cell changes nothing; no image request is made. |
| FR-AST-015 | **Conversations.** Account mode: the user's conversations are stored (title, messages as sent to the model, SQL, call outcome, row count; never result rows, never the token map) and listed in the selector; reopening a conversation shows past results as "Run again" (new approval or auto policy). Direct and stateless mode: conversations live in server memory for the session. Deleting a conversation removes it. Retention follows the audit-log retention setting unless the user deletes earlier (Q4). | Store tests; migration test. |
| FR-AST-016 | **Hide names.** Setting `assistantHidePiiNames` (default off): names of PII columns are not sent in the schema outline or `describe_tables` and appear as `col_n`; queries are rewritten on the server. | Unit. |
| FR-AST-017 | **Outbound.** The client uses the outbound proxy setting (ST-033), verifies TLS (SEC-SAU-314), refuses redirects, blocks private and loopback addresses unless `DBLOOM_AI_ALLOW_PRIVATE=true`, caps request and response size, and never logs bodies or the key. The request carries no credential, cookie, session id, host name or user name of the target. | Unit with a mock server; secret scan of the log. |
| FR-AST-018 | **Audit.** Events `assistant.call` (user, target key hash, conversation id, SQL tokenized, class, outcome, rows, duration, mode), `assistant.approve`, `assistant.deny`, `assistant.refuse` (reason code), `assistant.mode`, `assistant.rule` (administrator changed a rule). No PII value and no result row enters the log or audit (SEC-TGT-023). A call is audited before its result is used (required insert in manual and auto). | Unit: audit rows; failing sink stops the call. |
| FR-AST-019 | **Administrator page.** `/admin/assistant` (administrators, account mode): on/off, model name, auto allowed, hide names (all through `settings` with step-up and audit), the status of the endpoint (configured or not, never the key), and the PII rules list (add, remove, suggestions). Suggestions come from the schema of a connected target (column names such as email, phone, name, address, iban, birth, ssn) and are never applied without the administrator saying so. Rule changes need step-up (`assistant.rule` joins `STEP_UP_SET`). | Mock UI spec, axe light and dark, 375 px; live spec. |
| FR-AST-020 | **Layout.** The sidebar follows UI-TGT-001: conversation selector on top, conversation, message box at the bottom, expand to a modal and back with the same conversation, scroll position and draft; close; overlays on a narrow screen. The mode switch and the "answers cite sources" references (tables and columns used) are in the sidebar. Keyboard and screen-reader use as for dialogs (focus in, back on close, Esc, inert page). | UI spec with axe. |

### 5.2 Non-functional
- **Privacy.** With the recorded outbound requests of every test and live spec scanned, no PII value, password or cookie appears. This is the primary acceptance test.
- **Fail closed.** A parser failure, an unknown column origin, a lost token, a failing audit sink or a missing rule set never sends more data, only less.
- **Cost of a turn.** Anonymizing 50 rows of 30 columns takes under 20 ms. The schema outline stays under a configurable token budget (default 6 000 tokens).
- **Accessibility.** Approval cards are reachable by keyboard and announced (`role="alertdialog"` not used; a live region says "A query waits for your approval"); axe clean light and dark.

### 5.3 Security notes
- Exfiltration paths of an injected model: the AI endpoint itself (limited by tokens and the rules), rendered links and images (removed), more read queries (auto mode only, capped, audited, anonymized). Mitigations are FR-AST-007 to 014.
- The inference guard is the part with the most risk: a model may try to read a token's value by comparison tricks. The refusal list is a deny-list on top of allow-only operators; unknown functions over PII are refused.
- Tokens are not secrets from the user, but a token is not a key: it cannot be turned into a value without the server's map.
- `unmarked` columns that contain personal data (free text, JSON) are not protected; the page and the deploy guide say so.

## 6. Testing strategy
- **Unit (vitest):** tokenizer, rule matching, taint analysis (a table of statements with expected output classes), inference guard probes, policy matrix per mode, approval binding and replay, client (mock server: tool-call loop, timeouts, redirect refusal, size caps, no secrets in log), orchestrator (step cap, stop, denied call), audit shape.
- **Outbound privacy test:** a mock OpenAI-compatible server records every request body; the test fills PII columns with canary values, runs prompts, and asserts that no canary appears in any recorded body or in the audit log or application log.
- **UI mock spec** (`e2e/auth-ui-assistant.spec.ts`): sidebar, modal toggle, approval card, deny, auto switch, inline table, open in tab, admin page, axe light and dark at 375 px.
- **Live spec** (`e2e/auth-live-assistant.spec.ts`): real server, mock AI server, MySQL and MariaDB: manual approve, deny, auto mode run, PII tokens in the recorded request, token in WHERE substituted, a refused inference probe, a DROP never run, restart loses tokens and refuses them, no endpoint means no outbound request.
- **Mutation checks** on the inference guard and the taint classes, as in earlier modules.

## 7. Boundaries
- **Always:** approval (writes) or approval/policy (reads) before every database call; INSERT and UPDATE never without per-call approval; tokenized form in audit and model history; fail closed on any doubt; secrets out of logs.
- **Ask first:** a new dependency; DELETE or DDL by the assistant; storing result rows or the token map; changing `STEP_UP_SET`/`GUARDED_KEYS` beyond what is listed; sending anything besides schema, tokens and statements to the endpoint.
- **Never:** send a real PII value, a credential, a cookie or a connection detail to the AI endpoint; let the model set mode, rules or approval; run DELETE, DDL, privilege or multi-statement text, or a write without per-call approval; render model output as HTML.

## 8. Success criteria
1. In manual mode no database call is made before Approve; Deny returns to the model; an approval cannot be replayed or reused for another statement.
2. In auto mode read-only calls run without a prompt, refused calls come back with a reason, and the mode cannot be forced by a request.
3. A canary scan of all recorded outbound bodies, the audit log and the log finds no PII value, including through `SELECT *`, alias, join, concat, CTE, union and a token round trip.
4. The inference probes (`LIKE`, `SUBSTR`, `MAX`, range) over PII columns are refused.
5. `DROP`, `DELETE`, multi-statement and other non-SELECT/INSERT/UPDATE statements never run; `INSERT` and `UPDATE` run only after per-call approval, also in auto mode.
6. With no endpoint nothing is sent anywhere.
7. Typecheck, lint, build, full vitest, auth-ui and auth-live specs pass; axe clean light and dark at 375 px.

## 9. Out of scope (go to `SPEC/FUTURE.md` when accepted)
DELETE and DDL by the assistant, AI skills such as schema-review (OPEN item 19 idea), aggregates over PII with a minimum group size, a stored token map, per-user model choice, several endpoints, embeddings and vector search (dropped, `13-new-features.md`), image or file input.

## 10. Questions for the owner (each with a recommendation)
| # | Question | Recommended default |
|---|---|---|
| Q1 | **DECIDED (owner, 2026-11-04): approval covers reads and writes (SELECT, INSERT, UPDATE).** Proposed on top: writes always need per-call approval, also in auto mode; DELETE and DDL stay out (open in SQL tab). Is that split right, or should DELETE be included with the same rule? | Keep DELETE and DDL out of the first release. |
| Q2 | Tokens in the model answer text. | **DECIDED (owner, 2026-11-04): yes.** Real value on screen when the token belongs to a result of the same conversation; the stored message keeps the token. |
| Q3 | Auto mode: who can use it and what is the default? | Per conversation, user's choice, default manual; administrator can switch it off for all (`assistantAutoAllowed`, default on). |
| Q4 | **DECIDED (owner, 2026-11-04): never store result rows**, to keep the store small. Stored: title, messages, SQL, outcome, row count, retention = audit retention, user can delete. Reopened results show "Run again". | Decided. |
| Q5 | Token map lost on restart. | **DECIDED (owner, 2026-11-04): accepted.** Memory only; a lost token in SQL is refused with a message. |
| Q6 | `describe_tables` approval. | **DECIDED (owner, 2026-11-04): no approval** (metadata only, visible step, audited). |
| Q7 | PII rules (marking form `db.table.column` with `*` wildcards **DECIDED**, owner 2026-11-04): with no rules defined, what does the assistant do? | It works, but treats **every text-like output column of every result as unknown, so only metadata goes to the model** until an administrator defines rules or accepts "no PII on this target" explicitly (stored, audited). Safe default instead of silent exposure. |
| Q8 | Aggregates over PII (`AVG(salary)`, `MAX(birth_date)`). | Strict in the first release: tokenized or refused (FR-AST-008/009). A minimum group size rule goes to FUTURE. |
| Q9 | Where the rules live in direct mode (no administrators). | `DBLOOM_PII_COLUMNS` in `.env` (comma list of patterns), shown read-only on the page in account mode next to the stored rules. |
| Q10 | The inference guard refuses `LIKE`/`SUBSTR`/range on PII even though that blocks a question like "customers whose email ends with example.com". | Accept; the user can run such a query in the SQL tab. A domain-only helper is a later feature. |
