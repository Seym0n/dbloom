# 23 — Module spec: `sql-tab` (run your own SQL: results, history, bookmarks, explain)

**Status: DRAFT for owner review (2026-10-23), not approved.** Written with the spec-driven-development skill, in the format of `22-module-structure.md`. It is the "SQL tab" module of the capability map in file 21 section 0 (depends on `skeleton`; reuses the write guard, confirmation token, statement timeout, audit, error mapper and plan store that `structure` built in `src/server/guard/` and `src/server/structure/`, and does not respecify them). Requirements marked PROPOSED are new (`FR-SQL-nnn`, type FR, subsystem SQL; the code SQL is to be added to the README table when this file is accepted). Vendor facts that this draft could not check are marked *verify*; the integration suite (section 12, package B and E) tests them before anything is built on them. The parser comparison in section 5.1 was measured on 2026-10-23 in a scratch directory (nothing was installed into `E:\dbloom`). Nothing in this file reopens a decision of `OPEN.md`, `11-target-security.md`, `12-settings.md` or `19-scenarios.md`.

## 0. Assumptions (correct me now)
1. Direct mode, one target per session, as in the skeleton. Stateful mode has the SQLite store (`DBLOOM_STORE=sqlite`, default); stateless mode (`none`) has no store and keeps history and bookmarks for the session only, in server memory (DEP-TGT-125). Account mode is not built yet; the data model is keyed so that it needs no migration later (section 5.8).
2. First slice = type SQL (one or several statements), run all or the selection or the statement at the cursor, result grids, warnings, timing, error with position, the guard (read-only, confirmation token, timeout, result caps), cancel, history, bookmarks (plain, without variables), explain and analyse, estimate of affected rows, the editor with highlighting and lazy completion. Deferred (section 2): bookmark variables and parameter binding, running one script on several databases, a per-tab pinned session with session variables, shared bookmarks, the performance_schema profile, the visual query builder, "format identifiers only when needed".
3. Write guard pieces exist and are reused unchanged: `assertWritable(GuardContext)`, `createTokenIssuer`/`hashStatements`/`StatementClass`, `runWithTimeout` (buffered only), `auditStructure`/`audit`, `mapMysqlError`, `PlanStore`, `normaliseTarget`. Four additive edits to them are listed in task 0 (section 13); everything else of this module lives in new folders (`src/lib/sql/`, `src/server/sql/`).
4. The classifier needs a parser dependency (decision Q1 of file 22, recommended in section 5.1). No dependency is added without a go (file 22 section 11 "Ask first").
5. Export of a result is the job of `io`; this module defines only the hook (FR-SQL-026). The assistant (FR-TGT-250) is a separate module; this module defines the entry point it calls (FR-SQL-027).
6. The target's privileges are the security boundary (SEC-TGT-050). Everything the classifier and the read-only guard do is a guard rail and is documented and tested as such.

