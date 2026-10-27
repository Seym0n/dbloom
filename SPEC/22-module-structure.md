# 22 — Module spec: `structure` (create, alter and drop databases and tables)

**Status: DRAFT for owner review (2026-10-23), not approved.** Written with the spec-driven-development skill, in the format of `21-spec-walking-skeleton.md`. It is the "structure changes" module that `19-scenarios.md` section 2 lists as not yet covered. It belongs to the capability map of file 21 section 0 as a new module `structure` (depends on `skeleton`; shares the write guard with `sql-tab`). Requirements marked PROPOSED are new (`FR-STR-nnn`, type FR, subsystem STR; the subsystem code STR is to be added to the README table when this file is accepted). Vendor facts that this draft could not check are marked *verify*; they are tested by the integration suite (section 12, package C) before anything is built on them. Nothing in this file reopens a decision of `OPEN.md`, `11-target-security.md` or `12-settings.md`.

## 0. Assumptions (correct me now)
1. Direct mode, one target per session, as in the skeleton. Names are always fully qualified (`` `db`.`tbl` ``); the module never issues `USE`, so the pooled connections of `target-pool.ts` stay interchangeable.
2. First slice = create, alter and drop of tables (columns, keys, foreign keys, CHECK, options), create and drop of databases, table rename, truncate, with a SQL preview. Deferred (section 2): database rename and copy, table copy and move, partitions, views, maintenance, tracking, and the visual designer.
3. The write guard (read-only mode, destructive confirmation token, statement timeout) does not exist yet in `src/` (grep on 2026-10-23 found no guard code). This module builds it in `src/server/guard/` as a shared piece that `sql-tab` and `browse-edit` reuse; it does not live inside `src/server/structure/`.
4. The read-only structure view (columns, indexes, constraints of a table) belongs to `browse-edit` (file 21 section 0). This module adds the editing screens and actions that start from it (open question Q6).
5. No commit and no dependency beyond file 21 section 3 without a go (one possible exception: the SQL parser in Q1).

## 1. Objective
A permitted user can build and change the structure of a MySQL 8.4 or MariaDB 10.11 target from the browser: create a database, create a table from a column and key designer, add, change, rename and drop columns, create and drop indexes, foreign keys and CHECK constraints, change engine, character set, collation and comment, rename, truncate and drop a table. Before anything runs, DBLoom shows the exact SQL it will send. Destructive steps need a server-checked confirmation, a read-only connection blocks everything, every statement is audited, and the server's own error message is shown when a statement fails. The generated SQL comes from one typed model and one central builder, never from strings assembled in handlers or components.

## 2. Requirements and dispositions

Legend. **Disp**: the triage disposition of `18-scope-triage.md` (KEEP, ADAPT, DROP, DEFER, SUPERSEDED), or PROPOSED for rows of files 11 and 13 (no triage). **Where**: IN = built in this module's first slice; DEFER = belongs here but later (reason given); OTHER = belongs to the named module; DROP = not carried over.

### 2.1 Legacy requirements (file 03, triage in 18, wording in 20 where the row is ADAPT)

