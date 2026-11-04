# Plan: module `assistant`
Spec: SPEC/34-module-assistant.md (approved 2026-11-04: tools describe_tables and run_query; PII anonymized by per-conversation tokens; approval for reads and writes (SELECT, INSERT, UPDATE), writes always per call; manual and auto mode; describe_tables without approval; result rows never stored; tokens lost on restart accepted; markings `db.table.column` with `*`; DELETE and DDL out).

Order (each task ends at a green checkpoint: typecheck, lint, vitest, relevant e2e, `vite build` when functions files change, CLI rebuild after the server build):
0. Hook extension in `sql-tab`: `runForAssistant` write path for INSERT and UPDATE through `assertWritable` and the confirmation token (called only with an approval), expose the classification and parsed statement to the assistant module; DELETE, DDL, multi-statement stay `needsUser` (FR-AST-011).
1. PII core, pure: rule matching and union (env list plus stored), taint analysis with the parser (SELECT *, alias, join, subquery, CTE, UNION, expression, view, parse failure = unknown), inference guard, token map with epoch, tokenize rows, detokenize string literals, hide-names rewrite (FR-AST-006 to 010, 016).
2. Config, settings, store: env registry (`DBLOOM_AI_BASE_URL`, `_API_KEY`(`_FILE`), `_ALLOW_PRIVATE`, `_MAX_ROWS`, `_MAX_STEPS`, `DBLOOM_PII_COLUMNS`), settings keys `assistantEnabled`, `assistantModel`, `assistantAutoAllowed`, `assistantHidePiiNames`, migration 9 (`assistant_conversations`, `assistant_messages`, `pii_rules`, `pii_ack`), store ops, `assistant.rule` in `STEP_UP_SET`, audit events, regenerated `.env.example` and deploy table (FR-AST-001, 006, 015, 018, 019 part).
3. Engine: OpenAI-compatible client (proxy, TLS, no redirects, caps, no secret logging), tools and validation, approval records (user, session, conversation, call, statement hash, single use, 10 min), policy (auto = reads only), orchestrator loop with step cap, stop, token budget, rate limit, audit before use, mock AI server fixture and the outbound canary test (FR-AST-002 to 005, 011, 013, 014, 017, 018).
4. Service and server functions: send, approve, deny, setMode (server-held), stop, conversations (store in account mode, memory otherwise), delete, schema outline for the first message, delivery of progress (poll or stream, decided in the task), thin `assistant.functions.ts`, gate list, import pin test (FR-AST-004, 015, 020 part).
5. UI: sidebar and modal (focus, draft, scroll kept), message list with safe Markdown, approval card, inline table, open result in SQL tab (prefilled, unrun), mode switch always visible, token replacement on screen, mock layer, auth-ui spec with axe light and dark and 375 px (FR-AST-003, 007, 012, 014, 020).
6. Administrator page `/admin/assistant`: on/off, model, auto allowed, hide names, endpoint status, PII markings list with suggestions from a connected schema, "no PII on this target" acknowledgement, step-up, mock layer, UI spec (FR-AST-006, 019).
7. Live spec against MySQL and MariaDB with the mock AI server, deploy section "AI assistant", acceptance walk-through, FUTURE.md entries (DELETE and DDL, AI skills, aggregate minimum group size, stored token map).

Dependency graph: 0, 1 and 2 independent; 3 needs 0, 1, 2; 4 needs 3; 5 needs 4; 6 needs 2 and 4; 7 last.

## Risks
- **PII leak through the taint analysis.** A construct the parser handles wrongly. Mitigation: unknown means metadata only; table-driven tests; mutation checks; canary scan of every outbound body (success criterion 3).
- **Inference by query shape.** Allow-only operators on PII, deny-list of functions, unknown functions refused; probe tests.
- **Approval bypass.** Mode and approval are server-side records bound to the statement hash; the client cannot claim them; replay and changed-SQL tests.
- **Writes by a model.** Always per-call approval, through the existing write guard; INSERT and UPDATE only; test that auto mode never runs a write.
- **Prompt injection from cell values.** Fixed data envelope, no new privilege for the model, safe Markdown, no image or link loading; injection test.
- **Token confusion after restart.** Epoch in each token; a foreign or lost token is refused.
- **Outbound abuse (SSRF).** Base URL is `.env` only; private addresses off by default; no redirects.
- **Parser limits.** `sqlparser-ts` may not parse every MySQL form: such statements are metadata only and the user is told why.
- **Client chunk rule.** `assistant.functions.ts` stays thin; `vite build` after tasks 4 to 6.
- **Migration.** One additive migration (9); migration test 8 to 9.
- **Build flakes.** EBUSY on `vite build` (retry); rebuild the CLI after a server build.

## Verification checkpoints
After 0: sql-tab tests unchanged plus write-path tests. After 1: table-driven taint and guard tests, mutation checks. After 2: settings, store and migration tests, env docs checks. After 3: engine tests with the mock AI server, canary test. After 4: function matrix, gate list, import pin, `vite build`. After 5: auth-ui spec, axe. After 6: admin UI spec. After 7: live spec, full `npm test`, acceptance file.