## 1. Objective
A permitted user can open an SQL tab on the current target, type one or several statements in a real editor, and run them. DBLoom sends each statement to the server exactly as typed, one `query` call per statement and never as one multi-statement packet; shows one result per statement (grid, affected rows, warnings, time, or the server's error with its position); stops a running statement on request or at the statement timeout; caps the size of what it holds in memory and says so when a result is cut; refuses everything but safe reads on a read-only connection; and asks for a server-checked confirmation before destructive statements run. Every executed statement is audited without its literals. History and bookmarks are kept per target in the DBLoom store (session-only in stateless mode) and never in the browser. A query can be explained and, where it is safe, analysed.

## 2. Requirements and dispositions

Legend as in file 22. **Disp**: the triage disposition of `18-scope-triage.md` (KEEP, ADAPT, DROP, DEFER), or PROPOSED for rows of files 11, 13, 14, 16, 17 (no triage in file 18; "upstream" for file 14 rows). **Where**: IN = built in the first slice; DEFER = belongs here but later (reason); OTHER = belongs to the named module; DROP = not carried over. The traceability file (`tasks/traceability/traceability.tsv`) holds 74 rows with module `sql-tab` and no row of another module mentions the SQL tab in its note; all 74 appear below, in this order: legacy, upstream and issue rows (2.1), target rows (2.2).

### 2.1 Legacy, upstream and issue requirements

| ID | Disp | DBLoom wording (one line) | Where |
|---|---|---|---|
| FR-DTB-001 | ADAPT | One pipeline: split, classify, guard, run, render. No `LIMIT` rewriting and no automatic `COUNT(*)`; the row cap replaces them (FR-SQL-010). | IN (FR-SQL-001, 002); total count on request DEFER |
| FR-DTB-008 | KEEP | Show `SHOW WARNINGS` output after a statement that reported warnings. | IN (FR-SQL-011) |
| FR-DTB-012 | UNSURE→ADAPT | Execution time of every statement; optional profile by `EXPLAIN ANALYZE` / `ANALYZE`; no `SHOW PROFILE`. | IN for time and analyse; performance_schema profile DEFER (later performance module) |
| FR-DTB-021 | ADAPT | Several statements in order, each with its own result; the `DELIMITER` command of the mysql client changes the delimiter. | IN (FR-SQL-003, 004; no separate delimiter input field, Q4) |
| FR-DTB-022 | ADAPT | Optional transaction wrapper with rollback for DML on transactional tables. | IN as "run in one transaction" (FR-SQL-015); the legacy refusal text is replaced by a warning that DDL commits implicitly |
| FR-DTB-023 | ADAPT | Server error with the failing SQL; stop at the first error; optional continue-on-error. | IN (FR-SQL-012) |
| FR-DTB-025 | KEEP | Create a bookmark (saved SQL) with name and database. | IN (FR-SQL-018) |
| FR-DTB-026 | KEEP | Bookmarks with variables. | DEFER (needs prepared-statement binding, section 5.12; with FR-ISS-134 and 145) |
| FR-DTB-027 | ADAPT | History per user in DBLoom's own store, newest first, capped by entries, age and entry length. | IN (FR-SQL-017) |
| FR-DTB-028 | KEEP | Render all result sets of a routine call and report affected rows. | IN (FR-SQL-011; streaming of multi-result `CALL` is *verify* in task 0b) |
| FR-CFG-074 | ADAPT | Capped per-user SQL history, newest first, in DBLoom storage. | IN (FR-SQL-017) |
| CPT-DTB-001 | KEEP | Query-feature storage (history, bookmarks) without tables on the target. | IN: the DBLoom store replaces the `la_*` tables (section 5.8); nothing is written to the target |
| FR-IOX-100 | KEEP | Dry run: how many rows would a single-table UPDATE/DELETE affect. | IN as an estimate from `EXPLAIN` (FR-SQL-022); exact count by rollback DEFER (MyISAM would not roll back) |
| FR-IOX-101 | ADAPT | One SQL editor in a tab; bookmarks; navigation refresh after DROP, CREATE, ALTER, RENAME TABLE; parameters. | IN except parameters (DEFER); refresh = FR-SQL-025 |
| FR-UIX-021 | OK→ADAPT | Unsaved-change guard that covers the SQL editor text. | IN (FR-SQL-024) |
| FR-UIX-047 | KEEP | No separate console: history and bookmarks live in the SQL tab, entries can be re-run, edited, explained, bookmarked and show their time; hint "Press Ctrl+Enter to execute". | IN (explain per entry via the explain action; "profiling" only as analyse) |
| FR-UIX-049 | ADAPT | Editor options as user preferences: expand history entries, show history at start, Enter executes, dark editor theme. | IN for expand/show-history/Enter-executes (ST-163, user preference); dark editor follows the app theme; "restore current query" DROP (conflicts with no SQL in the browser; server-side drafts are Q8) |
| FR-UIX-065 | ADAPT | Editor with Ctrl+Space completion and gutter markers, modern component. | IN (CodeMirror 6, section 5.11); markers show lexical problems and server error positions only, never parser verdicts (the parser rejects valid MySQL, section 5.1) |
| FR-UIX-066 | KEEP | Syntax highlighting of displayed queries (history, query strip under a result). | IN (read-only editor view with the same language) |
| FR-UIX-067 | ADAPT | Table and column completion from the schema of the selected database, loaded once and reused. | IN (lazy, FR-SQL-023) |
| FR-UIX-068 | ADAPT | Link keywords and functions to the MySQL or MariaDB documentation of the connected product. | IN as a "Documentation for this word" action (fixed hosts, keyword restricted to letters and underscore, opens only on click, *verify* URL patterns) |
| FR-UIX-069 | KEEP | Auto-save unsent query drafts. | ADAPT: drafts live in page memory only; not in `localStorage` (SCN-007, G3). Server-side drafts: Q8 |
| NFR-DTB-002 | KEEP | Show the true query and the true server error; no automatic `LIMIT` on a failing query. | IN (FR-SQL-002, 012) |
| FR-UPD-007 | upstream | Set the SQL mode for the parser when connecting. | IN: the lexer reads `@@SESSION.sql_mode` at run start (`NO_BACKSLASH_ESCAPES`, `ANSI_QUOTES`, `PIPES_AS_CONCAT`) |
| FR-UPD-015 | upstream | SET queries shall be roll-back-able. | ADAPT: not possible on the server (session variables are not transactional). `SET` is accepted inside "run in one transaction" and the UI says it is not undone |
| FR-UPD-016 | upstream | The `SHA2` function is supported. | IN by pass-through (FR-TGT-230) and the function list for completion |
| FR-UPD-017 | upstream | Shared bookmarks switchable by `AllowSharedBookmarks`. | DEFER (needs account mode and roles; the table has a `shared` column reserved, section 5.8) |
| UI-UPD-001 | upstream | EXPLAIN and ANALYZE results have a Refresh button; loading overlay during export. | IN for refresh (FR-SQL-021); export overlay is OTHER: io |
| UI-UPD-003 | upstream | Completion list sorted and limited to the screen height. | IN |
| UI-UPD-010 | upstream | "Format as a single line" in the SQL box; format buttons for routine editors; copy button for the query generator. | IN for single line and "Format"; routine, event and trigger editors and the query generator are OTHER: browse-edit / later modules |
| DATA-ISS-119 | PROPOSED | Executable comments `/*! ... */` and `/*M! ... */` pass unchanged; the splitter neither drops nor splits on them. | IN (FR-SQL-003) |
| FR-ISS-014 | PROPOSED | Statements submitted together run in one session in order, so a `SET` applies to the following ones. | IN: one connection per run (FR-SQL-014); the next run starts clean |
| FR-ISS-101 | PROPOSED | Set session variables such as `sql_mode` for the own session and show the effective values. | DEFER (pinned per-tab session, Q3); within one run `SET` works (FR-ISS-014) |
| FR-ISS-103 | PROPOSED | Paging, sorting, re-running and exporting a result whose query depends on session state returns the same rows. | IN as: DBLoom never pages a user query on the server (no `LIMIT` rewrite); sorting is done in the browser on the loaded rows; re-run and export run the whole batch again on one connection; the full original text is reopened in the editor |
| FR-ISS-104 | PROPOSED | Before UPDATE or DELETE show the number of rows it would affect; above a threshold require confirmation. | IN as estimate in the confirmation dialog of hard statements (FR-SQL-022); the configurable threshold per statement type DEFER |
| FR-ISS-106 | PROPOSED | Run one script on a chosen set of databases, result per database. | DEFER (same runner, second slice) |
| FR-ISS-108 | PROPOSED | Server error code and message prominent above the statement; statement in a scrollable truncated area with copy; mark the error position. | IN (FR-SQL-012) |
| FR-ISS-114 | PROPOSED | `LOCK TABLES` scripts complete or fail; cancel releases the locks; editor accepts valid `LOCK TABLES`; UI states that session state ends with the request. | IN (FR-SQL-013, 014; no parser verdict in the editor) |
| FR-ISS-115 | PROPOSED | On MySQL 8.4 collect profiling from performance_schema, never `SHOW PROFILE`. | DEFER (performance module); this module never sends `SHOW PROFILE` |
| FR-ISS-118 | PROPOSED | Every statement DBLoom executes for the user is in the history; a multi-statement submission is one entry marking the failed statement and the executed count; generated statements are separate entries, hidden by default. | IN (FR-SQL-017); recording of generated statements by browse-edit is OTHER (Q5) |
| FR-ISS-123 | PROPOSED | Anything that formats or analyses SQL text finishes in bounded time and leaves the editor text unchanged on failure. | IN (FR-SQL-005 time budget; format size cap, FR-SQL-023) |
| FR-ISS-124 | PROPOSED | Any result set renders, including an unaliased scalar subquery; the expression text is the column header. | IN (rows are read as arrays, so duplicate or odd names cannot collide) |
| FR-ISS-125 | PROPOSED | Statements that return rows, including `RETURNING` on MariaDB 10.11, show them in the grid; `RETURNING` is highlighted. | IN (FR-SQL-011; highlight *verify* in `MariaSQL` dialect) |
| FR-ISS-126 | PROPOSED | Option to run all statements in one transaction, commit only if all succeed, roll back after the first error. | IN (FR-SQL-015) |
| FR-ISS-133 | PROPOSED | Identifiers shown or copied are quoted only when needed (setting); executed SQL always uses the central quoting. | DEFER (helper `quoteIdentIfNeeded` belongs to `db/identifiers.ts`; used by "insert name" in the editor later) |
| FR-ISS-134 | PROPOSED | Positional `?` and named placeholders; one input with a comma-separated list. | DEFER (with FR-DTB-026) |
| FR-ISS-135 | PROPOSED | When a statement fails the result area shows only the error, not rows, count or time of an earlier statement. | IN (FR-SQL-012: a failed statement's panel shows only the error; a failed single-statement run clears the previous results) |
| FR-ISS-141 | PROPOSED | If a visual query builder is offered, its SELECT is correct. | DEFER (no builder in scope; conditional requirement) |
| FR-ISS-144 | PROPOSED | User SQL goes to the server exactly as typed and is shown back unchanged; sorting does not alter the text; session statements such as `SET FOREIGN_KEY_CHECKS` only by explicit option, off by default. | IN (FR-SQL-002, 014) |
| FR-ISS-145 | PROPOSED | Numbered variable placeholders in saved queries, one input per number, gaps and repeats handled. | DEFER (with FR-DTB-026) |
| NFR-ISS-101 | PROPOSED | A long statement does not block other requests of the session or user. | IN (FR-SQL-029: async runner, dedicated connection, per-session cap, reserve for cancel) |
| NFR-ISS-105 | PROPOSED | History is not loaded at page load; only when the history view opens; load time independent of entry count. | IN (FR-SQL-017: paged list, index on owner and id) |
| UI-ISS-002 | PROPOSED | Completion can be switched off (also live checking); handles special characters and dots; lazy schema metadata; touch; wide popup. | IN (FR-SQL-023; switch is a user preference) |
| UI-ISS-102 | PROPOSED | An action runs only the selected text if there is a selection, else the whole content. | IN (Ctrl+Enter, section 5.11) |
| UI-ISS-123 | PROPOSED | With rollback enabled no DML confirmation; disabled: the confirmation says the changes will be committed. | IN, narrowed: the hard-class dialog always appears (it is server-enforced, ST-120); the dialog states "committed" or "rolled back at the end" according to FR-SQL-015 |
| UI-ISS-126 | PROPOSED | Completion offers the built-in functions of the connected product and adds parentheses. | IN (function list per product from the capability strategy) |
| UI-ISS-132 | PROPOSED | Completion suggests the full phrase (`INNER JOIN`, `LEFT JOIN`, `GROUP BY`, `ORDER BY`). | IN |
| UI-ISS-135 | PROPOSED | Completion matches by subsequence as well as prefix (`pmu` finds `prefix_modulename_users`). | IN |
| UI-ISS-138 | PROPOSED | The inline SQL edit field grows with its content up to about 10 lines. | IN (editor auto-height 4 to 10 lines inside the resizable pane; the inline field of browse-edit reuses the component) |

### 2.2 Target requirements (files 11, 12, 13)

| ID | Disp | What it means for this module | Where |
|---|---|---|---|
| SEC-TGT-033 | in force | Query timeout configurable with a safe default; the user is told when a limit was hit. | IN (FR-SQL-009) |
| SEC-TGT-052 | in force | Read-only at three levels, blocks read-write transaction switches and multi-statement bypass; destructive confirmation by server two-step token; statement timeout; maximum result size. | IN (FR-SQL-007, 008, 009, 010); the settings UI for the levels is OTHER: admin |
| ST-110 | file 12 | Statement timeout; 0 rejected; non-SELECT needs the `KILL QUERY` watchdog. | IN (FR-SQL-009; reuses `runWithTimeout` logic) |
| ST-114 | file 12 | Result row cap (F 100 / D 10 000 / C 100 000); truncation announced. | IN (FR-SQL-010) |
| ST-115 | file 12 | Max response bytes (D 16 MiB) and max bytes per cell (D 64 KiB). | IN (FR-SQL-010) |
| ST-119 | file 12 | Read-only guard; must block `SET SESSION TRANSACTION READ WRITE` and multi-statement bypass. | IN (FR-SQL-007) |
| ST-120 | file 12 | Destructive confirmation: floor on for the hard class in `.env`; server-side token; soft class user-switchable. | IN (FR-SQL-008) |
| ST-121 | file 12 | Blocked statement classes / multi-statement in the SQL box (best effort, labelled). | IN (the classifier exposes `kind`; `.env` list of blocked kinds and `allowMultiple` are checked by the guard; settings UI OTHER: admin) |
| ST-128 | file 12 | Redaction of literals in password-setting statements in history and audit; fixed in code. | IN (FR-SQL-016, 017) |
| ST-161 | file 12 | SQL history and bookmarks: enabled, entries, age, entry length; user may delete own, audit is not deletable. | IN (FR-SQL-017, 018) |
| ST-162 | file 12 | Export of a user's own state (bookmarks, history; no credentials). | OTHER: admin/settings; this module provides `exportOwnSqlState(ownerKey)` |
| ST-163 | file 12 | Keyboard shortcuts off; console layout options. | IN (character-key shortcuts are switchable; Ctrl/Cmd shortcuts are not character keys) |
| ST-164 | file 12 | SQL tab available at all (ENV permit is the ceiling). | IN (FR-SQL-028) |
| SEC-TGT-023 | in force | No credentials or tokens in logs, errors, audit. | IN (FR-SQL-016) |
| SEC-TGT-050 | in force | The target's privileges are the boundary; the guard is a guard rail. | IN (documented and tested, SCN-021 reused) |
| SEC-TGT-051, 117 | in force | One central quoting function; no string-built SQL outside the builder; lint rule. | IN: user text is never built, only sliced; the few fixed prefixes (`EXPLAIN`, `USE`, `SET SESSION`, `KILL QUERY`) are in `src/server/sql/fixed.ts`, the only file of the module the lint rule allows to contain SQL keywords; identifiers use `quoteIdent` |
| SEC-TGT-053 | in force | Minimum privileges per feature are documented. | IN (section 5.14 table) |
| SEC-TGT-112 | in force | Cell values, names, error text from the server are untrusted; shown as text. | IN (cells as text, errors escaped, history text escaped; the grid never renders HTML) |
| SEC-TGT-116 | in force | Existing names from the client must exist on the server. | IN for the selected database and the table of `getCompletionSchema` |
| SEC-TGT-151 | DECIDED | Parser for the advanced-expression fields; unrestricted SQL only here, under the guards of SEC-TGT-052. | IN: this module owns the parser adapter (section 5.1); `structure/expression.ts` may switch to it later |
| DATA-TGT-094, 095 | DECIDED | History and bookmarks in the DBLoom store keyed by the normalised target; the target is recorded on each entry; nothing written to the target. | IN (section 5.8) |
| DEP-TGT-125 | DECIDED/PROPOSED | Stateless: history and bookmarks last for the session; SQL text never in browser storage. | IN (FR-SQL-019) |
| FR-TGT-230 | PROPOSED | CTE, window functions, `JSON_TABLE`; an unknown valid statement is sent unchanged, not blocked. | IN (FR-SQL-006) |
| FR-TGT-231 | PROPOSED | Explain and analyse as tree and raw text or JSON; analyse of a changing statement needs explicit confirmation naming it. | IN (FR-SQL-021) |
| FR-TGT-250 | DECIDED | The assistant's SQL tool call shares the guard; inline table plus SQL; a button opens the full result in a tab of the same browser tab. | IN as the hook FR-SQL-027 |
| NFR-TGT-090 | in force | Audit log of destructive statements, no secrets or result data. | IN (FR-SQL-016) |
| NFR-TGT-160 | DECIDED | All user-visible text through `t('key')`. | IN (prefix `sql.`) |
| ARCH-TGT-001, 002, 003 | PROPOSED/DECIDED | Adapter and strategies by product; minimums MySQL 8.4 and MariaDB 10.11. | IN (explain syntax, timeout variable, function lists per product) |
| UI-TGT-001, 003 | DECIDED | Three-area shell, tabs; shadcn/ui; CodeMirror 6 proposed for the editor. | IN |
| FR-STR-004, 005, 017 (file 22) | in force | Plan binding, destructive classes, timeout and lock wait. | Reused, see FR-SQL-008, 009 |

### 2.3 New requirements (PROPOSED)

| ID | Statement | Verification |
|---|---|---|
| FR-SQL-001 | **Pipeline, server authoritative.** `lex/split -> classify -> guard -> (plan -> confirm) -> run -> map`. The browser may use the same lexer (`src/lib/sql/`) for "statement at cursor" and highlighting, but the server always splits and classifies again from the text; the client sends text and a range, never statements, classes or tokens it made up. | A request carrying `statements` or `class` fields is rejected by the zod schema. |
| FR-SQL-002 | **Exact text.** Each statement is sent as the exact slice of the user's text from its first non-blank character to before its delimiter: comments kept, no appended delimiter, no `LIMIT`, no rewrite, no `USE` inserted into the text. Results, history and the query strip show that same text. | `SELECT 1 -- foobar` run three times is identical; audit hash equals SHA-256 of the slice; a sort in the grid does not change the text (FR-ISS-144). |
| FR-SQL-003 | **Splitter.** A MySQL/MariaDB lexer (hand written, linear time) splits on the current delimiter outside of single, double and backtick quotes (backslash escapes unless `NO_BACKSLASH_ESCAPES`), `-- ` (dash dash followed by space, tab, newline or end), `#`, and `/* */` comments. `/*! ... */` and `/*M! ... */` are kept as part of the statement unchanged and are never split. The client command `DELIMITER <token>` on a line of its own changes the delimiter (also multi-character), is not sent to the server and is reset at the end of the run. Each statement gets `{text, start, end}` offsets in the original text. An unterminated string or comment is reported as a lexical error with its position before anything runs. | Table-driven unit tests; fuzz: concatenating the slices and delimiters reproduces the input; 1 MiB parses in under 1 s. |
| FR-SQL-004 | **One `query` per statement.** `multipleStatements` stays false; a run is a loop of single `query` calls on one connection. Limits: text at most 1 MiB (ST-116), at most 500 statements per run (setting `maxStatements`), each statement at most 256 KiB for analysis. If `.env` forbids multi-statement (ST-121) more than one statement is refused before anything runs. | Test double records one call per statement; pool option asserted. |
| FR-SQL-005 | **Classifier.** `classify(text, serverInfo): Classification` is pure and synchronous after the one-time parser initialisation. It returns `{kind, class: 'none'\|'soft'\|'hard', readOnlySafe, reasons[], parsed}` per statement (section 5.3). Time budget: analysis of a run stops after 2 s total; statements not analysed in time are classified by the lexer only (hard unless on the safe list). | Classification table test (section 10); budget test with a pathological script. |
| FR-SQL-006 | **Parser failure never blocks, never relaxes.** If the parser rejects a statement, the statement is still sent. Its class is decided by the leading keyword of the lexer: a fixed allow-list of read keywords (`SELECT`, `WITH`, `SHOW`, `DESCRIBE`, `DESC`, `EXPLAIN` without `ANALYZE`, `USE`, `SET @user_var`) without `INTO`, `FOR UPDATE`, `LOCK IN SHARE MODE` gets class none; anything else, and every unknown keyword, gets class hard with reason `unparsed`. In read-only mode an unparsed statement outside the allow-list is refused. | Corpus of valid MySQL 8.4 / MariaDB 10.11 statements that the parser rejects (section 5.1): all run on a read-write connection after confirmation; none passes on read-only. |
| FR-SQL-007 | **Read-only, three layers.** (1) Before any connection: `assertWritable` for every statement with `readOnlySafe = false`; safe reads run. (2) On the connection: `SET SESSION TRANSACTION READ ONLY` is the first statement of every run, so the server refuses writes made by routines and functions too (error 1792, *verify* both products). (3) The target's privileges. The classifier refuses `SET [SESSION] TRANSACTION READ WRITE`, `START TRANSACTION READ WRITE`, and any `SET` of `transaction_read_only` / `tx_read_only` (also as `@@session.` form) on a read-only connection; `CALL`, `LOCK TABLES`, `HANDLER`, `LOAD`, `SELECT ... INTO`, `DO` and unparsed statements are refused. No `multipleStatements`. | SCN-027; each bypass attempt refused with `read-only`; no connection opened for a refused run (counter). |
| FR-SQL-008 | **Confirmation by plan and token.** The highest class of the run decides. Class none: runs at once. Class soft: the server answers `confirm` and runs only after a second call with the plan id; the user may switch soft confirmations off (ST-120), then the client sends `acceptSoft`, honoured for soft only. Class hard: the server stores a plan (`PlanStore`, 10 minutes, single use, bound to session, target and the exact statements), issues the token (`createTokenIssuer`, bound to plan and statement hash) and runs only when the second call carries plan id and valid token. The dialog lists every non-none statement with its class, kind and reason. Hard cannot be switched off by the user. | SCN-026: direct call without token refused; replay, expiry and other-session refused; text edit after the dialog needs a new plan. |
| FR-SQL-009 | **Statement timeout.** Each statement has the statement timeout of ST-110 (default 60 s, user may lower, 0 rejected). Enforced by the watchdog (`KILL QUERY` from a second connection) and, as a first line, on the server: MySQL `SET SESSION max_execution_time` (milliseconds, SELECT only) and MariaDB `SET SESSION max_statement_time` (seconds) at connection start (*verify*). On timeout the statement is reported with the fixed text "stopped after N s (time limit)", the run stops (or continues if continue-on-error is on), and the connection is destroyed if it no longer answers. | SCN-028 on both products. |
| FR-SQL-010 | **Result caps, streaming.** Rows are read from the driver as a stream and converted cell by cell (`Cell` of `db/rows.ts`, but with the cell cap of ST-115, default 64 KiB; binary summarised). Per run the row cap of ST-114 (default 10 000 per result set) and the byte cap of ST-115 (default 16 MiB across the response) apply; whichever is reached first stops reading that result set, sends `KILL QUERY` for the rest, and marks the set `truncated: {reason: 'rows'\|'bytes', shown, limit}`. The UI says: "Showing the first N rows. The statement returned more; add LIMIT, or raise the limit (up to M)." A statement that is cut by the cap is never reported as complete, and its count is not presented as the total. | SCN-029; memory of the server stays flat for a 50-million-row `SELECT`. |
| FR-SQL-011 | **Result shape.** Per statement: `rows` (column names, kinds, cells) or `ok` (affected rows, insert id, info), `warningCount` and, when it is above 0, up to 50 warnings from `SHOW WARNINGS` on the same connection; duration in ms; the statement text and range. Any statement that returns rows (also `INSERT/DELETE ... RETURNING`, `SHOW`, `CALL`) gives a grid; `CALL` may give several grids plus the final OK. Rows are read as arrays; the header is the name the server reports, so an unaliased expression shows its text. | SCN-024, 034. |
| FR-SQL-012 | **Failure semantics.** A run stops at the first error (default) or continues when "continue on error" is on. The response lists every statement as executed, failed or not-run, so partial effects are visible. A failed statement shows only the mapped error: errno, the server's message (escaped), hint from the closed table of `errors.ts` (extended with 1064 for `DELIMITER`, 1235, 1792, 1290, 3024), and the position (absolute offset computed from the server's "near ... at line N" and the statement's offset, or the whole statement when none). The raw driver object never leaves the server. | SCN-025. |
| FR-SQL-013 | **Cancel.** The client creates a `runId` (128-bit random) with the request; `cancelSql({runId})` is accepted only for a run of the same session, sends `KILL QUERY <threadId>` from a second connection, stops the loop (not-run for the rest), and reports "cancelled by you" (not as timeout). A cancel for an unknown or finished run gives the same neutral answer. Closing the tab or ending the session cancels the run. | SCN-033. |
| FR-SQL-014 | **Connection and session state.** A run takes one connection from the pool and applies, in this order and only from fixed templates: the read-only transaction setting if read-only (FR-SQL-007), the timeout variables (FR-SQL-009), `USE <db>` for the tab's selected database (name checked against `SHOW DATABASES`, quoted by `quoteIdent`; a failing `USE` stops the run), and, only if the option "disable foreign key checks for this run" is on (default off), `SET SESSION foreign_key_checks = 0`. User `USE`, `SET`, `LOCK TABLES`, `START TRANSACTION`, user variables and temporary tables therefore work inside one run. At the end the connection is destroyed, never returned to the pool, so no state, lock or open transaction can leak to browse or structure (they use fully qualified names and never `USE`). The tab remembers the database after a user `USE` only for display. A pinned session per tab is DEFER (Q3). | SCN-036; after a run `@@sql_mode`, `@@foreign_key_checks` and user variables on the next run are defaults. |
| FR-SQL-015 | **Run in one transaction (option).** Off by default. On: `START TRANSACTION` first; all statements; `COMMIT` if all succeed, `ROLLBACK` after the first error (continue-on-error is disabled by the option). The classifier marks statements that commit implicitly (DDL, `LOCK TABLES`, `START TRANSACTION`, `SET autocommit`, administrative statements); with such a statement in the run the UI warns before running ("these statements end the transaction; earlier changes stay") and the dialog repeats it. A transaction left open by user text at the end of a run is rolled back by destroying the connection and the result says so. | SCN-036 with a failing third statement; DDL warning test. |
| FR-SQL-016 | **Audit.** One line `sql.run` per run (user, target, runId, statement count, highest class, outcome, duration) and one `sql.statement` per statement that is not class none or is not read-only safe (kind, class, hash of the statement text, outcome, errno, duration, affected rows). No SQL text, no literals, no result data, no token (NFR-TGT-090, SEC-TGT-023). Refused attempts (read-only, missing token) are audited as `refused` with the code. | Log capture test: no literal and no password appears; `CREATE USER ... IDENTIFIED BY 'x'` never shows `x`. |
| FR-SQL-017 | **History.** After each run that reached the server one entry is stored: the redacted text of the whole submission, the database, statement count, executed count, index of the failed statement, highest class, outcome (`ok`, `error`, `cancelled`, `timeout`), duration, time, source (`user` or `generated`). Text longer than the entry limit of ST-161 (default 64 KiB) is not stored (the entry is kept without text and marked). Retention per owner: newest N entries (default 100) and at most D days (default 30), applied on insert and at start-up. Redaction (fixed in code, ST-128): string literals after `IDENTIFIED BY`, `IDENTIFIED WITH ... AS`, `PASSWORD(`, `SET PASSWORD =`, `OLD_PASSWORD(`, `AES_ENCRYPT(` key argument, `CHANGE MASTER ... MASTER_PASSWORD =` are replaced by `'***'`. The list is fetched only when the history view opens, newest first, in pages of 50; a failure to write history never fails the run. Entries can be re-run, edited (loaded into the editor), explained, bookmarked, deleted one by one or all. | SCN-030, 031. |
| FR-SQL-018 | **Bookmarks.** A bookmark has a name (unique per owner and target, at most 120 characters), the SQL text (at most 64 KiB, redacted by the same function), an optional default database and a time. Create from the editor or from a history entry, rename, edit, delete, load into the editor, run. At most 500 per owner and target. | SCN-030. |
| FR-SQL-019 | **Stateless and browser storage.** Without the store, history and bookmarks live in a bounded in-memory map per session (same limits), disappear with the session, and are listed by the same functions; the UI says "kept for this session only". In both modes SQL text, drafts, history and bookmarks are never written to `localStorage`, `sessionStorage`, IndexedDB or cookies. Only non-sensitive preferences may use local storage (DEP-TGT-125). | SCN-031: a Playwright check that browser storage contains no SQL fragment after a run. |
| FR-SQL-020 | **Store schema versions.** The SQLite store gets a migration runner based on `PRAGMA user_version`; migration 1 is the existing sessions schema, migration 2 adds the SQL tables (section 5.8). Migrations run in one transaction at start-up; a store with a higher version than the code refuses to start. | Store test from an empty file and from a version-1 file with sessions present. |
| FR-SQL-021 | **Explain and analyse.** On one statement (selection or at cursor) the user chooses Explain or Analyse and a format (tree, text, JSON where the product offers it). The prefix comes from a fixed table per product (MySQL 8.4: `EXPLAIN [FORMAT=TRADITIONAL\|JSON\|TREE]`, `EXPLAIN ANALYZE` (tree only); MariaDB 10.11: `EXPLAIN [FORMAT=JSON]`, `ANALYZE [FORMAT=JSON]`; *verify* each). Plain EXPLAIN of any explainable statement is class none (it does not run it) and also allowed on read-only. Analyse executes the statement: allowed directly for read statements (class none and `readOnlySafe`); for a statement that changes data (MariaDB `ANALYZE UPDATE/DELETE` really changes data) it needs the hard-class token and the dialog names the statement (FR-TGT-231); on read-only it is refused. The raw text is always shown; the tree is built from the JSON form where available. Refresh re-runs. Explain and analyse use the same timeout, caps and audit as a run. | SCN-032. |
| FR-SQL-022 | **Affected-rows estimate.** For a single-table `UPDATE` or `DELETE` that the parser recognises, the confirmation dialog and an action "Estimate rows" show "about N rows" from the `rows` column of `EXPLAIN <statement>` (fixed prefix, no execution). It is labelled an estimate and is absent when the statement is not recognised or EXPLAIN fails. | SCN-026: estimate within a factor of two on a 1000-row table. |
| FR-SQL-023 | **Editor and completion.** CodeMirror 6 with the `MySQL` or `MariaSQL` dialect of `@codemirror/lang-sql` chosen from the capability probe. Completion: keywords, the functions of the product (with parentheses), phrases (`GROUP BY`), databases, then tables of the selected database, then columns of a table once it appears in the statement or is typed with a dot; subsequence match; backtick quoting inserted when a name needs it; at most 200 items, list height limited to the screen; metadata loaded lazily by `getCompletionSchema({db, table?})` with a cache per tab and no retry loop on failure; switchable off (also the live lint). Format uses `sql-formatter` with dialect `mysql` or `mariadb`, only for text up to 200 KiB, and leaves the text unchanged on any error; "single line" is made by the lexer (comments turned into `/* */`). | Component tests; a schema with 5 000 tables does not fetch columns until needed. |
| FR-SQL-024 | **Drafts and dirty guard.** Editor text lives in page memory (it survives switching tabs because the tab stays mounted). A tab whose text is non-empty and differs from the last run text or the loaded bookmark is "unsaved": closing it, switching the target and leaving the page ask first (FR-UIX-021, G6). After session end the sign-in dialog keeps the text in memory (G3); a different user signing in discards it. | SCN-031. |
| FR-SQL-025 | **Navigation refresh.** A successful `CREATE`, `DROP`, `ALTER` or `RENAME` of a database or table (kind from the classifier) emits `structure.changed {db, table?}` on the existing `structureEvents`, so the sidebar and cached structure refresh. | Sidebar shows a table created in the SQL tab without reload. |
| FR-SQL-026 | **Export hook (io).** `src/server/sql/export-source.ts` exports `openResultStream(env, {db, text, statementIndex})`: it re-splits the text, accepts only a statement of class none and `readOnlySafe`, applies timeout and audit, ignores the row and byte caps of the grid (io streams with back pressure, G4) and yields rows and column metadata. `io` calls it from the "Export" button of a result; this module does not write files. | io test uses the hook; a write statement is refused. |
| FR-SQL-027 | **Assistant hook.** `runForAssistant(env, {db, text, maxRows})` splits the text; accepts exactly one statement; runs it only if class none and `readOnlySafe` (no confirmation can be given by a model); any other statement returns `{needsUser: true, reason}` and the assistant shows it with a button that opens an SQL tab prefilled and not run. Same timeout, caps (inline cap default 100 rows), audit (source `assistant`) and history (source `assistant`, hidden by default). PII filtering of columns (SEC-TGT-158) is applied by the assistant module on the returned set. The "open full result" button opens an SQL tab of the same browser tab with the statement; the user runs it. | Assistant test double: a `DROP` is never run; a SELECT shows an inline table. |
| FR-SQL-028 | **Availability and limits.** Server functions refuse with `sql_disabled` when ST-164 turns the tab off; the shell hides the entry. `resolveSqlLimits(session)` returns timeout, row cap, byte cap, cell cap, text cap, statement cap, history limits, each the minimum of `.env` bound and user preference; until the settings module exists it reads the defaults from `Config`. | Unit test of the resolver; disabled tab refused. |
| FR-SQL-029 | **Concurrency.** The pool has 4 connections. At most 2 runs per session run at the same time (the third is refused with `busy`), so one connection is always free for cancel and for other tabs; the run is asynchronous, so other requests of the session are not blocked (NFR-ISS-101). | Test: an ALTER-like `SELECT SLEEP(5)` in tab one does not delay browsing in tab two. |
| FR-SQL-030 | **Output safety.** Cells, column names, error messages, warnings, statement text, history and bookmark names are rendered as text only (React text nodes), never as HTML; documentation links use fixed hosts. | Test with `<img onerror>` in a cell, a column alias and an error message. |

## 3. Scenarios

Style and actors as in `19-scenarios.md`; numbering continues after SCN-023 of file 22. Test targets: `mysql:8.4` on port 33064 and `mariadb:10.11` on port 33061 (root/root, from `compose.test.yaml`), once per product unless a scenario says otherwise. Each Playwright test creates its own scratch database through the fixture (`e2e_<random>`, with a table `customer` of 1 000 rows where needed) and drops it in `afterEach`. Direct-mode login as in SCN-004.

### SCN-024 Run a SELECT (A, D)
*Actor:* developer with SELECT. *Before:* logged in; database `e2e_x` with `customer` (1 000 rows) selected in the tree.
1. The user opens a SQL tab (database `e2e_x` is shown in the tab header), types `SELECT id, name FROM customer ORDER BY id`, presses Ctrl+Enter.
2. A grid with the columns `id`, `name`, 1 000 rows (virtualised), the time in ms and the query strip with the statement appear.
3. The user sorts by `name` in the grid.
*Accept when:* the server received exactly the typed text, one `query` call, no `LIMIT` (FR-SQL-002, test double); no confirmation was asked (class none); the grid sort is done in the browser and the query strip text does not change (FR-ISS-144); `SELECT 1 -- foobar` run three times stays identical; `SELECT (SELECT COUNT(*) FROM customer)` shows the expression text as column header (FR-ISS-124); a `<img onerror>` cell value is shown as text (FR-SQL-030); the history gets one entry (stateful) with outcome `ok`; an audit line `sql.run` exists with no SQL text; the hint "Press Ctrl+Enter to run" is visible.
*Requirements:* FR-DTB-001, 012; FR-UIX-047; FR-ISS-124, 144; FR-SQL-001, 002, 011, 016, 017, 030; SEC-TGT-112; UI-ISS-102.

### SCN-025 Several statements, one fails in the middle (A, D)
1. The user types three statements: `CREATE TABLE t1 (id INT)`, `INSERT INTO nope VALUES (1)`, `SELECT 1`, and runs all.
*Accept when:* the result shows statement 1 as done (OK, 0 rows affected, time), statement 2 as failed with the server's error 1146 verbatim, the hint "The table does not exist." and the position marked in the editor on statement 2, statement 3 as "not run" and no earlier result is shown inside the failed statement's panel (FR-ISS-135); `t1` exists afterwards (no rollback, DDL commits); the history entry is one entry holding all three statements with "failed at 2, executed 1" (FR-ISS-118). With "continue on error" on, statement 3 runs and the run is reported as partly failed. A syntax error in statement 2 (`SELEC 1`) gives error 1064 with the server's "near ... at line N" and the position inside statement 2, converted to the absolute offset when the statement starts on line 3 of the text. An unterminated string is reported before anything runs and `t1` is not created.
*Requirements:* FR-DTB-021, 023; NFR-DTB-002; FR-ISS-108, 118, 135; FR-SQL-003, 004, 012.

### SCN-026 Destructive statements need the server-side confirmation (A, D)
1. The user types `DELETE FROM customer` and runs it. 2. Then `DELETE FROM customer WHERE id = 5`. 3. Then `DROP TABLE customer`. 4. Then `UPDATE customer SET name = 'x' WHERE 1 = 1`.
*Accept when:* statements 1, 3 and 4 return `confirm` (hard: no restricting condition, drop, constant-true condition) and nothing ran (row count still 1 000); the dialog lists each statement with class, reason and, for 1 and 4, "about 1000 rows" (FR-SQL-022); a direct call of `confirmSql` with the plan id but no token is refused and a forged, replayed, expired or other-session token is refused (same cases as SCN-014); with the token the statement runs once and the plan cannot be reused; editing the text after the dialog needs a new plan; statement 2 runs without a hard confirmation (soft class setting applies: with soft confirmations on, the soft dialog appears, with them off it runs); the audit has one `sql.statement` line per run statement with class `hard` and the statement hash, no text; in a batch `SELECT 1; DROP TABLE t` the whole batch waits for the token and shows both statements.
*Requirements:* SEC-TGT-052; ST-120; FR-ISS-104; FR-IOX-100; FR-SQL-005, 008, 016, 022; FR-STR-004, 005 (reused).

### SCN-027 Read-only connection (A, D)
*Before:* the session is read-only (forced by `DBLOOM_READ_ONLY=true` or switched on for the session).
*Accept when:* `SELECT`, `SHOW TABLES`, `DESCRIBE customer`, `EXPLAIN SELECT ...` and `USE e2e_x` run; `INSERT`, `CREATE TABLE`, `CALL p()`, `LOCK TABLES`, `SELECT ... INTO OUTFILE`, `LOAD DATA` and an unparsed statement outside the allow-list are refused with the stable code `read-only` before a connection is opened (counter in the test double); `SET SESSION TRANSACTION READ WRITE`, `START TRANSACTION READ WRITE`, `SET @@session.tx_read_only = 0` and `SET SESSION transaction_read_only = OFF` are refused; a `SELECT` of a function that writes (a stored function created by the fixture) fails on the server with 1792 because the connection is in a read-only transaction (*verify* both products); a two-statement text `SELECT 1; DROP TABLE x` is refused as a whole before the first statement runs; with read-only forced by `.env` the user cannot switch it off from the UI; with read-only chosen by the user, switching to read-write is possible and the same statements work.
*Requirements:* SEC-TGT-052; ST-119; FR-SQL-007; SEC-TGT-050.

### SCN-028 Timeout (A, D)
*Before:* statement timeout lowered to 2 s by the user (default 60 s).
1. The user runs `SELECT SLEEP(10)`, then `DELETE FROM big WHERE ...` that takes longer than the limit, then a two-statement text whose second statement times out.
*Accept when:* each is stopped after about 2 s and shown as "stopped after 2 s (time limit)", not as a generic error (SEC-TGT-033); the server shows no remaining thread of the user (`SHOW PROCESSLIST`); the earlier statement of the two-statement text keeps its result; a timeout of 0 in the preferences is rejected; on MariaDB the server-side `max_statement_time` fires first for SELECT, on MySQL `max_execution_time` fires first for SELECT and the watchdog for DML (*verify* and record the observed order); the next run on the session works (connection replaced if needed); the audit outcome is `error 3024` or `timeout` per product.
*Requirements:* SEC-TGT-033; ST-110; FR-SQL-009, 012.

### SCN-029 Result size cap and truncation message (A, D)
*Before:* a table `seq` with 200 000 rows; row cap lowered to 1 000 for the test; a table with a 5 MB `LONGTEXT` cell.
*Accept when:* `SELECT * FROM seq` shows exactly 1 000 rows and the notice "Showing the first 1 000 rows. The statement returned more; add LIMIT, or raise the limit (up to N)." (the statement was stopped on the server by `KILL QUERY`; no thread remains); the notice does not state a total; a `SELECT` of 1 000 rows with a 64 KiB-plus cell shows the cell cut with its length, and the response stays below the byte cap and says "cut by size" when that cap ends the set; with three result sets (`CALL`) the byte cap is shared; server memory (RSS) stays within a flat bound while reading a 50-million-row set (integration check); raising the row cap above the administrator maximum is not possible; the history entry stores the statement, not the rows.
*Requirements:* ST-114, 115; SEC-TGT-052; FR-SQL-010.

### SCN-030 History and bookmarks per target, stateful mode (A, D)
*Before:* store `sqlite`; two targets: `A` = `127.0.0.1:33064` and `B` = `127.0.0.1:33061` (two sessions, two browser contexts).
1. On A the user runs three statements, opens the history view, bookmarks the second as "customers by name", then restarts the DBLoom process and logs in on A again.
2. On B the user opens the history and the bookmarks.
*Accept when:* on A the history lists newest first with time, database, outcome, duration; the history view is not fetched at page load (request log, NFR-ISS-105); the bookmark and the history survive the restart; on B both lists are empty and an entry made on B is not visible on A (key from `normaliseTarget`, DATA-TGT-095; `localhost` and `127.0.0.1` are two keys, accepted); re-run, edit and delete of an entry work; with the entry limit set to 5, the sixth run removes the oldest; entries older than the age limit disappear at start-up; a text of 70 KiB is run but stored without text and marked; `CREATE USER u IDENTIFIED BY 'secret'` is stored as `... IDENTIFIED BY '***'`; a bookmark name that exists gives a clear error; a request that names another owner's entry id is refused as "not found"; the store file contains no password and the target saw no write for history.
*Requirements:* FR-DTB-025, 027; FR-CFG-074; CPT-DTB-001; DATA-TGT-094, 095; ST-128, 161; NFR-ISS-105; FR-SQL-017, 018, 020.

### SCN-031 Stateless mode: session-only, nothing in the browser (A, D, S)
*Before:* `DBLOOM_STORE=none`.
*Accept when:* the SQL tab runs as in SCN-024; history and bookmarks work and the page says "kept for this session only"; after logout, or a server restart followed by login, both are empty (G10: the "session ended" dialog first); no file was written by the container (read-only root file system works); after several runs a Playwright check over `localStorage`, `sessionStorage`, IndexedDB and cookies finds none of the typed text, statements or bookmark names; typed unsaved SQL survives the sign-in dialog (SCN-009) in page memory and is discarded when a different target user signs in; closing a tab with unsaved text asks first; the in-memory map is bounded (entry limit) and is dropped with the session.
*Requirements:* DEP-TGT-125; FR-UIX-021, 069; FR-SQL-019, 024; SCN-007.

### SCN-032 Explain and analyse (A, D, once per product)
1. The user selects `SELECT * FROM customer WHERE id = 5`, chooses Explain, then Analyse, then JSON/text.
2. The user selects `UPDATE customer SET name = 'y' WHERE id = 5` and chooses Analyse.
*Accept when:* Explain shows the plan as tree (from JSON) and the raw text; the executed statement is `EXPLAIN FORMAT=JSON ...` (MySQL) or the MariaDB form; Analyse on the SELECT runs it and shows actual timings (`EXPLAIN ANALYZE` on MySQL as tree text only; `ANALYZE FORMAT=JSON` on MariaDB); Refresh re-runs; step 2 asks for the hard confirmation naming the UPDATE ("Analyse executes this statement and changes data") and only then runs; without the token nothing changed; on read-only, Explain works and Analyse of the UPDATE is refused; an unknown statement kind gives "cannot be explained" with the server's message; explain of a text with two statements is refused ("select one statement"); the history entry is marked as explain and the timeout applies.
*Requirements:* FR-TGT-231; FR-DTB-012; UI-UPD-001; FR-SQL-021.

### SCN-033 Cancel a running statement (A, D)
1. The user runs `SELECT SLEEP(30)` (statement 1) followed by `SELECT 2`, and presses Cancel after 2 s.
*Accept when:* within about 1 s the statement ends with "cancelled by you" (not "timeout"), statement 2 is "not run", the server's process list no longer shows the thread, the connection is gone, a new run works at once, the history outcome is `cancelled`, the audit line has outcome `cancelled`; a cancel from another session with the same `runId` has no effect and gets the neutral answer; cancel of a finished run is harmless; with a script `LOCK TABLES x WRITE; SELECT SLEEP(30)` the lock is released after cancel (a second connection can read `x`); closing the browser tab ends the run; two runs at once work, the third is refused with `busy` and cancel still works while two are running.
*Requirements:* FR-ISS-114; NFR-ISS-101; FR-SQL-013, 029.

### SCN-034 Dialect statements, parser fallback, delimiter (A, D, once per product)
Statements that run on the product (the rest are skipped with the product marked): `WITH RECURSIVE`, window functions, `JSON_TABLE` (MySQL 8.4 and MariaDB 10.6+), `INSERT ... RETURNING` and `DELETE ... RETURNING *` (MariaDB 10.11: rows in a grid), `SELECT /*! STRAIGHT_JOIN */ 1 /*M! , 2 */` (kept unchanged, executable comments), `SET @a := 1; SELECT @a` (parser rejects the first; it still runs), `SHOW FULL PROCESSLIST`, `SELECT * FROM t PARTITION (p0)`, `ALTER TABLE ... ADD INDEX ... INVISIBLE` (MySQL), `SELECT ... FOR UPDATE SKIP LOCKED`, `CALL p()` with two result sets, and a script with `DELIMITER $$ CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END $$ DELIMITER ;`.
*Accept when:* none is refused by DBLoom's own parser (FR-TGT-230); those the parser rejects are classified by the lexer (unparsed: hard unless on the read allow-list) and ask for the confirmation, except the read allow-list ones; a `;` inside a string, a comment and the procedure body does not split; the procedure body is sent as one statement; without `DELIMITER` a `CREATE PROCEDURE` with inner `;` fails on the server with 1064 and the hint names `DELIMITER`; `SELECT SHA2('a', 256)` works; `LOCK TABLES a READ; SELECT ...; UNLOCK TABLES` shows no editor error marker (FR-ISS-114).
*Requirements:* FR-TGT-230; DATA-ISS-119; FR-ISS-125; FR-DTB-028; FR-UPD-016; FR-SQL-003, 006, 011.

### SCN-035 Export hook and assistant tool call (A, D)
1. A result is shown; the Export action of `io` calls `openResultStream` for that statement. 2. The assistant asks "how many customers?", then "delete the customers".
*Accept when:* the hook re-splits the text, accepts a SELECT, ignores the grid caps (a 200 000-row `seq` is streamed in an integration test without being held in memory), applies the timeout and audits the export; a write statement given to the hook is refused; the assistant's tool call for the count runs through the same classifier, read-only guard, timeout and audit, gives at most 100 inline rows with the SQL, and the button opens an SQL tab of the same browser tab with the statement, not run; for "delete the customers" the tool returns `needsUser`, nothing ran, and the SQL is offered in a prefilled tab where the normal confirmation applies; a read-only session lets the assistant read and nothing else.
*Requirements:* FR-TGT-250; FR-SQL-026, 027; SEC-TGT-052; G4, G6.

### SCN-036 Session state, FK-checks option and transaction option (A, D)
1. The user runs `SET SESSION sql_mode = 'ANSI'; SET @x := 7; SELECT @@sql_mode, @x` in one run, then `SELECT @x` in a second run.
2. The user turns on "run in one transaction" and runs `INSERT ...; INSERT ...(fails); INSERT ...`, then `INSERT ...; ALTER TABLE ...; INSERT ...(fails)`.
3. The user runs `DELETE FROM parent` with a referencing child, with and without "disable foreign key checks for this run".
*Accept when:* the first run shows `ANSI...` and 7, the second shows NULL (a new connection, no leak; the UI says session state ends with the run); with the option on, the first batch leaves no row (rolled back) and shows the error, the second batch shows the DDL warning before running, the ALTER commits and the first insert stays (documented behaviour), the dialog says "rolled back at the end" or "committed" accordingly; without the FK option the server's 1451 appears verbatim with its hint, with the option (off by default) the delete runs, and `@@foreign_key_checks` is 1 in the next run (the dialog names it as hard because it removes a safety); `START TRANSACTION; ...` left open by user text is rolled back and the result says so; no state reaches browse or structure on the same pool.
*Requirements:* FR-ISS-014, 126; FR-DTB-022; FR-UPD-015; FR-ISS-144; UI-ISS-123; FR-SQL-014, 015.

SCN-021 (privilege denied) of file 22 is reused for the SQL tab: a user with only SELECT runs an `INSERT`; the server's 1142 is shown verbatim with the hint, nothing is created, the history entry has outcome `error`.

## 4. Objective of the module spec in one line
The user types SQL, DBLoom classifies it and asks for a server-checked confirmation where it is destructive, sends each statement exactly as typed under the guard, and shows what the server said within fixed limits.

## 5. Design

### 5.1 Parser decision (open question Q1 of file 22, SEC-TGT-151)

**What the parser is for.** Not to decide whether SQL is valid (the server decides), but to classify: statement kind, whether an `UPDATE`/`DELETE` has a restricting `WHERE`, whether a `SELECT` has `INTO`, whether `ALTER` drops something, whether an `EXPLAIN`-able statement is single-table. It must therefore be strict and honest: a parser that accepts nonsense or mis-parses a statement as something else is worse than one that fails.

**Candidates measured on 2026-10-23** (npm metadata with `npm view`; 44 statements of MySQL 8.4 / MariaDB 10.11 syntax parsed in a scratch directory outside the repository; the corpus is in the task notes and goes into the unit tests, task 1):

| Candidate | Licence | Version, last release | Size unpacked | Dialects | Parsed of 44 | Notes |
|---|---|---|---|---|---|---|
| **`@guanmingchiu/sqlparser-ts`** (WASM build of `datafusion-sqlparser-rs`, Apache Software Foundation project) | Apache-2.0 | 0.63.0, 2026-10-16 (created 2026-01, 343 k downloads/month) | 3.7 MB (3.5 MB WASM, about 600 KB gzipped) | `mysql`, `generic`, 14 others; no `mariadb` dialect | **35** (`mysql`) | Strict (`SELECT 1 FROM (` fails with a position), fast (777 KB / 20 000 statements in 0.5 s), typed AST, no native build, Node 16+. Rejects: `SET @a := 1`, `SELECT ... INTO OUTFILE`, `LOAD DATA`, `ALTER ... INVISIBLE`, `CREATE PROCEDURE ... BEGIN ... END`, `DO`, `HANDLER`, `PREPARE`, `ANALYZE FORMAT=JSON`. Accepts `RETURNING`, `JSON_TABLE`, `LOCK TABLES`, `KILL`, `SHOW`, `FLUSH`, `PARTITION (p)`, executable comments. Risks: young npm wrapper (single maintainer, version follows upstream); WASM must be loaded by Nitro (*verify* in task 0b) |
| `node-sql-parser` | Apache-2.0 | 5.4.0, 2026-01-12 (2016, 9.1 M downloads/month) | 89 MB (all dialect builds) | `mysql`, `mariadb` and 12 others | 30 (`mysql`), 31 (`mariadb`) | Pure JS (PEG), AST oriented to query rewriting. Rejects `JSON_TABLE`, `EXPLAIN ANALYZE`, `FLUSH`, `KILL`, `SHOW FULL PROCESSLIST`, `PARTITION (p)`, `DO`; `RETURNING` only on the `mariadb` dialect; `->>` fails on `mariadb`. Heavy on disk; last release nine months ago |
| `sql-parser-cst` | **GPL-2.0-or-later** | 0.42.3, 2026-10-12 | 7 MB | `mysql`, `mariadb` | 26 / 25 | Excluded: the licence is not compatible with an Apache-2.0/MIT project that is distributed as a Docker image. Parses comments and whitespace into the tree (not needed here) |
| `@polyglot-sql/sdk` | MIT | 0.13.4, 2026-10-23 (created 2026-02) | 25 MB | `MySQL` among 35 | 37 (but see notes) | A dialect translator, not a classifier: it parsed `FLUSH PRIVILEGES` as a column alias (`FLUSH` aliased `PRIVILEGES`) and `GRANT u@h` loosely, i.e. it accepts nonsense and misparses commands; 0.x, five months old. Excluded for a security classifier |
| `dt-sql-parser` | MIT | 4.5.1, 2026-09-30 | 20 MB | `MySQL` (ANTLR, big-data focus), no MariaDB | not run | Package fails to load under plain Node ESM (`ERR_UNSUPPORTED_DIR_IMPORT` on `dist/parser`), needs a bundler workaround; error-recovery oriented to completion. Not pursued |

**Recommendation: `@guanmingchiu/sqlparser-ts`, dialect `mysql` for both products, server side only (never shipped to the browser).** Reasons: permissive licence and ASF-governed core; strictness (rejects rather than guesses); the best coverage of the corpus (35 of 44, and every miss is a statement the design handles by the lexer fallback); small and fast enough for the 2 s budget; actively released. The weakness is MariaDB-specific syntax (no dialect), covered by the fallback and by the fact that the classifier only needs a few facts per statement. Pin the exact version (the owner's rule on dependency age was waived for this build, file 21 section 13; apply DEP-TGT-126 again before release).

**Fallback plan if it fails to parse a statement (FR-SQL-006).** The parser is advisory for refinement and never required for sending:
1. The lexer (own code, section 5.2) always produces the statement's first keywords, its tokens outside of strings and comments, and flags such as `INTO`, `FOR UPDATE`, `LOCK IN SHARE MODE`, `WHERE`, `SLEEP`, `BENCHMARK`.
2. If the parser succeeds, the AST decides: kind, `WHERE` present and not constant-true, `INTO`, number of tables, DROP/ADD operations of `ALTER`.
3. If the parser fails (or the 256 KiB or 2 s budget is exceeded), the class comes from a fixed keyword table: read allow-list (`SELECT`, `WITH`, `SHOW`, `DESCRIBE`, `DESC`, `EXPLAIN` without `ANALYZE`, `USE`) with none of the dangerous flags gives class none; `INSERT`, `REPLACE`, `UPDATE` and `DELETE` that the parser rejected give hard (no `WHERE` verdict is possible); `SET` of a plain user variable or a session variable not on the transaction-mode list gives none; everything else, including unknown keywords, gives hard with reason `unparsed`.
4. The statement is always sent when the confirmation rules are met; the parser's error text is never shown to the user as a verdict about the SQL (the server's error is).
5. A kill switch, `.env` `DBLOOM_SQL_PARSER=off`, makes step 3 the only path; the guard rail then only weakens in the direction of "ask more often".
6. Replacement path: the adapter `src/server/sql/parser.ts` exposes three functions (`parseStatement(text): ParsedFacts | undefined`, `init()`, `version()`), so `node-sql-parser` (dialect `mariadb`) or a later parser replaces the package by changing one file; the corpus test (task 1) runs against any candidate and decides.

### 5.2 Statement splitter and lexer (`src/lib/sql/lexer.ts`, `splitter.ts`; package A)
Pure TypeScript, no Node imports, shared by browser and server. Token classes: whitespace, line comment (`-- `, `#`), block comment, executable comment (`/*!`, `/*M!`), single/double/backtick quoted, identifier/keyword, number, operator, delimiter. Options come from the server: `delimiter`, `noBackslashEscapes`, `ansiQuotes` (read at run start from `@@SESSION.sql_mode`, FR-UPD-007) and the product (MariaDB and MySQL differ in `/*M!` and version comments only for the server, not for splitting). `DELIMITER` is recognised only at the start of a line, case-insensitive, and the rest of the line (up to a comment) is the new delimiter, as in the mysql client. Output: `{statements: {text, start, end, firstKeyword, flags}[], errors: {code: 'unterminated-string'|'unterminated-comment', at}[]}`. A version-aware difference that matters: the `--` comment needs a following whitespace in both products; `/*!50700 ... */` is kept verbatim and the server applies the version test.

### 5.3 Classifier (`src/server/sql/classify.ts`; package A)
Output reuses the existing `StatementClass`:
```ts
type SqlKind =
  | 'select' | 'show' | 'describe' | 'explain' | 'use' | 'setSession' | 'setGlobal' | 'txControl'
  | 'insert' | 'replace' | 'update' | 'delete' | 'call' | 'lock' | 'loadData' | 'selectInto'
  | 'createObject' | 'alterObject' | 'dropObject' | 'renameObject' | 'truncate'
  | 'account' | 'admin' | 'kill' | 'prepare' | 'unknown'
type Classification = {
  kind: SqlKind; class: StatementClass; readOnlySafe: boolean; commitsImplicitly: boolean
  reasons: string[]            // closed codes: 'no-where', 'constant-where', 'drop', 'truncate', 'unparsed', ...
  tables?: { db?: string; table: string }[]   // facts for estimate and structure.changed, never used to build SQL
}
```
| Class | Statements |
|---|---|
| none | `SELECT` without `INTO`/locking clause, `SHOW`, `DESCRIBE`, plain `EXPLAIN`, `USE`, `SET` of user variables and harmless session variables, `START TRANSACTION`, `COMMIT`, `ROLLBACK`, `INSERT`, `UPDATE`/`DELETE` with a restricting `WHERE` (not constant-true: literal, `1=1`, `x=x`), `CREATE` of a new object |
| soft | `ALTER` without drops, `RENAME`, `CALL` (effect unknown), `KILL`, `LOCK TABLES`, `REPLACE`, `CREATE OR REPLACE`, `ANALYZE/OPTIMIZE/REPAIR/CHECK TABLE`, `FLUSH` of tables or logs, `PREPARE/EXECUTE` |
| hard | `DROP` anything, `TRUNCATE`, `UPDATE`/`DELETE` without a restricting `WHERE` (also `... LIMIT` only), `ALTER` with `DROP`, change to a narrower type or `NOT NULL` (as FR-STR-005), `GRANT`, `REVOKE`, `CREATE/ALTER/DROP USER/ROLE`, `SET PASSWORD`, `SET GLOBAL/PERSIST`, `LOAD DATA`, `SELECT ... INTO OUTFILE/DUMPFILE`, `INSTALL/UNINSTALL`, `SHUTDOWN`, `RESET`, `CHANGE MASTER`, the FK-checks option, and everything `unparsed` outside the read allow-list |
`readOnlySafe` is true only for none-class reads (select without `INTO`, show, describe, explain, use, user-variable `SET`, transaction control without `READ WRITE`). A batch's class is the maximum of its statements; the class of `kind` is fixed in code and `.env` may raise but never lower the hard list (ST-120).

### 5.4 Runner (`src/server/sql/run.ts`; package B)
```
runSql(input) -> zod -> limits = resolveSqlLimits() -> split+classify (A) -> per statement: guard (read-only)
  -> highest class: none -> run | soft -> confirm (plan) | hard -> confirm (plan + token)
  -> getConnection -> setup (5.5) -> for each statement: start watchdog -> stream rows with caps -> map errors
  -> warnings -> audit -> finish (destroy connection) -> history -> structure.changed -> response
```
Streaming uses the mysql2 event API on the underlying connection (`connection.connection.query(sql)` and its `fields`, `result`, `end` events, or `.stream()`) so that rows are consumed one at a time; the promise wrapper buffers and is used only for setup statements and for small ones (`SHOW WARNINGS`). The existing `runWithTimeout` is buffered, so package B adds a sibling `startWatchdog(pool, connection, timeoutMs)` to `statement-timeout.ts` (the kill logic extracted without changing `runWithTimeout`'s behaviour, `guard.test.ts` and `statement-timeout.integration.test.ts` stay green) and uses it for the streaming run. Multi-result streaming of `CALL` and the exact event order of mysql2 for several result sets are *verify* (task 0b); if the stream API cannot deliver several sets, `CALL` falls back to the buffered path with the byte cap enforced by `max_allowed_packet` and a row count check after the fact (documented weaker case).

### 5.5 Connection, `USE`, session state
One connection per run (FR-SQL-014), destroyed at the end. This costs a connect per run (a few ms to tens of ms on a LAN) and removes every leak path (session variables, `LOCK TABLES`, open transaction, temporary tables, `USE`) that would otherwise contaminate the shared pool the browse and structure modules use with qualified names. `USE` is allowed in user text; the tab shows the database from the run result (`SELECT DATABASE()` after the run, only if the text contained a `USE`). A **pinned session per tab** (needed for FR-ISS-101 and for the user who expects `SET` to persist between runs) would hold one connection per tab with an idle timeout of 5 minutes and a limit of 2 per session; it is DEFER with this design because it shrinks the 4-connection pool (Q3), and the data lost on a dropped connection is G5's problem (DBLoom tells the user that session variables were lost).

### 5.6 Cancel and registry
`RunRegistry` (in memory, per process): `runId -> {sessionId, tabId, threadId, state, cancelRequested}`, removed at the end of the run and swept after 15 minutes. `cancelSql` sets `cancelRequested`, gets a connection from the pool (always one free, FR-SQL-029) and sends `KILL QUERY <threadId>` where `threadId` is the integer reported by the driver (not client input). The runner checks `cancelRequested` before each statement.

### 5.7 Server functions (`src/server/sql.functions.ts`; package C) — all zod-validated, CSRF and `sessionMiddleware` as the skeleton
`runSql({runId, tabId, db, text, range?, options})`, `confirmSql({runId, planId, confirmToken?})`, `cancelSql({runId})`, `explainSql({db, text, mode, format, planId?, confirmToken?})`, `estimateAffected({db, text})`, `listHistory({cursor, limit, source?, query?})`, `deleteHistory({ids}|{all})`, `saveBookmark`, `listBookmarks`, `renameBookmark`, `deleteBookmark`, `getCompletionSchema({db, table?})`, `getSqlLimits()`. Plans reuse `PlanStore` (additive field `payload` for the text, range, options, database; task 0). Errors reach the client as `code: message` via `toClientError`, as in file 22.

### 5.8 Data model in the SQLite store
The current `sqlite-store.ts` runs `CREATE TABLE IF NOT EXISTS` and has no versions. Package C adds a migration runner:
```ts
const MIGRATIONS: ((db: DatabaseSync) => void)[] = [
  /* 1 */ (db) => db.exec(SESSIONS_SCHEMA),          // the existing schema, unchanged
  /* 2 */ (db) => db.exec(SQL_STATE_SCHEMA),
]
// open: v = PRAGMA user_version; if v > MIGRATIONS.length -> refuse to start;
// BEGIN; for i in v..N-1: MIGRATIONS[i](db); PRAGMA user_version = N; COMMIT
```
```sql
CREATE TABLE sql_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_key   TEXT NOT NULL,      -- direct mode: normaliseTarget(host, port, username); account mode: DBLoom user id
  target_key  TEXT NOT NULL,      -- always the normalised target of the entry (DATA-TGT-094)
  created_at  INTEGER NOT NULL,   -- ms
  source      TEXT NOT NULL CHECK (source IN ('user','generated','assistant')),
  db          TEXT,
  sql         TEXT,               -- redacted; NULL when over the entry limit
  sql_omitted INTEGER NOT NULL DEFAULT 0,
  statements  INTEGER NOT NULL, executed INTEGER NOT NULL, failed_index INTEGER,
  max_class   TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX sql_history_owner ON sql_history(owner_key, id DESC);
CREATE TABLE sql_bookmarks (
  id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, target_key TEXT NOT NULL,
  name TEXT NOT NULL, sql TEXT NOT NULL, db TEXT,
  shared INTEGER NOT NULL DEFAULT 0,      -- reserved (FR-UPD-017), always 0 now
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (owner_key, target_key, name)
) STRICT;
```
In direct mode `owner_key = target_key` (the key already contains the username, DATA-TGT-095); in account mode `owner_key` is the DBLoom user and `target_key` is the target recorded on the entry, and the list can be filtered by server. Every statement filters by `owner_key`; there is no function that reads without it (SCN-030 test). The store interface gets a separate `SqlStateStore` (list, add, delete, prune, export) implemented by SQLite and by `MemorySqlState` (stateless, per session, bounded); the `Store` of sessions is not changed. Retention (`pruneHistory(owner_key, maxEntries, maxAgeMs)`) runs after each insert and once at start-up for all owners. Values are written through prepared statements; no SQL text is placed in a log.

### 5.9 Explain
Fixed prefix table in `src/server/sql/fixed.ts`, one entry per `(product, mode, format)` selected by the capability strategy; the statement text is appended after the prefix and a space, after the classifier confirmed a single explainable statement (select, insert, update, delete, replace; MySQL also `TABLE`). The tree is built from the JSON output (`query_block`, `nested_loop`, `table`, `access_type`, `rows_examined_per_scan`, `cost_info`, plus `r_*` actual fields on MariaDB analyse) by a pure function in `src/lib/sql/plan-tree.ts`; MySQL's `EXPLAIN ANALYZE` text (indented lines starting with `->`) is parsed into a tree by indentation and also shown raw. Unknown shapes show the raw text only.

### 5.10 Redaction (`src/lib/sql/redact.ts`)
Token-based, applied to history, bookmarks and any log field; fixed in code (ST-128). It operates on the lexer's tokens, so a literal inside a comment or a longer string is handled. Failure of the redactor stores the entry without text.

### 5.11 UI (package D): framed-sheet style of the app, tabs, shortcuts
- The SQL tab is a centre-tab kind `sql` next to `table` and `designer` in `app-shell.tsx`; opened from the sidebar ("SQL" entry of a database or of the server) and by the "new SQL tab" button; several SQL tabs may be open; the tab header shows the database; a dot marks unsaved text.
- Layout: top = editor (auto-height 4 to 10 lines, resizable splitter), toolbar (Run, Run selection hint, Explain, Analyse, Cancel while running, Format, Single line, options popover: continue on error, run in one transaction, disable foreign key checks for this run, soft confirmations), status line (database, read-only badge, timeout, "Press Ctrl+Enter to run"). Bottom = result area with one panel per statement (tabs when more than one): grid reusing the cell renderer of `components/grid/table-view.tsx` (extracted to `components/grid/cell-view.tsx`; the grid itself is virtualised with `@tanstack/react-virtual`, which the table view does not yet need), query strip with copy and "edit", warnings, truncation notice, error panel (code and message prominent, statement scrollable and truncated, copy, error position marked in the editor). A right-hand drawer holds History and Bookmarks (opened on demand; not fetched before).
- Shortcuts (ST-163: only modifier combinations by default, so WCAG 2.1.4 is met; any character-key shortcut would be switchable): `Ctrl/Cmd+Enter` run selection or all; `Ctrl/Cmd+Shift+Enter` run the statement at the cursor; `Esc` in the running state asks to cancel; `Ctrl/Cmd+Space` completion; `Ctrl/Cmd+/` toggle comment; `Ctrl/Cmd+Shift+F` format; `Ctrl/Cmd+Shift+E` explain; `Ctrl/Cmd+S` save as bookmark (prevents the browser's save dialog only in the editor). Option "Enter executes" (FR-UIX-049) swaps Enter and Shift+Enter.
- Editor choice: **CodeMirror 6** (`@codemirror/state`, `view`, `commands`, `language`, `autocomplete`, `lint`, `lang-sql`; all MIT; used directly in a small React wrapper hook, not through a wrapper package), checked 2026-10-23: lang-sql 6.10.0 offers `MySQL` and `MariaSQL`. Monaco was considered and rejected (about 100 MB unpacked, workers and CSP complications, heavy for a tab that opens often). Autocomplete data comes from the lazy server function; `lang-sql` completion is replaced by a custom source for subsequence matching.
- Texts through `t('sql.*')`; Light and dark themes via the shell tokens; the grid and the editor are keyboard-operable with visible focus; reduced motion respected.

### 5.12 Deferred designs, kept short
- **Parameters and bookmark variables (FR-DTB-026, FR-ISS-134, 145):** values are bound by the server through a prepared statement (`execute`), never substituted into text; classification runs on the text with placeholders; only one statement per prepared run, kinds that the prepared protocol supports.
- **Several databases (FR-ISS-106):** a loop over the same runner with one `USE` per database; result per database.
- **Pinned session (FR-ISS-101):** section 5.5.

### 5.13 Audit and error mapping
Audit uses `audit()` of `audit.ts` with two new event helpers in the same style as `auditStructure` (package B). `mapMysqlError` is used unchanged; `errors.ts` receives additive hint entries and a helper `positionOf(sqlMessage, statementStart, text)`. Connection errors keep the uniform message of the skeleton.

### 5.14 Minimum privileges (SEC-TGT-053 input)
The SQL tab needs no privilege of its own: what a statement needs is what the server demands (SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ...). DBLoom additionally uses: `PROCESS` is not needed for cancel (a user may kill own threads); `SHOW DATABASES` (visible databases) and `SELECT` on `information_schema` for completion; `EXPLAIN` needs the privileges of the explained statement; MariaDB `ANALYZE` of a data-changing statement needs the privileges to run it. Nothing is written to the target for history or bookmarks.

## 6. Tech stack
As file 21 section 3 and file 22 section 6. Additions needing a go: `@guanmingchiu/sqlparser-ts` (server only, section 5.1), CodeMirror 6 packages (`@codemirror/state`, `view`, `commands`, `language`, `autocomplete`, `lint`, `lang-sql`), `@tanstack/react-virtual` (result grid), `sql-formatter` 15.9.0 (MIT, lazy-loaded in the browser for the Format action; Q6). No other dependency.

## 7. Commands
As file 21 section 4 and file 22 section 7, plus:
```
Unit (lexer, splitter, classifier, redact, plan tree):  npx vitest run tests/sql-*.test.ts
Store (migrations, history, bookmarks):                  npx vitest run tests/sql-store.test.ts
Integration:   docker compose -f compose.test.yaml up -d && npx vitest run tests/sql.integration.test.ts
E2E:           npx playwright test e2e/sql-*.spec.ts
Parser corpus: npx vitest run tests/sql-parser-corpus.test.ts
```

## 8. Project structure (new and touched files)
```
src/lib/sql/lexer.ts, splitter.ts, redact.ts, plan-tree.ts   pure code shared by browser and server       (package A)
src/server/sql/types.ts            Classification, SqlRunInput/Result, limits, RunResult types           (contracts, task 0)
src/server/sql/parser.ts           adapter around the parser package (init, parseStatement, version)      (A)
src/server/sql/classify.ts         classifier, read-only rules, DDL/implicit-commit table               (A)
src/server/sql/fixed.ts            the only file with fixed SQL fragments (EXPLAIN prefixes, USE, SET, KILL) (B)
src/server/sql/limits.ts           resolveSqlLimits                                                       (B)
src/server/sql/run.ts              runner: connection setup, streaming, caps, per-statement results       (B)
src/server/sql/registry.ts         RunRegistry, cancel                                                    (B)
src/server/sql/explain.ts, estimate.ts   explain/analyse and affected-rows estimate                       (B)
src/server/sql/export-source.ts, assistant.ts   hooks FR-SQL-026, 027                                      (B)
src/server/sql/state.ts            SqlStateStore interface, MemorySqlState                                (C)
src/server/store/sqlite-store.ts   migration runner, migration 2, SqlStateStore implementation            (C; only package C edits it)
src/server/sql.functions.ts        server functions of section 5.7                                        (C)
src/server/guard/statement-timeout.ts   additive: startWatchdog                                           (B)
src/server/structure/types.ts      additive: StatementKind 'userSql'; plans.ts: StoredPlan.payload       (coordinator, task 0)
src/server/structure/errors.ts     additive hints, positionOf                                            (B)
src/server/audit.ts                additive: auditSqlRun, auditSqlStatement                              (B)
src/components/sql/*.tsx           sql-tab, editor (CodeMirror hook), result-panels, history-drawer, bookmarks, confirm-dialog (reuses structure/class-badge), explain-view, options  (D)
src/components/grid/cell-view.tsx  extracted from table-view.tsx; table-view imports it                   (D)
src/components/shell/app-shell.tsx, sidebar-tree.tsx   tab kind 'sql', menu entries                       (D only)
src/i18n/en.json                   keys with prefix `sql.`                                                (D only)
tests/sql-*.test.ts, tests/sql.integration.test.ts, e2e/sql-*.spec.ts, e2e/fixtures/sql-fixtures.ts       (A..E)
```

## 9. Code style
As file 21 section 6. Handlers stay thin; the pipeline is plain functions:
```ts
export const runSqlFn = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator(runSqlInput)                       // zod: text, range, options; no statements or class fields exist
  .handler(({ context, data }) => runSql(sqlEnv(context), data))   // splits, classifies, guards, plans or runs
```
No SQL string is built outside `src/server/sql/fixed.ts`; user text is only sliced, never concatenated with anything. The lint rule of SEC-TGT-117 is widened to `src/server/sql/`.

## 10. Testing strategy
- Unit: lexer and splitter tables (quotes, escapes, `NO_BACKSLASH_ESCAPES`, `--` rule, `#`, executable comments, `DELIMITER`, unterminated); fuzz round trip; classifier table of at least 150 statements for both products with expected kind, class and `readOnlySafe`, including constant-true `WHERE`, `INTO`, `ALTER ... DROP`, `SET` variants, every read-only bypass; parser corpus (the 44 of section 5.1 plus more) asserting the fallback path never relaxes a class; redaction table; error position conversion; plan tree from fixtures of both products; limits resolver; budget test.
- Store: migrations from empty and from version 1; owner isolation (key A cannot read key B); retention by entries and age; entry limit; memory store bounds.
- Integration (MySQL 8.4 on 33064, MariaDB 10.11 on 33061): every SCN with a server effect; streaming memory bound; `KILL QUERY` on cap and cancel; `max_execution_time` / `max_statement_time` observed order; read-only transaction error 1792 on a writing function; multi-result `CALL`; `SELECT ... INTO` classification; `EXPLAIN` / `ANALYZE` syntax per product (fills the *verify* cells).
- E2E (Playwright): SCN-024 to SCN-036, one product by default, both in CI; browser-storage scan; unsaved-text guard; shortcuts.
- Security checks: forged POST without CSRF rejected; request with `statements`, `class` or `confirmToken` of another plan rejected; token replay; `multipleStatements` stays false; no literal, token or password in logs; hostile cell values and error messages escaped.
- CI as in file 21 section 8.

## 11. Boundaries
- **Always:** test first for lexer, splitter, classifier and redaction; send the exact text; classify again on the server; one `query` per statement; destroy the run's connection; verify the selected database against the server; use `quoteIdent`; text only through `t()`; run lint, typecheck and tests before reporting done.
- **Ask first:** adding a dependency (parser, CodeMirror, virtual, formatter), changing the `Store`/session shape beyond the migration runner, changing the audit line format, changing `StatementKind`, `StoredPlan` or `statement-timeout.ts` (task 0 lists the four allowed additive edits), adding a class to the hard list, a pinned session, any commit or push.
- **Never:** rewrite user SQL (no `LIMIT`, no appended text), enable `multipleStatements`, accept statements, classes or tokens from the client, let a parser failure block a read-write statement or relax a class, return a used connection to the pool, write SQL text or drafts to browser storage or to the target, log literals, run a data-changing analyse without the token, call `mysql2` from components.

## 12. Success criteria
1. SCN-024 to SCN-036 pass on MySQL 8.4 and MariaDB 10.11.
2. Every statement runs as typed; a hard statement never runs without a valid, single-use, plan-bound token; a tampered or reused token never runs one.
3. Read-only refuses everything outside the safe reads without opening a connection, and the server-side read-only transaction stops writes by functions.
4. A statement over the time limit or cancelled is killed on the server; a result over the cap is cut with the notice and the server thread is gone; server memory stays flat on a very large result.
5. History and bookmarks are isolated per target (and per owner), survive a restart in stateful mode, exist only for the session in stateless mode, contain no credentials, and no SQL text is ever in browser storage.
6. A valid statement that the parser rejects is never blocked; it asks for confirmation unless it is a plain read.
7. The *verify* cells (mysql2 multi-result streaming, `max_*` timeout variables, read-only transaction error, EXPLAIN/ANALYZE syntax per product, `RETURNING` highlight, WASM loading in the Nitro build, documentation URLs) are filled from the integration run and this file is updated.
8. Lint, typecheck, unit, integration and e2e green in CI on Node 24.7 and 24 (minimum raised by SPEC/26 Q1).

## 13. Task breakdown and work packages

Packages A to E run in parallel (as separate subagents) after task 0 and the spike 0b, because each package owns its files and talks to the others only through `src/server/sql/types.ts` (frozen by task 0; changes need the coordinating agent). Shared files: `src/server/audit.ts`, `statement-timeout.ts` and `structure/errors.ts` belong to package B; `sqlite-store.ts` to package C; `en.json` (prefix `sql.`), the shell files and `grid/` to package D.

| Task | Package | Files (owner) | Acceptance | Verify |
|---|---|---|---|---|
| 0 Contracts | coordinator | `sql/types.ts`; additive: `StatementKind` gets `'userSql'`, `StoredPlan.payload?: unknown`; function input/output types; limits type; zod input schemas | Types compile; `FR-SQL` ids in comments; the four additive edits leave all structure tests green | `npm run typecheck`, `npx vitest run` |
| 0b Spike | coordinator (needs go for the dependencies) | scratch only | (1) `@guanmingchiu/sqlparser-ts` loads in the Nitro production build and in `npm run dev` (WASM file, Vite `optimizeDeps.exclude`), Node 22.13 and 24; (2) mysql2 streaming of several result sets; (3) `SET SESSION TRANSACTION READ ONLY` behaviour on both servers; (4) `max_execution_time` / `max_statement_time` | Short report, section 5 updated; if (1) fails, switch to the fallback `node-sql-parser` through the adapter |
| 1 Lexer, splitter, redact | A | `lib/sql/lexer.ts`, `splitter.ts`, `redact.ts`, tests | Section 5.2 behaviour; fuzz round trip; 1 MiB under 1 s | `npx vitest run tests/sql-lexer.test.ts tests/sql-redact.test.ts` |
| 2 Parser adapter, classifier | A | `sql/parser.ts`, `sql/classify.ts`, `tests/sql-classify.test.ts`, `tests/sql-parser-corpus.test.ts` | Classification table; fallback path; read-only rules; budget; kill switch | Unit tests incl. corpus; any bypass test red = not done |
| 3 Runner core | B | `sql/run.ts`, `sql/limits.ts`, `sql/fixed.ts`, `guard/statement-timeout.ts` (startWatchdog), `audit.ts` additions | Setup order of FR-SQL-014, streaming with caps, per-statement results, warnings, timeout, destroy connection | Integration on both servers |
| 4 Cancel, registry, concurrency | B | `sql/registry.ts`, `run.ts` | FR-SQL-013, 029; kill on cap | SCN-033 and SCN-029 integration parts |
| 5 Explain, estimate, hooks | B | `sql/explain.ts`, `estimate.ts`, `export-source.ts`, `assistant.ts`, `lib/sql/plan-tree.ts` (shared with D) | FR-SQL-021, 022, 026, 027 | Integration; hook tests with doubles |
| 6 Store and migrations | C | `store/sqlite-store.ts`, `sql/state.ts`, `tests/sql-store.test.ts` | FR-SQL-020; history and bookmarks tables; memory store; retention; owner isolation | Store tests incl. version-1 file |
| 7 Server functions | C | `sql.functions.ts`, `tests/sql.integration.test.ts` | Section 5.7 functions; plan and token flow through `PlanStore` and `TokenIssuer`; history write after run; `structure.changed`; `sql_disabled` | Integration both servers; forged and replay cases |
| 8 Editor and completion | D | `components/sql/editor.tsx`, completion source, format/single line, `en.json` prefix | FR-SQL-023; dialect by product; lazy schema; shortcuts | Component tests; 5 000-table schema test |
| 9 Tab, results, dialogs | D | `components/sql/sql-tab.tsx`, `result-panels.tsx`, `confirm-dialog.tsx`, `explain-view.tsx`, `grid/cell-view.tsx`, shell files | Framed-sheet layout, panels, truncation notice, error panel with position, dirty guard, read-only state | Playwright smoke of SCN-024 |
| 10 History and bookmarks UI | D | `components/sql/history-drawer.tsx`, `bookmarks.tsx` | Lazy fetch, paging, re-run, edit, bookmark, delete, "session only" notice | Playwright SCN-030 UI part |
| 11 Verify fill-in | B (after 3, 5, 7) | this file section 5 / success criterion 7 | *verify* cells replaced by observed results | Test report; spec updated by the coordinator |
| 12 E2E | E | `e2e/sql-run.spec.ts`, `sql-guard.spec.ts`, `sql-history.spec.ts`, `sql-explain-cancel.spec.ts`, `e2e/fixtures/sql-fixtures.ts` | SCN-024 to SCN-036 assertions; two-target fixture; large-table fixtures; browser-storage scan | All specs green on both products |

Order and parallelism: 0 first and alone; 0b next (it decides the parser and the streaming API); then A (1, 2), B (3, 4, 5), C (6; 7 after A and B publish their interfaces, using the frozen types), D (8, 9, 10 against mocked server functions) in parallel; 11 and 12 last. Conflicts: none by file ownership; `en.json` merges by key prefix `sql.`; the only edits to code owned by file 22 are the four additive ones of task 0 and `statement-timeout.ts`, `errors.ts`, `audit.ts` additions by B, announced to the structure owner.

## 14. Open questions for the owner (max 8, each with a recommended default)

| # | Question | Recommended default |
|---|---|---|
| Q1 | Parser for classification (also answers Q1 of file 22 and SEC-TGT-151). | `@guanmingchiu/sqlparser-ts`, server side, dialect `mysql`, with the lexer fallback and the kill switch of section 5.1; spike 0b before building on it; `node-sql-parser` as replacement. Not `sql-parser-cst` (GPL). |
| Q2 | Which statements are hard (token) and which soft? In particular `UPDATE`/`DELETE` with a `WHERE` that is not constant-true: no confirmation; `REPLACE`, `CALL`, `LOCK TABLES`: soft. | As the table in section 5.3; the `.env` list may add classes (ST-120); `DELETE`/`UPDATE` with a real `WHERE` run without a dialog. |
| Q3 | Connection per run (clean, no leak) or a pinned session per tab (SET persists, but takes pool slots)? | Per run in slice 1; pinned session as an opt-in later, 1 per tab, 2 per session, idle 5 minutes. |
| Q4 | Delimiter: `DELIMITER` command in the text (as the mysql client) or also an input field (legacy)? | Text command only; fewer controls, same behaviour as the tools users know. |
| Q5 | Should browse-edit and other modules record their generated statements in the history (FR-ISS-118)? | The store supports `source = generated` but only the SQL tab records (source `user`); generated entries are a later switch with the default hidden filter, to avoid history growth and literals from table edits. |
| Q6 | New dependencies: `@guanmingchiu/sqlparser-ts`, CodeMirror 6 packages, `@tanstack/react-virtual`, `sql-formatter`. | Approve the first three for the first slice; `sql-formatter` optional (lazy-loaded; drop the Format button if refused, keep Single line). |
| Q7 | Default limits: row cap 10 000 per set, response 16 MiB, cell 64 KiB, timeout 60 s, history 100 entries / 30 days / 64 KiB, 500 statements per run, 2 concurrent runs per session. | Take the defaults of file 12 (ST-110, 114, 115, 161) and the two new numbers (500, 2) as proposed; they are `.env` bounded. |
| Q8 | Unsaved editor text: page memory only (survives tab switch, lost on reload), or a server-side draft in the store in stateful mode (survives reload, text stays on the server, never in the browser)? | Page memory only in slice 1 (SCN-007, G3); a server-side draft per tab can be added in stateful mode later as a separate decision, since drafts hold literals. |