| ID | Disp | DBLoom wording (one line) | Where |
|---|---|---|---|
| FR-DTB-040 | KEEP | Generate and run CREATE TABLE from columns, keys and options (partitions excluded in slice 1). | IN (partitions DEFER: no UI design, rare) |
| FR-DTB-041 | ADAPT | Validate table names (empty, trailing space, over 64 characters, unquoted charset) before sending. | IN |
| FR-DTB-042 | ADAPT | Rename a table or view with one RENAME TABLE; cross-database move drops and restores triggers. | IN for same-database rename; cross-database move DEFER (needs trigger handling, see FR-DTB-104) |
| FR-DTB-043 | KEEP | Native RENAME TABLE first, copy fallback only on failure. | IN (native only; fallback DEFER with copy) |
| FR-DTB-044 | ADAPT | Table copy in ordered steps (structure, constraints, indexes, AUTO_INCREMENT). | DEFER (copy is a follow-up; builder is reusable) |
| FR-DTB-045 | KEEP | Copy data with NO_AUTO_VALUE_ON_ZERO, non-generated columns only. | DEFER (with copy) |
| FR-DTB-046 | ADAPT | Copy column transformations with a copied table; remove them when column or table is dropped. | OTHER: column transformations feature, DBLoom store; this module only emits a hook event (FR-STR-014) |
| FR-DTB-047 | ADAPT | DROP VIEW versus DROP TABLE by object type; no config-storage cleanup. | IN (tables); views with FR-DTB-071 |
| FR-DTB-048 | KEEP | Truncate selected tables, skip views, with confirmation. | IN |
| FR-DTB-049 | KEEP | Optionally disable FOREIGN_KEY_CHECKS for drop and truncate, restore the previous value. | IN, as an explicit option (section 5.6) |
| FR-DTB-060 | KEEP | Add one or more columns with ALTER TABLE ADD. | IN |
| FR-DTB-061 | ADAPT | Change engine, collation, row format, AUTO_INCREMENT and comment; engine-specific options only where supported. | IN for engine, charset, collation, comment, AUTO_INCREMENT; engine-specific options DEFER |
| FR-DTB-062 | ADAPT | Column list and metadata for forms from the server catalog (unique, indexed). | IN (introspection, section 5.1) |
| FR-DTB-063 | KEEP | Create, edit and drop indexes; PRIMARY naming rule; edit drops the old index in the same ALTER. | IN |
| FR-DTB-064 | KEEP | Report duplicate indexes as notices. | IN (notice in the designer; the list itself is `browse-edit`) |
| FR-DTB-065 | KEEP | Native InnoDB foreign keys: add, change, drop; RESTRICT default. | IN |
| FR-DTB-066 | DEFER | Internal (virtual) relations in config storage. | DEFER (owner decision: designer feature) |
| FR-DTB-070 | KEEP | Create and alter views with algorithm, definer, security, check option. | DEFER (not in the task; same pipeline, add later) |
| FR-DTB-071 | KEEP | Drop and alter views. | DEFER (with FR-DTB-070) |
| FR-DTB-100 | ADAPT | CHECK, ANALYZE, CHECKSUM, OPTIMIZE, REPAIR for selected tables. | DEFER (maintenance, not structure; same guard) |
| FR-DTB-101 | DEFER | Integrity check of internal relations. | DEFER (designer decision) |
| FR-DTB-102 | ADAPT | Offer only the ROW_FORMAT values the engine supports. | IN (list in the capability table) |
| FR-DTB-103 | ADAPT | Change AUTO_INCREMENT and create options by ALTER; engine-specific options gated. | IN (AUTO_INCREMENT); rest DEFER |
| FR-DTB-104 | KEEP | Move, rename or copy a table, also across databases. | DEFER (cross-database and copy) |
| FR-DTB-105 | KEEP | Batch prefix add or replace through renames. | DEFER (batch rename, builds on single rename) |
| FR-DTB-138 | KEEP | Preview generated SQL without executing. | IN (core of the module; FR-STR-003) |
| FR-DTB-154 | KEEP | Create-table guards: database exists, table does not exist, column count cap 4096. | IN |
| DATA-DTB-001 | KEEP | Index type model (primary, unique, index, spatial, fulltext) loaded from information_schema. | IN (spatial type DEFER: GIS columns are not in slice 1) |
| DATA-DTB-002 | DROP | Central columns dictionary. | DROP |
| DEP-DTB-001 | ADAPT | Branch by server family: generated-column keywords, compressed columns MariaDB only. | IN (as capability strategies, ARCH-TGT-002) |
| SEC-DTB-002 | ADAPT | Guard DROP DATABASE by permission and mandatory confirmation, no client-supplied confirm field. | IN (FR-STR-005 hard class; who is permitted is Q3) |
| FR-DTB-030 | KEEP | Database rename and copy (routines, views, events, triggers, FK handling). | DEFER (MySQL and MariaDB have no RENAME DATABASE; it is create, move, drop, non-atomic; Q5) |
| FR-DTB-031 | KEEP | Reject empty or identical target names; lowercase when `lower_case_table_names=1`. | IN for table rename and database create (lowercase rule); identical-name check with FR-DTB-030 |
| FR-DTB-032, 033 | ADAPT | Switch to the new database after copy; optional privilege adjustment. | DEFER (with database copy) |
| FR-DTB-034 | DROP | Database comment in config storage (MySQL has no native database comment). | DROP |
| FR-SRV-031 | ADAPT | Drop selected databases after confirmation, never system schemas; who may is open. | IN (single and multi-select; FR-STR-010) |
| FR-SRV-032 | ADAPT | Create a database with a name and optional collation; unknown charset or collation is an error. | IN |
| NFR-SRV-002 | ADAPT | After create: success message with database name and the SQL that ran, link to the database; on failure the server's message and no navigation. | IN |
| FR-DTB-023 | ADAPT | Show the server error with the failing SQL. | IN (FR-STR-013); the multi-statement continue-on-error part is OTHER: sql-tab |
| NFR-DTB-002 | KEEP | Show the true query and the true server error. | IN (FR-STR-013) |
| FR-DTB-021, 022 | ADAPT | Multi-statement run with delimiter; optional transaction wrapper with rollback. | OTHER: sql-tab (DDL cannot be rolled back anyway, section 5.7) |
| FR-DTB-110..114, CPT-DTB-002, FR-DTB-150, 151, DATA-DTB-004 | DEFER | Tracking of structure changes. | DEFER (whole feature deferred by the owner) |
| FR-DTB-120..124, DATA-DTB-005 | DEFER | Visual designer, relation diagrams. | DEFER (designer) |
| FR-SRV-042 | ADAPT | Delete users and optionally the same-named database. | OTHER: admin (calls this module's drop-database function) |

### 2.2 Target requirements (files 11, 12, 13)

| ID | Disp | What it means for this module | Where |
|---|---|---|---|
| SEC-TGT-023 | in force | Audit records and error texts carry no credentials or tokens. | IN |
| SEC-TGT-050 | in force | The target's privileges are the boundary; the guard is a guard rail. | IN (documented, tested) |
| SEC-TGT-051 | in force | One central quoting function; validated enums for everything that is not an identifier. | IN (package A) |
| SEC-TGT-052 | in force | Read-only at three levels; server-side two-step token for destructive statements; block multi-statement and read-write switches. | IN (package B); the settings UI for the levels is OTHER: admin |
| SEC-TGT-053 | in force | Document the minimum privileges per feature (CREATE, ALTER, DROP, INDEX, REFERENCES, CREATE VIEW). | IN (docs table, section 5.9) |
| SEC-TGT-112 | in force | Names, comments and error messages from the server are untrusted; escaped on output. | IN |
| SEC-TGT-114 | in force | State the server can hold stays server-side: the plan lives in the session, the client carries an opaque id. | IN |
| SEC-TGT-115 | in force | Every function declares a zod schema; invalid input is rejected, not corrected. | IN |
| SEC-TGT-116 | in force | Database, table, column, index and constraint names for existing objects must exist on the server before use. | IN (new names are validated by rule instead, FR-DTB-041) |
| SEC-TGT-117 | in force | No string-built SQL outside the central builder; a lint rule enforces it. | IN (lint rule scope extended to `src/server/structure/`) |
| SEC-TGT-118 | in force | Client-carried state is MAC-signed and bound to session, purpose and expiry. | IN (confirmation token) |
| SEC-TGT-151 | DECIDED | Only a parser-recognised single expression is accepted where raw SQL is unavoidable. Applied here to generated-column, CHECK and default expressions. | IN (FR-STR-011, Q1) |
| NFR-TGT-090 | in force | Audit log of destructive statements, no secrets or result data. | IN (FR-STR-008) |
| NFR-TGT-160 | DECIDED | All user-visible text through `t('key')`, placeholders not concatenation. | IN |
| ARCH-TGT-001, 002 | PROPOSED | The builder is a dialect strategy behind the adapter; application code never tests the product name. | IN |
| ARCH-TGT-003 | DECIDED | Minimums MySQL 8.4 LTS and MariaDB 10.11 LTS; no branches for older versions. | IN |
| UI-TGT-001, 003 | DECIDED | Three-area shell, tabs; shadcn/ui. The designer opens as a centre tab. | IN |
| ST-110 | file 12 | Statement timeout; 0 (unlimited) rejected; non-SELECT needs a `KILL QUERY` watchdog. | IN (FR-STR-017) |
| ST-120 | file 12 | Destructive confirmation: `.env` floor on for the hard class, server-side two-step token. | IN (FR-STR-005) |
| FR-TGT-200 | PROPOSED | Adapter reports capabilities; screens hide or disable what the target lacks with the reason. | IN (FR-STR-007 lists the capability keys this module needs) |
| FR-TGT-220 | PROPOSED | CHECK constraints: list, add, drop, toggle enforcement where supported. | IN (add, drop; toggle only where the probe says so) |
| FR-TGT-221 | PROPOSED | Functional (expression) indexes where the target reports `functional-index`. | DEFER (needs expression validation and a second editor mode) |
| FR-TGT-222 | PROPOSED | Invisible (MySQL) or ignored (MariaDB 10.6 or later) indexes. | IN |
| FR-TGT-223 | PROPOSED | Stored and virtual generated columns, with the product's keywords. | IN |
| FR-TGT-240 | PROPOSED | System-versioned tables (MariaDB 10.3 or later): add and remove versioning. | DEFER (MariaDB only; browse "as of" is OTHER: browse-edit) |
| FR-TGT-241 | PROPOSED | Sequences (MariaDB 10.3 or later). | DEFER (MariaDB only, separate object type) |
| FR-TGT-242 | PROPOSED | Column types of the connected server, including UUID, INET6 (MariaDB) and JSON. | IN (type list comes from the capability table) |
| FR-TGT-243 | PROPOSED | New databases and tables default to `utf8mb4` with the server's default collation; the shown character set comes from the server. | IN |
| FR-TGT-231, 232 | PROPOSED | Explain and histograms. | OTHER: sql-tab and a later performance module |

### 2.3 New requirements (PROPOSED)

| ID | Statement | Verification |
|---|---|---|
| FR-STR-001 | **Typed model.** Every structure change is described by a typed JSON model (`TableDefinition` for create, `AlterOp[]` for alter, `DatabaseDefinition`), validated by zod at the server boundary. No handler accepts SQL text. | Schema tests; a request containing a `sql` field is rejected. |
| FR-STR-002 | **One builder.** All DDL is produced by `buildStatements(model, capabilities)` in one module. Identifiers go through `quoteIdent`; everything that is not an identifier is a validated enum, an integer in a range, or a string literal escaped by one `quoteLiteral`. | Unit tests with hostile names and literals; lint rule of SEC-TGT-117 covers the folder. |
| FR-STR-003 | **Preview before run.** Each action first returns the exact statement list (and per statement a class and a one-line effect). Execution runs exactly the previewed list; the client cannot change it between preview and run. | E2E: the executed statements equal the shown ones; a tampered token is refused. |
| FR-STR-004 | **Plan binding.** A preview creates a server-side plan (session, target, user, statements, table fingerprint, expiry 10 minutes, single use). Execution takes an opaque plan id and, for destructive plans, the confirmation token. | Replay, expiry, other-session and other-tab tests. |
| FR-STR-005 | **Destructive classes.** Hard class (needs the token, cannot be switched off in the UI): DROP DATABASE, DROP TABLE, TRUNCATE, DROP COLUMN, and ALTER that can lose data (narrowing a type or length, changing nullability to NOT NULL, dropping a primary key). Soft class (confirmation the user may switch off): DROP INDEX, DROP FOREIGN KEY, DROP CHECK, rename. DROP DATABASE additionally requires typing the database name. | Per statement kind, a run without the token is refused by the server. |
| FR-STR-006 | **No false atomicity.** The preview states that MySQL and MariaDB DDL commits implicitly. Where possible the builder merges operations into one `ALTER TABLE` (one statement, atomic on InnoDB). A plan with several statements stops at the first failure and reports executed, failed and not-run statements; there is no rollback. | Integration test with a failing second statement. |
| FR-STR-007 | **Capability gating.** The builder and screens use capability keys (section 5.4) from the adapter (FR-TGT-200), never the product name. An operation the target does not support is refused by the builder with a stable error code and hidden or disabled in the UI with the reason. | Fake adapter test; both real servers. |
| FR-STR-008 | **Audit per statement.** Each executed statement writes one audit line: event, DBLoom user and target user, operation kind, database, object names, statement class, statement hash, outcome (ok, error number), duration. Literals (defaults, comments) are not logged. | Log capture test; no default value appears. |
| FR-STR-009 | **Read-only blocks DDL.** In read-only mode every structure function refuses before opening a connection and the UI shows the actions disabled with the reason. The refusal cannot be bypassed by a client field. | SCN-020. |
| FR-STR-010 | **System schemas protected.** `information_schema`, `performance_schema`, `mysql` and `sys` cannot be dropped, truncated or altered by DBLoom (also `lower_case_table_names` variants). The target's privileges still apply. | Refused by name before any SQL. |
| FR-STR-011 | **Expressions.** Generated-column, CHECK and default expressions are accepted only if the SQL parser (Q1) recognises a single scalar expression: no `;`, comments, subqueries, variables, or stored-function calls outside an allow-list. Rejection names the offending part (SEC-TGT-151 style). Plain defaults (number, string, NULL, `CURRENT_TIMESTAMP[(n)]`) use dedicated model kinds instead. | Rejection tests per forbidden construct; valid expressions run on both servers. |
| FR-STR-012 | **Stale-state check.** The plan stores a fingerprint of the table (hash of `SHOW CREATE TABLE` without AUTO_INCREMENT value). If it differs at execution, the run is refused with "table changed, review again" and a fresh preview is offered. | Change the table between preview and run. |
| FR-STR-013 | **Error mapping.** On failure the user sees the server's error number and message verbatim (escaped), the failing statement, and a short fixed hint for a closed list of codes (1050 table exists, 1451/1452 foreign key, 1062 duplicate, 1142/1044/1227 privilege, 1290 server read-only, 1205 lock wait, 3819/4025 CHECK violated, 1068 multiple primary key). The raw driver object is never serialised to the client. | Per-code test. |
| FR-STR-014 | **After-change event.** A successful plan emits `structure.changed {db, table?, kind}` on the server and the client query cache is invalidated for databases, tables and the table structure. Other modules (column transformations, PII marks) subscribe; this module does not know them. | Sidebar updates without reload. |
| FR-STR-015 | **Column rename and reorder.** Rename uses `RENAME COLUMN`, a type or attribute change uses `MODIFY`/`CHANGE` through the builder; reorder uses `FIRST`/`AFTER`. Foreign keys and indexes that reference a changed column are shown in the preview before it runs. | Integration per product (*verify* `RENAME COLUMN` on MariaDB 10.11). |
| FR-STR-016 | **Limits.** Identifiers at most 64 characters; at most 4096 columns (FR-DTB-154); at most 64 indexes and 16 key parts per index; enum/set lists at most 255 values. Numbers are enforced in the schema, the server's own limit still applies. | Schema tests. |
| FR-STR-017 | **Timeout and lock wait.** Every plan statement runs on a dedicated connection with `lock_wait_timeout` set and a watchdog that issues `KILL QUERY` from a second connection when the statement exceeds the statement timeout of ST-110 (default 60 s, user may lower, 0 rejected). MariaDB also gets `max_statement_time`. | A `LOCK TABLE` held by another connection ends in a clean timeout error. |

## 3. Scenarios

Style and actors as in `19-scenarios.md`. Test targets: `mysql:8.4` on port 33064 and `mariadb:10.11` on port 33061 (root/root, from `compose.test.yaml`), run once per product unless a scenario says otherwise. Each Playwright test creates its own scratch database through a fixture (`e2e_<random>`) and drops it in `afterEach`. Direct-mode login as in SCN-004.

### SCN-012 Create a table (D)
*Actor:* developer with CREATE on the scratch database. *Before:* logged in; database `e2e_x` exists and is empty.
1. The user opens the database, chooses "New table", names it `customer`.
2. The designer starts with one `id` row; the user adds `name VARCHAR(100) NOT NULL`, `created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`, sets `id` to BIGINT UNSIGNED, AUTO_INCREMENT, primary key.
3. "Preview SQL" opens a dialog with the statement. Engine, character set and collation show the server's defaults for `utf8mb4` (FR-TGT-243).
4. The user clicks "Create table".
*Accept when:* the dialog text contains `` CREATE TABLE `e2e_x`.`customer` ``, `` `id` bigint unsigned NOT NULL AUTO_INCREMENT ``, `PRIMARY KEY` and `utf8mb4`; no SQL ran before step 4 (`information_schema.TABLES` has no `customer`); after step 4 the table exists with three columns, the sidebar lists it without reload, the success message shows the executed SQL; the audit log has one `structure.execute` line with kind `create_table` and no default value in it. An existing name gives "Table already exists" with the server's error 1050 and the table list is unchanged. A name of 65 characters is refused in the form before any request.
*Requirements:* FR-DTB-040, 041, 138, 154; FR-STR-001, 002, 003, 008, 014, 016; FR-TGT-243.

### SCN-013 Add a column (D)
*Before:* table `customer` with 1000 rows.
1. In the designer of `customer` the user adds `email VARCHAR(255) NULL` after `name`, comment "login mail".
2. Preview shows one `ALTER TABLE ... ADD COLUMN ... AFTER `name``. The user confirms.
*Accept when:* the preview has exactly one statement; the column exists at position 3 with the comment; row count is still 1000; no confirmation token is demanded (not destructive); the audit line has class `soft`/`none`, kind `add_column`. Adding a second column and an index in the same session produces one merged ALTER (FR-STR-006), shown as one statement.
*Requirements:* FR-DTB-060, 062; FR-STR-006, 015.

### SCN-014 Drop a column with confirmation (D)
1. The user marks `email` for removal and opens the preview.
2. The dialog lists `ALTER TABLE ... DROP COLUMN `email``, labels it "deletes data permanently", and shows an extra confirmation field.
3. "Run" is disabled until the user ticks the confirmation; the user confirms.
*Accept when:* a direct call of the server function with the plan id but without the confirmation token is refused and the column still exists (server-side two-step, not a JS dialog); with the token the column is gone; a second use of the same token or plan id is refused; if the table was changed from another connection between preview and run, the run is refused with "table changed, review again" and nothing changes (FR-STR-012); the audit line has class `hard`.
*Requirements:* FR-STR-004, 005, 012; SEC-TGT-052, 118; ST-120.

### SCN-015 Create an index (D)
1. The user opens "Indexes", adds a UNIQUE index `uq_email` on `email`, and a second INDEX `idx_name` on `name(20)`.
2. Preview, run.
*Accept when:* `SHOW INDEX` lists both with the right uniqueness and sub-part; naming the new index `PRIMARY` shows "The name of the primary key must be PRIMARY" style error in the form and sends nothing (FR-DTB-063); creating an index that duplicates an existing one runs but the designer shows the duplicate notice (FR-DTB-064); an index on a column that does not exist is refused before any SQL (SEC-TGT-116). A FULLTEXT index on a VARCHAR column works on both products. Dropping an index is soft class: a confirmation without the token requirement of the hard class.
*Requirements:* FR-DTB-063, 064; DATA-DTB-001; SEC-TGT-116.

### SCN-016 Drop a table (D)
1. From the table list the user chooses "Drop table" for `customer`.
2. The dialog shows `DROP TABLE `e2e_x`.`customer``, the estimated row count and the foreign keys of other tables that reference it, and asks the user to type the table name.
*Accept when:* the button stays disabled until the exact name is typed; with a foreign key from `orders` to `customer` the server error 3730 (MySQL) or 1451/1217 (MariaDB) is shown verbatim with a hint, the table still exists; with the optional "ignore foreign key checks for this statement" box (FR-DTB-049) the drop succeeds and `@@foreign_key_checks` is back to 1 on the connection afterwards; views are dropped with `DROP VIEW` (FR-DTB-047, view creation itself is deferred); the sidebar loses the table; the audit line has class `hard`.
*Requirements:* FR-DTB-047, 049; FR-STR-005, 013.

### SCN-017 Create a database (D)
1. The user chooses "New database", enters `e2e_new`, leaves the collation on "server default".
2. The collation list is read from the server; the user picks `utf8mb4_unicode_ci`; preview shows `CREATE DATABASE ... CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`.
*Accept when:* after run the database appears in the sidebar and a link opens it; the message shows the SQL (NFR-SRV-002); a name that exists gives the server's error 1007 and no navigation; an empty name or an unknown collation is refused before the request (FR-SRV-032); names `mysql` or `sys` cannot be dropped later (SCN-016 variant: "Drop database" on `mysql` is refused by name, FR-STR-010); dropping `e2e_new` needs the typed name and the hard token (SEC-DTB-002, FR-SRV-031).
*Requirements:* FR-SRV-031, 032; NFR-SRV-002; SEC-DTB-002; FR-STR-010.

### SCN-018 Rename a table and a column (D)
1. The user renames table `customer` to `client`; then renames column `name` to `full_name`.
*Accept when:* the first preview is `RENAME TABLE `e2e_x`.`customer` TO `e2e_x`.`client``; the second is `ALTER TABLE ... RENAME COLUMN ... TO ...` (or `CHANGE` where the product needs it, *verify*); a rename to an existing name shows error 1050/1060 verbatim; renaming to the same name or to an empty name is refused in the form (FR-DTB-031); a rename is soft class; indexes and foreign keys that reference the column are listed in the preview and still exist after the rename.
*Requirements:* FR-DTB-042, 043, 031; FR-STR-015.

### SCN-019 Truncate a table (D)
1. The user chooses "Empty table" on `client` (1000 rows).
*Accept when:* the dialog shows `TRUNCATE TABLE ...` and the estimated row count and requires the typed name; the table is empty afterwards and AUTO_INCREMENT restarts at 1; a view in a multi-selection is skipped with a notice (FR-DTB-048); on a table referenced by a foreign key the server's error is shown (and the FK-checks option of SCN-016 is offered); the audit line has class `hard`.
*Requirements:* FR-DTB-048, 049; FR-STR-005.

### SCN-020 Read-only connection (D)
*Before:* the session is read-only (forced by `DBLOOM_READ_ONLY=true` or switched on for the session; the settings UI is OTHER: admin).
*Accept when:* "New table", "New database", "Drop", "Empty" and every designer "Run" button are disabled with the text "Read-only connection"; direct calls to each structure server function return the same refusal with a stable code, and no connection to the target is opened for them (counter in a test double); with read-only forced by `.env` the user cannot switch it off from the UI; with read-only chosen by the user, switching to read-write is possible and the same actions work; preview still works in read-only mode (it changes nothing) unless the owner decides otherwise (Q4).
*Requirements:* FR-STR-009; SEC-TGT-052.

### SCN-021 Privilege denied (D)
*Before:* a target user with only SELECT on `e2e_x` (created by the fixture, logged in as that user).
*Accept when:* the actions may be shown, but running "Create table" ends with the server's message ("CREATE command denied to user ...", error 1142) and the hint "Your account lacks a privilege for this action", nothing is created; dropping a database without privilege gives error 1044; the message never contains the password; the audit line records outcome `error 1142`; the documented minimum-privilege table (SEC-TGT-053) lists CREATE, ALTER, DROP, INDEX and REFERENCES for this module.
*Requirements:* FR-STR-013; SEC-TGT-023, 053; SEC-TGT-050.

### SCN-022 Version differences (D, once per product)
Each assertion has an expected result for MySQL 8.4 and for MariaDB 10.11.
1. *CHECK:* add `CHECK (price >= 0)` named `chk_price`. Both products run it; inserting `-1` fails with the server's message (3819 on MySQL, 4025 on MariaDB, *verify*). Drop uses the product's accepted keyword (*verify* `DROP CONSTRAINT` on both). The toggle "not enforced" is shown only where the probe reports `check-enforcement-toggle` (MySQL yes; MariaDB *verify*).
2. *Invisible index:* on MySQL the action reads "Make invisible" and the preview contains `INVISIBLE`; on MariaDB it reads "Ignore index" and the preview contains `IGNORED` (*verify* syntax); a PRIMARY key offers neither; `SHOW INDEX` shows the state afterwards.
3. *Generated column:* the editor offers virtual and stored; the preview uses `GENERATED ALWAYS AS (expr) VIRTUAL|STORED` on MySQL and the MariaDB form (`VIRTUAL`/`PERSISTENT`/`STORED`, *verify* which keyword the builder emits); an expression with a subquery or `;` is refused by the validator before any request (FR-STR-011); the generated column rejects a default value and AUTO_INCREMENT in the form.
4. *Types and defaults:* UUID and INET6 are offered on MariaDB 10.11 only, JSON on both (FR-TGT-242); the default collation shown for utf8mb4 differs (MySQL `utf8mb4_0900_ai_ci`, MariaDB `utf8mb4_general_ci`) and comes from the server.
5. *Hidden features:* system versioning and sequence actions are not shown on either in slice 1 (DEFER).
*Accept when:* a screen test with a fake adapter that reports no capabilities hides or disables each item with "not supported by this server version" (FR-TGT-200), and the real runs on both servers pass the assertions above.
*Requirements:* FR-TGT-200, 220, 222, 223, 242, 243; DEP-DTB-001; FR-STR-007, 011.

### SCN-023 Multi-statement failure and stale plan (D)
1. The user prepares a plan that the builder cannot merge into one ALTER (for example create table, then a separate RENAME of another table that does not exist).
*Accept when:* the preview warns "These statements run one after another; MySQL commits each one and cannot undo earlier ones"; after the failure the result lists statement 1 as done, statement 2 as failed with the server's message, and any later one as not run; the first change is still in place; the audit log has one line per executed statement. Reusing the plan id after a restart of the server gives the single "plan expired" response, not a crash.
*Requirements:* FR-STR-004, 006, 008.

## 4. Objective of the module spec in one line
The user designs, sees the SQL, confirms where it is destructive, and the server runs exactly that SQL under the guard and records it.

## 5. Design

### 5.1 Files and data flow
```
UI (designer form, JSON model)
  -> structure.preview (zod)            -> guard.assertWritable -> introspect (catalog) -> buildStatements (pure)
                                           -> plan stored in session {statements, fingerprint, classes, expiry}
  <- {planId, statements[], classes[], warnings[], confirmRequired}
  -> structure.execute {planId, confirmToken?}
                                        -> guard.assertWritable -> verify plan (session, expiry, single use, token)
                                        -> fingerprint check -> dedicated connection -> statements one by one
                                        -> audit per statement -> structure.changed event
  <- {results[]}   (executed / failed with server errno and message / not run)
```
Introspection reads the catalog (`information_schema.COLUMNS`, `STATISTICS`, `TABLE_CONSTRAINTS`, `KEY_COLUMN_USAGE`, `REFERENTIAL_CONSTRAINTS`, `CHECK_CONSTRAINTS`, `SHOW CREATE TABLE`) through parameterised queries; names for existing objects are accepted only if the catalog holds them (SEC-TGT-116).

### 5.2 Typed model (sketch, not final code)
```ts
type ColumnDef = {
  name: string;                                   // new name, rule FR-DTB-041
  type: ColumnType;                               // closed enum, keys from the capability table
  length?: number; precision?: number; scale?: number; values?: string[];   // enum/set
  unsigned?: boolean; nullable: boolean;
  default: { kind: 'none' } | { kind: 'null' } | { kind: 'literal'; value: string | number }
         | { kind: 'currentTimestamp'; fsp?: 0..6 } | { kind: 'expression'; sql: string };   // expression -> FR-STR-011
  autoIncrement?: boolean; onUpdateCurrentTimestamp?: boolean;
  generated?: { sql: string; storage: 'virtual' | 'stored' };
  charset?: string; collation?: string;           // checked against the server list
  comment?: string; invisible?: boolean;          // invisible column: capability
};
type IndexDef = { name?: string; kind: 'primary'|'unique'|'index'|'fulltext'; parts: {column: string; length?: number; order?: 'asc'|'desc'}[]; visibility?: 'visible'|'invisible' };
type FkDef = { name?: string; columns: string[]; refDb: string; refTable: string; refColumns: string[]; onDelete: Action; onUpdate: Action };
type CheckDef = { name?: string; sql: string; enforced?: boolean };
type TableDefinition = { db: string; name: string; columns: ColumnDef[]; indexes: IndexDef[]; fks: FkDef[]; checks: CheckDef[]; engine?: string; charset?: string; collation?: string; comment?: string; autoIncrement?: number; rowFormat?: string };
type AlterOp = { op: 'addColumn'|'modifyColumn'|'renameColumn'|'dropColumn'|'addIndex'|'dropIndex'|'setIndexVisibility'|'addFk'|'dropFk'|'addCheck'|'dropCheck'|'setOptions'|'renameTable'|'truncate'|'dropTable' } & Payload;
```
`default.literal` strings are escaped by `quoteLiteral` or sent as part of a prepared DDL only where the server allows it (DDL cannot use `?` placeholders in `mysql2` prepared form, so escaping is central and fuzzed). Engines, charsets, collations, row formats and referential actions are checked against lists read from the server or fixed enums, never passed through.

### 5.3 Builder
One module, `buildStatements(input, capabilities): Statement[]`, pure and synchronous, no connection. `Statement = { sql, kind, class: 'none'|'soft'|'hard', effect: string, params: [] }`. Rules: merge all column, index, FK and CHECK operations on one table into a single `ALTER TABLE` (comma list) so InnoDB applies them atomically; `RENAME TABLE`, `TRUNCATE`, `DROP`, `CREATE DATABASE` are separate statements; create table is one statement with keys and constraints inline (a FK that references a table created in the same plan is added with a later `ALTER`). Statement text is for display and execution and is identical; it contains no secrets except possibly default values, which is why audit logs a hash, not the text (FR-STR-008).

### 5.4 Capability keys used (FR-TGT-200 extension; values come from the adapter probe on connect)
| Key | MySQL 8.4 | MariaDB 10.11 | Used for |
|---|---|---|---|
| `check-constraint` | yes | yes | FR-TGT-220 |
| `check-enforcement-toggle` | yes (`ALTER CHECK ... [NOT] ENFORCED`) | *verify* | FR-TGT-220 |
| `index-hide` | `INVISIBLE` | `IGNORED` (10.6+), *verify* syntax | FR-TGT-222 |
| `generated-column` | `VIRTUAL`, `STORED` | `VIRTUAL`, `PERSISTENT`/`STORED` | FR-TGT-223 |
| `column-invisible` | *verify* | *verify* | optional |
| `type-uuid`, `type-inet6` | no (*verify*) | yes | FR-TGT-242 |
| `type-json` | yes | yes (alias for LONGTEXT with check) | FR-TGT-242 |
| `compressed-column` | no | yes | DEP-DTB-001 |
| `rename-column` | yes | *verify* | FR-STR-015 |
| `functional-index`, `system-versioning`, `sequence` | yes / no / no | no / yes / yes | deferred items |
The probe is a startup query on `VERSION()` and `@@version_comment` mapped to a capability set by the adapter strategy (ARCH-TGT-002); the integration suite asserts the set for the two test servers and the *verify* cells are filled in from that run before approval.

### 5.5 Write guard (`src/server/guard/`, shared with sql-tab and browse-edit)
- `assertWritable(session)`: refuses when the session is read-only (forced by `.env`, default for new connections, or per connection; SEC-TGT-052). Called first in every structure function.
- `classify(statement)`: this module's statements carry their class from the builder; the generic classifier for free SQL (sql-tab) is out of scope here but shares the type.
- Confirmation token: HMAC over `{sessionId, userId, target, planId, statementsHash, expiry}` with a per-process key; issued by `preview` only for plans that contain a hard statement; checked on `execute`; single use; unrelated to any client-side dialog (SEC-TGT-118, ST-120). The hard class list is `.env`-fixed and cannot be switched off by users; the soft class confirmation is a user preference (ST-120).
- Statement timeout: see FR-STR-017. Multi-statement is never used: `multipleStatements` stays false in `target-pool.ts`; each statement is one `query` call.
- The guard is a guard rail, not a boundary (SEC-TGT-050): the target's privileges decide.

### 5.6 Foreign key checks
`FOREIGN_KEY_CHECKS` is a session variable, so the option only exists for plans that run on one dedicated connection: `SET SESSION foreign_key_checks=0` before and `=1` in a `finally`; the connection is destroyed instead of returned to the pool if the reset fails. The option is off by default, available for DROP TABLE and TRUNCATE only, listed in the preview as its own statement, and counts as hard class (FR-DTB-049).

### 5.7 DDL is not transactional
In MySQL and MariaDB every DDL statement ends the current transaction with an implicit commit and cannot be rolled back. Consequences: (1) a failed multi-statement plan leaves the earlier statements applied; DBLoom reports exactly that (FR-STR-006) and offers a fresh preview from the new state, not an automatic undo. (2) A single `ALTER TABLE` on InnoDB is atomic in MySQL 8.x (atomic DDL via the data dictionary) and crash-safe in MariaDB 10.6 and later; the module relies on this only for "one statement is all or nothing", and does not claim atomicity for `DROP TABLE a, b` across engines. (3) Wrapping a plan in `START TRANSACTION` is useless and misleading, so the optional transaction wrapper of FR-DTB-022 does not apply to structure changes. (4) The preview shows a data-loss warning for each hard statement; no backup is taken (a "copy data first" option is a follow-up with table copy). (5) Online DDL hints (`ALGORITHM`, `LOCK`) and tools for very large tables are out of slice 1; the dialog shows the estimated row count so the user knows what an ALTER may cost.

### 5.8 Error mapping
`mysql2` errors expose `errno`, `code`, `sqlMessage`, `sql`. The mapper returns `{ errno, code, message, statementIndex, hint? }` where `message` is the server's text, escaped on output (SEC-TGT-112), and `hint` comes from a closed table keyed by `errno` (FR-STR-013). Passwords are never in these fields; the `sql` field is shown because the user wrote it, but connection errors (`ECONNREFUSED`, TLS) follow the skeleton's uniform error path. Unknown errors show the server message and "Unexpected error" without a stack.

### 5.9 Minimum privileges (SEC-TGT-053 input)
CREATE DATABASE needs global CREATE; DROP DATABASE needs DROP on the database; CREATE TABLE needs CREATE; ALTER TABLE needs ALTER (plus INDEX for index changes, REFERENCES for foreign keys on MySQL; MariaDB checks differ, *verify*); DROP TABLE needs DROP; TRUNCATE needs DROP; RENAME TABLE needs ALTER and DROP on the old name, CREATE and INSERT on the new. DBLoom does not pre-check; it runs and maps the error (a `SHOW GRANTS` based hint to disable buttons is a follow-up, Q7).

## 6. Tech stack
As file 21 section 3: TypeScript strict, TanStack Start, `mysql2` (only `src/server/db/` and the new `src/server/structure/` call it through the adapter wrapper, never components), zod, shadcn/ui, Vitest, Playwright. Possible addition: an SQL parser for FR-STR-011 (Q1), not added without a go.

## 7. Commands
As file 21 section 4, plus:
```
Unit (builder, guard):   npx vitest run tests/structure-builder.test.ts tests/guard.test.ts
Integration:             docker compose -f compose.test.yaml up -d && npx vitest run tests/structure.integration.test.ts
E2E:                     npx playwright test e2e/structure-*.spec.ts
```

## 8. Project structure (new and touched files)
```
src/server/structure/types.ts          model + zod schemas + Statement/Plan types      (contracts, task 0)
src/server/structure/capabilities.ts   capability keys and per-product strategies
src/server/structure/builder.ts        buildStatements, quoteLiteral (quoteIdent stays in db/identifiers.ts)
src/server/structure/expression.ts     expression validation (FR-STR-011)
src/server/structure/introspect.ts     catalog reads, table fingerprint
src/server/structure/execute.ts        dedicated connection, timeout watchdog, per-statement run, audit calls
src/server/structure/errors.ts         error mapper
src/server/structure/plans.ts          server-side plan store (session scope)
src/server/structure.functions.ts      preview, execute, listCollations, createDatabase, ... (zod, sessionMiddleware)
src/server/guard/write-guard.ts        assertWritable, read-only levels
src/server/guard/confirm-token.ts      HMAC token issue/verify
src/server/audit.ts                    (touched by package B only) typed event helper for structure events
src/components/structure/*.tsx         table-designer, column-row, index-editor, fk-editor, check-editor, preview-dialog, confirm-dialog, db-dialogs
src/i18n/en.json                       keys with prefix `structure.` (package D only edits that prefix)
src/components/shell/app-shell.tsx, sidebar-tree.tsx   menu entries and tab type (package D only, for this module)
tests/structure-builder.test.ts, tests/guard.test.ts, tests/structure.integration.test.ts
e2e/structure-*.spec.ts                one file per scenario group
```

## 9. Code style
As file 21 section 6. Handlers stay thin:
```ts
export const previewStructure = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator(previewSchema)                                  // zod; no raw SQL field exists
  .handler(async ({ context, data }) => {
    assertWritable(context.session)                          // read-only refuses first
    const current = await introspect(context.session.pool, data)   // names verified (SEC-TGT-116)
    const statements = buildStatements(data, context.session.capabilities)
    return storePlan(context.session, statements, current.fingerprint)
  })
```
No SQL string is built outside `builder.ts`; the lint rule of SEC-TGT-117 is widened to forbid template strings containing DDL keywords elsewhere in `src/server/structure/`.

## 10. Testing strategy
- Unit: builder snapshot tests for each operation and each product's capability set; hostile names (backticks, quotes, unicode, 64-character names, reserved words); literal escaping fuzz; expression validator accept/reject table; token issue/verify (tamper, replay, expiry, wrong session); error mapper table.
- Integration (MySQL 8.4 on 33064, MariaDB 10.11 on 33061, root/root, plus a limited-privilege user): every statement kind runs and the catalog shows the effect; multi-statement stop; stale fingerprint; timeout watchdog with a held metadata lock; FK-check option restores the variable; capability set per product (fills the *verify* cells).
- E2E (Playwright): SCN-012 to SCN-023, one product by default, the full matrix in CI.
- Security checks: forged POST without CSRF rejected (skeleton), request with `sql` field rejected, execute without token refused for each hard statement, no default or password in logs.
- CI as in file 21 section 8.

## 11. Boundaries
- **Always:** test first for builder and guard, preview before every run, fully qualified names, verify existing names against the catalog, reuse `quoteIdent`, add UI text only through `t()`, run lint, typecheck and tests before reporting done.
- **Ask first:** adding a dependency (the SQL parser), changing the `Store` or session shape, changing the audit line format after package B, adding a statement kind outside section 2, any commit or push.
- **Never:** accept SQL text from the client, build DDL outside `builder.ts`, run `USE`, enable `multipleStatements`, skip the server-side token check for the hard class, log default values or passwords, auto-undo a partly applied plan, call `mysql2` from components.

## 12. Success criteria
1. SCN-012 to SCN-023 pass on MySQL 8.4 and MariaDB 10.11.
2. No structure statement runs without a preview of exactly that statement; a tampered or reused token never runs a hard statement.
3. Read-only refuses every structure function without opening a target connection.
4. A privilege error shows the server's message and creates nothing.
5. The *verify* cells of section 5.4 are filled from the integration run and this file is updated.
6. Lint, typecheck, unit, integration and e2e green in CI on Node 24.7 and 24 (minimum raised by SPEC/26 Q1).

## 13. Task breakdown and work packages

Packages A to E can run in parallel (as separate subagents) after task 0, because each package owns its files and talks to the others only through `src/server/structure/types.ts` (frozen by task 0; changes need the coordinating agent). Shared files: `src/server/audit.ts` is owned by package B; `src/i18n/en.json` and the shell files by package D; nobody else edits them.

| Task | Package | Files (owner) | Acceptance | Verify |
|---|---|---|---|---|
| 0 Contracts | coordinator | `structure/types.ts`, `structure/capabilities.ts` (types only) | Model, `AlterOp`, `Statement`, `Plan`, capability keys, error shape, server function input/output types compile; `FR-STR` ids in comments | `npm run typecheck` |
| 1 Builder core | A | `structure/builder.ts`, `tests/structure-builder.test.ts` | Create database, create table, columns, defaults, keys, options; `quoteLiteral`; one merged ALTER for column ops | Unit tests incl. hostile names, snapshot per product |
| 2 Builder ops | A | `builder.ts`, `capabilities.ts` (strategies), `expression.ts`, tests | Index ops, FK, CHECK, generated columns, index hide/ignore, rename, truncate, drops with classes; capability refusal codes | Unit tests; `RENAME COLUMN`/`IGNORED`/`DROP CONSTRAINT` cells marked until task 8 |
| 3 Guard | B | `guard/write-guard.ts`, `guard/confirm-token.ts`, `tests/guard.test.ts` | Read-only levels (`.env` forced, default, per connection), HMAC token bound to session/plan/hash/expiry, single use | Unit: tamper, replay, expiry, other session; no DDL assumptions |
| 4 Audit and timeout | B | `audit.ts`, `guard/statement-timeout.ts`, test additions | Typed audit event for structure statements (hash, class, outcome, duration, no literals); watchdog helper using `KILL QUERY`; zero timeout rejected | Unit with fake connections; log capture shows no literal |
| 5 Introspection | C | `structure/introspect.ts`, `structure/plans.ts`, integration test part | Catalog reader for columns, indexes, FKs, CHECK, collations, engines; fingerprint; session plan store with expiry | Integration on both servers incl. table with hostile names |
| 6 Execute and errors | C | `structure/execute.ts`, `structure/errors.ts`, integration test part | Dedicated connection, per-statement run, stop on first failure with executed/failed/not-run result, FK-check option with reset, error mapper table | Integration: failing second statement, held lock timeout, 1142 with limited user |
| 7 Server functions | C | `structure.functions.ts`, `tests/structure.integration.test.ts` | preview, execute, collations/engines/types lists, create/drop database; zod schemas; read-only refusal before connect; `structure.changed` event | Integration both servers; request with `sql` field rejected; no-CSRF POST rejected |
| 8 Capability probe fill-in | C (after 2, 7) | integration test, this file section 5.4 | The *verify* cells are replaced by observed results | Test report; spec updated by the coordinator |
| 9 Dialogs | D | `components/structure/preview-dialog.tsx`, `confirm-dialog.tsx`, `db-dialogs.tsx`, `en.json` (prefix) | Preview with statement list, class badges, data-loss text, typed-name confirmation, execute result list; create/drop database, truncate, drop, rename dialogs | Component tests with mocked server functions; keyboard and reduced-motion check |
| 10 Table designer | D | `components/structure/table-designer.tsx`, `column-row.tsx`, `index-editor.tsx`, `fk-editor.tsx`, `check-editor.tsx` | Create and alter forms from the model; capability-driven options; client-side validation mirrors zod; framed-sheet style of the skeleton shell; disabled-with-reason states | Playwright smoke of SCN-012 on one product |
| 11 Shell integration | D | `components/shell/app-shell.tsx`, `sidebar-tree.tsx` | Tab type "designer", context menu entries, cache invalidation on `structure.changed`, read-only state shown | SCN-004/005 e2e still pass |
| 12 E2E | E | `e2e/structure-create.spec.ts`, `structure-alter.spec.ts`, `structure-drop.spec.ts`, `structure-readonly-privilege.spec.ts`, `e2e/fixtures/scratch-db.ts` | SCN-012 to SCN-023 assertions; scratch database fixture and limited-user fixture | All specs green on both products |

Order and parallelism: 0 first and alone; then A (1, 2), B (3, 4), C (5; 6 and 7 after A and B publish their interfaces, using the frozen types), D (9, 10, 11 against mocked server functions) in parallel; 8 and 12 last. Conflicts: none by file ownership; `en.json` merges by key prefix `structure.`; the only cross-package edit is the lint config, owned by A.

## 14. Open questions for the owner (max 8, each with a recommended default)

| # | Question | Recommended default |
|---|---|---|
| Q1 | Expressions (generated column, CHECK, default) are SQL typed by the user. Which parser validates them (SEC-TGT-151)? The parser dependency is not yet chosen. | Use the same maintained parser as SEC-TGT-151/158 once picked; until then accept only a narrow tokenizer grammar (columns, literals, operators, an allow-list of functions) and reject everything else. |
| Q2 | The write guard (read-only, confirmation token, timeout) is shared with `sql-tab`. Build it here first? | Yes: package B builds it in `src/server/guard/` now; `sql-tab` consumes it and adds the statement classifier. |
| Q3 | Who may drop a database (SEC-DTB-002 and FR-SRV-031 leave "who" open)? | The target's privileges decide; DBLoom adds the typed-name confirmation and the hard token; a DBLoom role gate is added with account mode. |
| Q4 | Does a read-only session still show the preview? | Yes, preview works (it changes nothing), run is disabled; helps users who prepare SQL for a DBA. |
| Q5 | Database rename and copy (FR-DTB-030) are heavy and non-atomic. In slice 1? | No: defer; slice 1 has table rename only. Revisit with table copy as one "copy and move" package. |
| Q6 | The read-only structure view is `browse-edit`'s. Where does the designer live? | A separate "Design" tab per table, opened from the structure view and the sidebar; the view stays read-only and links to the designer. |
| Q7 | Disable buttons by `SHOW GRANTS` analysis, or only map the server error? | Only map the error in slice 1 (grants parsing is fragile for roles and wildcards); revisit later. |
| Q8 | Which changes count as hard (data-loss) class beyond drop and truncate? | As in FR-STR-005: type narrowing, NOT NULL change, primary key drop; everything else soft. The `.env` fixes the hard list; the administrator may add classes (ST-120). |
