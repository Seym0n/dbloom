# 25 — Module spec: `io` (export and import of SQL, CSV and JSON)

**Status: APPROVED (2026-10-27): the owner answered Q1 to Q6 and said "go" for Q7 to Q10 (recommended defaults, decided by the assistant on the owner's instruction, open to change). Owner answers of 2026-10-27: Q1 packages, Q2 no LOAD DATA (FU-011), Q3 UTF-8 only, Q4 Unicode letters and digits, Q5 jobs lost on restart accepted, Q6 three-tier import statement policy.** Written with the spec-driven-development skill, in the format of `24-module-rows.md`. It is the module `io` of the capability map in file 21 section 0. It depends on `skeleton` and on what `structure`, `sql-tab` and `rows` already built (`src/server/guard/`, `src/server/structure/` plan store, error mapper and builder, `src/server/sql/` parser, classifier and `export-source.ts`, `src/server/rows/` codecs and builder, `src/components/structure/` confirm dialog), and it does not respecify them. Requirements marked PROPOSED are new (`FR-IO-nnn`, type FR, subsystem IO; the code IO is to be added to the README table when this file is accepted). Vendor facts that this draft could not check are marked *verify*; spike 0 (section 13) and the integration suite test them before anything is built on them. Nothing in this file reopens a decision of `OPEN.md`, `11-target-security.md`, `12-settings.md` or `19-scenarios.md` (G4 is implemented as decided). UI work follows the same rules as the rows module: the `apple-design` and `design-taste-frontend` skills (app rules) are applied by package D (owner instruction, 2026-10-27).

## 0. Assumptions (correct me now)
1. Direct mode, one target per session, as in the skeleton. The state store (SQLite) holds export templates and defaults; in stateless mode (`DBLOOM_STORE=none`) they live in the session only, with the same limits.
2. First slice = export (server, database, table and query-result scope; SQL, CSV, JSON; none, gzip or zip) and import (SQL, CSV, JSON from an uploaded file; SQL file into a server or database, CSV and JSON into an existing or new table), as background jobs with progress, cancel, limits and resume. Deferred or other modules: section 2.5.
3. No browser or server request ever carries SQL text for export; import carries only an uploaded file (identified by a server-side id). Everything DBLoom itself writes into a statement comes from the central builders (`quoteIdent`, `quoteLiteral` of `structure/builder.ts`, parameters).
4. Jobs run in the Node process, not durably. A server restart ends them; an interrupted import can only be resumed while its staged file and job record still exist (Q5).
5. Dependencies (Q1, decided 2026-10-27): `fflate` (ZIP write and read, streaming), `csv-parse` and `csv-stringify` (CSV), `stream-json` (JSON reader); the JSON writer is own code. Node built-ins cover gzip (`node:zlib`) and charset decoding (`TextDecoder`). Each package is pinned exactly and checked against the hostile fixtures of section 10 (zip bomb, quote injection, huge fields) before it is relied on; the safety limits (entries, ratio, size) stay our code.
6. The target's privileges are the security boundary (SEC-TGT-050). The classifier, the allow-lists and the limits are guard rails and are documented and tested as such.
7. Export does not change the target, so it is allowed in read-only mode. Import changes it and is refused in read-only mode.

## 1. Objective
A permitted user can take data out of a MySQL 8.4 or MariaDB 10.11 target and bring it back. Export covers the whole server, one database, chosen tables, one table (with row range) and the result of a read statement; the output is a SQL dump, a CSV file or a JSON file, optionally gzip or zip compressed, streamed to the browser without holding it in memory, with a safe file name and honest failure behaviour (no half file passes as complete). Import covers SQL dumps, CSV and JSON files: the file is uploaded in a stream, analysed, shown with target, database and file name for explicit confirmation (with the server-checked token when it contains destructive statements), then run as a job with progress, a time limit, cancel and resume, and a result that names what ran and what failed. An export of a database imports again unchanged on both products. All DBLoom-generated SQL comes from builders; uploaded SQL runs only through the guard classes; every job is audited without data.

## 2. Requirements and dispositions

Legend as in files 22 to 24. **Disp**: the triage disposition of `18-scope-triage.md` (KEEP, ADAPT) or PROPOSED / upstream / in force / file 12 for rows of files 11 to 17. **Where**: IN = built in the first slice; DEFER = belongs here but later (reason given); OTHER = belongs to the named module; DROP = not carried over. The traceability file (`tasks/traceability/traceability.tsv`) holds 148 rows with module `io`; all 148 appear below exactly once (check: `node scripts/check-traceability-ids.mjs SPEC/25-module-io.md io`).

### 2.1 Legacy requirements (files 02, 04, 05, 06, 07, 18, 20) — 95 rows

| ID | Disp | DBLoom wording (one line) | Where |
|---|---|---|---|
| FR-IOX-001 | ADAPT | Export in SQL, CSV and JSON only, each with name, extension and MIME type; Excel CSV is a CSV preset. | IN (FR-IO-002, 006) |
| FR-IOX-005 | KEEP | Per-format choice of structure, data or both; invalid values rejected, no silent fallback. | IN (FR-IO-002) |
| FR-IOX-006 | ADAPT | SQL, CSV and JSON can be viewed as text or saved as file. | IN (FR-IO-009) |
| FR-IOX-007 | ADAPT | SQL export options: header comments, FK checks off, transaction wrapper, CREATE DATABASE, DROP, routines, views, triggers, AUTO_INCREMENT, extended inserts, statement type. | IN (FR-IO-004) |
| FR-IOX-008 | KEEP | CSV: separator, enclosure, escape, line terminator, NULL string, header row. | IN (FR-IO-006) |
| FR-IOX-009 | ADAPT | Excel CSV preset (semicolon, CRLF, quotes, headers); output is CSV, not XLSX. Resolves the UNSURE flag: a preset of the CSV options, not a format. | IN (FR-IO-006) |
| FR-IOX-010 | KEEP | JSON: pretty-print and unicode options via native serialisation. | IN (FR-IO-007) |
| FR-IOX-013 | KEEP | Export of a free-typed query result; unsupported formats give a clear error; file name export.ext. | IN (FR-IO-002, 003; hook FR-SQL-026) |
| FR-IOX-015 | KEEP | Server, database, table and query-result scopes; invalid parameter combinations rejected. | IN (FR-IO-002) |
| FR-IOX-016 | KEEP | Database export filters by selected tables; message when none selected. | IN (FR-IO-002) |
| FR-IOX-017 | KEEP | Optional table read lock with guaranteed unlock; forced structure or data override. | IN (FR-IO-003) |
| FR-IOX-022 | ADAPT | Text-mode export in a read-only view with copy, Back and Refresh reusing the options. | IN (FR-IO-009) |
| FR-IOX-025 | ADAPT | ZIP and GZIP compression without any server flag. | IN (FR-IO-008) |
| FR-IOX-026 | ADAPT | GZIP streamed in chunks, memory bounded. | IN (FR-IO-008) |
| FR-IOX-030 | ADAPT | Save export in a server directory. | DROP (SEC-TGT-071: server-side saving is not provided) |
| FR-IOX-031 | KEEP | Compressed export gains .zip or .gz and the matching MIME type; format extension appended when absent. | IN (FR-IO-009) |
| FR-IOX-032 | ADAPT | ZIP as one archive; separate-files option writes one entry per table, view or section. | IN (FR-IO-008) |
| FR-IOX-034 | ADAPT | Filename templates with date, server, database, table, column and host tokens, optional escaping. | IN (FR-IO-009; tokens in section 5.5) |
| FR-IOX-035 | ADAPT | Remember the template per export scope and user in the DBLoom store. | IN (FR-IO-011) |
| FR-IOX-037 | ADAPT | Import sources: pasted text, uploaded file, bookmark, standard files; upload over the limit explains the limit. | IN for the uploaded file; pasted text and bookmarks run in the SQL tab (OTHER: sql-tab) |
| FR-IOX-038 | ADAPT | Only SQL, CSV and JSON import formats; other value rejected. | IN (FR-IO-002) |
| FR-IOX-040 | ADAPT | SQL import streamed statement by statement with own splitter; skip errors, skip first N, count, stop cleanly at the time limit. | IN (FR-IO-017) |
| FR-IOX-041 | KEEP | CSV import: delimiter, enclosure, escape, line ending, replace or ignore, partial import, header, column list, new table or database. | IN for existing and new table (FR-IO-018, 019); creating a new database stays with the structure module |
| FR-IOX-042 | KEEP | Column type inference and CREATE TABLE plus INSERT for new-table import. | IN (FR-IO-019) |
| FR-IOX-046 | ADAPT | CSV import through LOAD DATA INFILE at table scope. | DEFER (Q2, FU-011: batched parameterised INSERT is the one path in slice 1) |
| FR-IOX-048 | ADAPT | Import files from an upload or from a configured server directory; paths outside and symbolic links rejected. | IN (FR-IO-013; off by default) |
| FR-IOX-049 | ADAPT | Transparent GZIP and ZIP import (bzip2 optional); detected by content; ZIP reads the first entry. | IN for gzip and zip (FR-IO-014); bzip2 DROP (no Node support, no demand) |
| FR-IOX-050 | KEEP | Strip UTF-8 and UTF-16 byte-order marks on the first chunk; may select the charset. | IN (FR-IO-015) |
| FR-IOX-051 | ADAPT | Convert import files from the chosen charset to UTF-8 while reading. | IN (FR-IO-015; SEC-TGT-155) |
| FR-IOX-056 | ADAPT | A failing SQL statement is reported with the server error and stops the import unless ignore-errors; optional rollback of transactional tables only. | IN (FR-IO-017) |
| FR-IOX-057 | KEEP | Disable FK checks during import and always restore, also on errors. | IN (FR-IO-017; the connection is dedicated and destroyed) |
| FR-IOX-058 | ADAPT | Success message with query count and file name; refresh navigation after DDL by client state. | IN (FR-IO-024) |
| FR-IOX-061 | ADAPT | Live progress while a long file uploads and is processed. | IN (FR-IO-001, 026) |
| FR-IOX-070 | ADAPT | Default export and import format per user; a URL parameter may choose another. | IN (FR-IO-011) |
| FR-IOX-071 | KEEP | CSV options: header, NULL text, separator, enclosure, escape, terminator, CRLF removal; PHP detail dropped. | IN (FR-IO-006) |
| FR-IOX-072 | ADAPT | Excel-compatible CSV: semicolon, CRLF, double quote, optional headers, NULL as NULL, line breaks in values as LF. Mac Excel variants not offered. | IN (FR-IO-006) |
| FR-IOX-073 | KEEP | Correct value formatting for NULL, numbers, binary hex, BIT, geometry, strings; INSERT, REPLACE and UPDATE statement types. | IN for INSERT, INSERT IGNORE, REPLACE (FR-IO-005); UPDATE statements DEFER (need a key choice, no demand) |
| FR-IOX-075 | ADAPT | JSON as one array: header object with DBLoom and version, then database and table objects with rows as objects; NULL as null; binary and geometry as 0x hex strings. | IN (FR-IO-007) |
| FR-IOX-084 | KEEP | Skip tables larger than a given size on database export. | IN (FR-IO-003) |
| FR-IOX-085 | ADAPT | ZIP entries named after the export file; separate-file mode inserts the object name before the extension. | IN (FR-IO-008) |
| FR-IOX-086 | ADAPT | Expand filename tokens, sanitise, add the extension when missing. | IN (FR-IO-009) |
| FR-IOX-087 | KEEP | Server, database and table scope with selection of databases, tables and structure or data; views after tables. | IN (FR-IO-002, 005) |
| FR-IOX-088 | KEEP | CSV parser with configurable terminator, enclosure, escape and line end, validated parameters, errors shown inline. | IN (FR-IO-018) |
| FR-IOX-092 | ADAPT | LOAD DATA CSV only at table scope; refuses compressed, pasted and charset-converted input. | DEFER (with FR-IOX-046, Q2) |
| FR-IOX-095 | ADAPT | Clear upload errors: too large, partial, missing, cannot be stored; no reference to server configuration files. | IN (FR-IO-012) |
| FR-PLG-005 | ADAPT | Export and import only in SQL, CSV and JSON; XML and LDI scope rules do not apply. | IN (FR-IO-002) |
| FR-PLG-006 | ADAPT | Formats listed alphabetically by localised label, ignoring case. | IN (FR-IO-002) |
| FR-PLG-011 | ADAPT | Rename databases, tables and columns in exports through aliases. | DEFER (rare; the writers take names from one place, so aliases can be added later) |
| FR-PLG-012 | ADAPT | Do not create a new database during import when a target database is already selected. | IN (FR-IO-018, 019) |
| FR-PLG-014 | ADAPT | Accept only known options, validated by type on the server; ignore unknown submitted options. | IN (FR-IO-002) |
| FR-PLG-016 | ADAPT | Pre-fill options with the last submitted values after a timeout reload, else with the saved setting. | IN (FR-IO-011) |
| FR-PLG-019 | ADAPT | SQL preselected for export unless the request names a format; default is a setting. | IN (FR-IO-011) |
| FR-PLG-020 | ADAPT | SQL preselected for import at server, database and table level; default is a setting. | IN (FR-IO-011) |
| FR-PLG-021 | ADAPT | Options panel per format; "This format has no options" when none. | IN (FR-IO-026) |
| FR-PLG-023 | ADAPT | Option controls by type: checkbox, text, number, select, radio, display text; hidden options not shown. | IN (FR-IO-026) |
| FR-PLG-024 | ADAPT | Documentation link beside an option that has one, opening the server's documentation. | IN (FR-IO-026; fixed host list, FR-SQL-030) |
| FR-PLG-057 | ADAPT | SQL, CSV and JSON for export and import, sorted by localised name, with gzip and zip. | IN (FR-IO-002, 008) |
| FR-SAU-073 | ADAPT | Import files only SQL, CSV or JSON; same check for server-folder files. | IN (FR-IO-002, 013) |
| FR-SAU-074 | ADAPT | Clear error when an uploaded file exceeds the limit. | IN (FR-IO-012) |
| FR-SRV-058 | ADAPT | Server-level SQL, export and import pages that work without a selected database. | IN for export and import (FR-IO-002, 016); the SQL page is OTHER: sql-tab |
| FR-UIX-075 | ADAPT | Drag-and-drop import: "Drop files here" overlay on the navigation panel and an upload status panel. | IN (FR-IO-025) |
| FR-UIX-076 | ADAPT | Dropped sql, csv and json files and their .gz and .zip forms accepted, case-insensitive; each uploads asynchronously with its own progress. | IN (FR-IO-025) |
| FR-UIX-077 | KEEP | Cancel in-flight uploads with status feedback. | IN (FR-IO-025) |
| INT-CC-021 | ADAPT | Import and export only in SQL, CSV and JSON, optionally gzip or zip; no XLSX, ODS, ODT, XML or PDF. | IN (FR-IO-002) |
| INT-PLG-001 | ADAPT | Server, database and table export pages with a format chooser and the options of the chosen format. | IN (FR-IO-026) |
| INT-PLG-002 | ADAPT | Export format checked at submit against the three formats. | IN (FR-IO-002) |
| INT-PLG-003 | ADAPT | Import format checked against the three formats before importing. | IN (FR-IO-002) |
| INT-PLG-004 | ADAPT | A query typed in the SQL editor, an uploaded SQL file or a bookmark runs as SQL; other imports use the selected format. | IN for the uploaded file; the editor and bookmarks are OTHER: sql-tab |
| INT-PLG-005 | ADAPT | Format options depend on where the user acts (scope); CSV import shows new-table fields only outside table import. | IN (FR-IO-018, 019, 026) |
| INT-PLG-006 | ADAPT | One format chooser and option panel style, options of each format kept apart; the schema (designer) export dialog depends on the designer decision. | IN for the panel; schema export DEFER (designer not decided) |
| NFR-CC-016 | ADAPT | Imports read in streamed chunks, memory bounded; limit independent of any runtime memory setting. | IN (FR-IO-012, 017) |
| NFR-IOX-023 | ADAPT | Long exports stream so browsers and proxies do not time out. | IN (FR-IO-001, 009) |
| NFR-IOX-052 | ADAPT | Import files read in chunks, memory bounded. | IN (FR-IO-012, 017) |
| NFR-IOX-055 | ADAPT | A large import that hits the time limit can be resumed from the offset where it stopped. | IN (FR-IO-020) |
| NFR-IOX-094 | ADAPT | Configurable maximum upload size shown on the import pages and enforced before accepting; server-folder files exempt. | IN (FR-IO-012, 022) |
| SEC-IOX-033 | ADAPT | Sanitise generated download file names so they cannot traverse directories or inject headers, then add the extension. | IN (FR-IO-009; character set widened by Q4) |
| SEC-IOX-096 | KEEP | Do not interpolate unescaped terminators, charset names or USE detection; validate or quote. | IN (FR-IO-018: parameters and allow-lists; no LOAD DATA in slice 1) |
| SEC-PLG-001 | ADAPT | Format names only from the fixed list. | IN (FR-IO-002) |
| SEC-PLG-002 | ADAPT | Server-side import only from a configured directory; traversal and symbolic links rejected. | IN (FR-IO-013) |
| SEC-PLG-003 | ADAPT | Option values only for options declared by the chosen format; others ignored. | IN (FR-IO-002) |
| SEC-SAU-304 | ADAPT | Never use a user-supplied file name on the file system; refer to files by identifier and confine paths. | IN (FR-IO-012, 013) |
| SEC-SAU-305 | ADAPT | Import file only from the import form or the server import folder; symbolic links and unreadable files rejected. | IN (FR-IO-012, 013) |
| SEC-SAU-307 | ADAPT | Downloads as attachments with sanitised name, correct content type, length when known, no-cache headers. | IN (FR-IO-009) |
| UI-IOX-018 | ADAPT | Quick export (one click, format defaults) and Custom export (all options); the chosen mode is a user setting, Quick the default. | IN (FR-IO-026) |
| UI-IOX-019 | KEEP | Format dropdown with an option panel per selected format. | IN (FR-IO-026) |
| UI-IOX-020 | KEEP | Single-table export with row range, record count and LIMIT. | IN (FR-IO-002) |
| UI-IOX-021 | ADAPT | Custom export: text or file, output charset, gzip or zip, remembered template, separate files in a zip, skip tables over a size. | IN except output charset (DEFER, Q3) |
| DATA-IOX-036 | ADAPT | Named export templates saved, loaded, updated, deleted; per user and export type. | IN (FR-IO-011) |
| DATA-IOX-074 | ADAPT | SQL export defaults (structure and data, comments, backquotes, hex binary, UTC, transaction wrapper, INSERT, no DROP or CREATE DATABASE) as settings. | IN (FR-IO-004, 011) |
| DATA-IOX-083 | ADAPT | General export defaults: SQL, quick, no compression, single file; file name template from table, database and server. | IN (FR-IO-011; "no saving on the server" holds by FR-IOX-030 DROP) |
| DATA-IOX-089 | ADAPT | Import defaults from settings: SQL, skip 0, interruption allowed, CSV comma and double quote, auto line ending, no header row. | IN (FR-IO-011, 018) |
| DATA-PLG-001 | ADAPT | Default values of export and import options are DBLoom settings, not a configuration file. | IN (FR-IO-011) |
| DATA-PLG-003 | ADAPT | Export in SQL, CSV and JSON from a fixed built-in list, gzip and zip kept. | IN (FR-IO-002) |
| DATA-PLG-004 | ADAPT | Import SQL, CSV and JSON from a fixed built-in list, gzip and zip kept. | IN (FR-IO-002) |
| FR-CFG-079 | ADAPT | Configurable temporary directory for uploads and exports, restricted permissions, created on first use, OS temp as fallback. | IN (FR-IO-012; ENV-only path, ST-155) |

### 2.2 Upstream (file 14) and issue requirements (files 16, 17) — 39 rows

| ID | Disp | DBLoom wording (one line) | Where |
|---|---|---|---|
| DATA-ISS-001 | PROPOSED | An export never silently ends partial or corrupt; every error is reported; default is stop with a clear error, the user may choose to skip unreadable objects with a list of what was skipped. | IN (FR-IO-010) |
| DATA-ISS-002 | PROPOSED | Export streams and works for tens of thousands of tables and many triggers as a background job with progress; no request per object. | IN (FR-IO-001, 003) |
| DATA-ISS-003 | PROPOSED | Export of a result honours the user's query exactly (LIMIT, WITH, selected rows); file-name tokens use real or aliased names; a multi-database export has a defined name. | IN for statements and names (FR-IO-003, 009); selected rows come through the rows hook (DEFER, with DATA-ISS-101) |
| DATA-ISS-004 | PROPOSED | Export round-trips: utf8mb4 (CJK) survives, expression index parts and generated columns exported in full, user-account exports include the CREATE USER statements. | IN for data and structure (FR-IO-004, 027); account export is OTHER: server |
| DATA-ISS-005 | PROPOSED | Resuming an import continues exactly where it stopped: offset counts bytes, session settings (charset, SQL mode, FK checks) applied again on every resumed part. | IN (FR-IO-020) |
| DATA-ISS-006 | PROPOSED | CSV import reports problems per column (rejected or over-long names, a delimiter that merges columns) and never reports success when part of the file was rejected. | IN (FR-IO-018) |
| DATA-ISS-008 | PROPOSED | Import and export support gzip, bzip2, zip, xz and zstd where the runtime offers them, and say which are available. | IN for gzip and zip, and the format list reports what is available (FR-IO-008, 014); xz, zstd DEFER (not in Node 22.13); bzip2 DROP |
| DATA-ISS-101 | PROPOSED | Export of selected rows together with all rows related through foreign keys, recursively, cycle-safe, in importable order. | DEFER (second slice; needs the row selection hook of `rows` and a related-row walker; Q8) |
| DATA-ISS-103 | PROPOSED | An export in a compatibility mode contains complete table definitions, or the mode is not offered; a test compares column counts. | IN (FR-IO-004: no compatibility modes are offered; test in FR-IO-027) |
| DATA-ISS-105 | PROPOSED | Export of a query result quotes values by the column types reported for the result set, including DISTINCT, computed and aliased columns; the file of a DISTINCT query imports again. | IN (FR-IO-005, 027) |
| DATA-ISS-106 | PROPOSED | An export made with IF NOT EXISTS imports again safely: foreign keys and other later ALTERs skipped or conditional, or DROP TABLE IF EXISTS first. | IN (FR-IO-004, 005) |
| DATA-ISS-107 | PROPOSED | CSV import option "first row contains column names", used to name columns of a new table and to map columns of an existing one. | IN (FR-IO-018, 019) |
| DATA-ISS-111 | PROPOSED | Export of selected routines offers the same optional DROP statement as the database export, before each CREATE. | IN (FR-IO-004) |
| DATA-ISS-116 | PROPOSED | An import with bytes invalid in the selected charset stops with the byte offset or line and statement number and writes no partial result; legacy single-byte charsets convert all characters. | IN (FR-IO-015) |
| DATA-ISS-120 | PROPOSED | Exported view and routine definitions are the server's own SHOW CREATE text, not regenerated, so they re-import unchanged on both products. | IN (FR-IO-004) |
| DATA-ISS-126 | PROPOSED | CSV exports served as text/csv and JSON as application/json, in the download headers and file metadata. | IN (FR-IO-009) |
| DATA-ISS-127 | PROPOSED | SQL export option: keys, indexes and AUTO_INCREMENT inside CREATE TABLE so a one-table file recreates the table alone; option to emit each table's create, data and key statements together. | IN (FR-IO-004) |
| DATA-ISS-130 | PROPOSED | A SQL export of several tables writes referenced tables first, ties by name (byte-identical output for identical schemas); a foreign-key cycle gives a warning and the cycle's keys as ALTER statements. | IN (FR-IO-005) |
| DATA-ISS-132 | PROPOSED | CSV export option to write a UTF-8 byte-order mark once at file start, off by default. | IN (FR-IO-006) |
| DATA-ISS-134 | PROPOSED | Export converted to a non-UTF-8 charset: visible replacement character with a count, or stop with a clear message; never an internal error. | DEFER (exports are UTF-8 only in slice 1; Q3) |
| DATA-ISS-136 | PROPOSED | MariaDB system-versioned tables: option, off by default, to include all historical rows; hidden where unsupported. | DEFER (system versioning is deferred in `structure`, FR-TGT-240) |
| DATA-ISS-137 | PROPOSED | CSV bulk-load accepts each charset the server supports and names the real cause when one cannot be used. | DEFER (with LOAD DATA, Q2; the INSERT path decodes in Node, FR-IO-015) |
| FR-ISS-113 | PROPOSED | Starting an import shows target server, database and file name and needs explicit confirmation before the first statement; a script with no database selected and no USE is refused. | IN (FR-IO-016) |
| FR-ISS-119 | PROPOSED | Server notes from import statements (such as note 1031) are shown as notes, not warnings; the import is successful when no statement failed. | IN (FR-IO-017) |
| NFR-ISS-102 | PROPOSED | Importing a dump (analysis pass included) takes at most 3 times the mysql client's time for the same file; a test with a 100 MB dump measures it. | IN as a measured benchmark that reports the ratio (FR-IO-017); factor 3 DECIDED (owner, 2026-10-27); measured 1.9 to 2.1 (2.3 to 2.7 with analysis): met |
| NFR-ISS-104 | PROPOSED | During an import the session holds only progress metadata, at most 4 KB growth whatever the file size. | IN (FR-IO-001) |
| UI-ISS-001 | PROPOSED | Long operations show progress, overall and per table where known, then what happened and a link back or to the next step. | IN (FR-IO-001, 026) |
| DATA-UPD-001 | upstream | Geometry and binary values exported in the XML, PHP, MediaWiki, Texy!, CSV, YAML and LaTeX formats; PDF shows [GEOMETRY] and [BLOB]; geometry unquoted. | IN for SQL, CSV and JSON (FR-IO-005, 006, 007); the other formats DROP |
| DATA-UPD-002 | upstream | Trigger exports include DELIMITER $$. | IN (FR-IO-004) |
| DATA-UPD-003 | upstream | Data-only exports skip CREATE DATABASE. | IN (FR-IO-004) |
| DATA-UPD-004 | upstream | Export file names allow more characters; compressed columns detected on MariaDB. | IN (FR-IO-009 and Q4; compressed columns come with the server's SHOW CREATE text, FR-IO-004) |
| DATA-UPD-005 | upstream | A CSV with more decimals than the column has causes no error. | IN (FR-IO-018; observed, spike 0: the server rounds silently under strict mode) |
| DATA-UPD-006 | upstream | A CSV column whose content exceeds the maximum length becomes TEXT, not VARCHAR. | IN (FR-IO-019) |
| DATA-UPD-007 | upstream | XML import keeps numeric strings as strings, works with no database selected, handles binary and geometry. | DROP (XML is not offered; the JSON analogue, exact numbers as text and hex for binary, is FR-IO-018) |
| DATA-UPD-013 | upstream | INSERT IGNORE INTO supported for imports that are not table imports. | IN (FR-IO-018 option "skip duplicates"; SQL files run as written) |
| DATA-UPD-014 | upstream | JSON exports use content type application/json. | IN (FR-IO-009) |
| DATA-UPD-015 | upstream | ODS exports include column headers by default. | DROP (ODS is not offered; the CSV header default is FR-IO-006) |
| FR-UPD-004 | upstream | An invalid configured export format no longer silently becomes sql. | IN (FR-IO-002, 011: invalid stored default is reported and replaced visibly) |
| UI-UPD-011 | upstream | Export as text has a copy-to-clipboard button. | IN (FR-IO-009) |

### 2.3 Target requirements and settings (files 11, 12) — 14 rows

| ID | Disp | DBLoom wording (one line) | Where |
|---|---|---|---|
| SEC-TGT-071 | in force | Upload and import enforce size, decompression-size and ratio limits, a type allow-list, random temp names and no client-supplied paths; server file reading off by default and ENV-only; no server-side saving of exports. | IN (FR-IO-012, 013, 014) |
| SEC-TGT-072 | in force | Export file names derived safely from sanitised input; content type and Content-Disposition set explicitly. | IN (FR-IO-009) |
| SEC-TGT-154 | PROPOSED | Import never places client text into SQL except as parameters or through the central identifier quoter; terminators, enclosures and charset names from fixed allow-lists. | IN (FR-IO-018, 019) |
| SEC-TGT-155 | PROPOSED | Charset conversion uses a streaming decoder with state across chunks; the connection charset is fixed by the adapter. | IN (FR-IO-015) |
| ST-111 | file 12 | Import/export job wall-clock limit: UI within ENV bounds, F 60 s, D 900 s, C 7200 s. | IN (FR-IO-022) |
| ST-150 | file 12 | Max upload size: effective = min(UI, ENV max, proxy body limit); F 1 MiB, D 64 MiB, C 2 GiB; the UI shows the effective minimum. | IN (FR-IO-022) |
| ST-151 | file 12 | Compression ratio 100:1, 1 entry per archive, no nesting (ENV-only); decompressed size cap F 1 MiB, D 1 GiB, C 4 GiB. | IN (FR-IO-014, 022) |
| ST-152 | file 12 | Enabled import and export formats: UI within ENV bounds, detection by content. | IN (FR-IO-002, 022) |
| ST-153 | file 12 | Server-side file import: ENV-only to enable, default off, UI may disable, directory ENV-only. | IN (FR-IO-013) |
| ST-155 | file 12 | Temp and cache directories, temp-disk quota ENV-only (mode 0700, hourly sweep); concurrent imports per user F 1, D 1, C 3. | IN (FR-IO-012, 022) |
| ST-156 | file 12 | Export defaults (format, compression, charset) and file name template: user preference within admin limits; name always sanitised. | IN (FR-IO-009, 011); charset default is UTF-8 only (Q3) |
| ST-157 | file 12 | Formula-injection neutralisation of CSV cells: default on; prefix set = + - @ TAB CR; administrator may remove the user's opt-out. | IN (FR-IO-006, 023) |
| ST-158 | file 12 | Max export size F 1 MiB, D 1 GiB, C 8 GiB; exports stream; truncation announced. | IN (FR-IO-010, 022) |
| ST-160 | file 12 | Import option defaults (FK checks and so on): user preference within admin limits; administrator may force FK checks on. | IN (FR-IO-011, 017) |

### 2.4 New requirements (PROPOSED)

| ID | Statement | Verification |
|---|---|---|
| FR-IO-001 | **Job model.** Export and import run as jobs in the Node process. A job has an opaque id, owner (session and DBLoom user), kind, state (`queued`, `running`, `done`, `failed`, `cancelled`, `paused`), progress (bytes read or written, rows, object `i` of `n` with its name) and a bounded result. The session holds only job ids; the progress record is read by polling and never grows with the file (at most 4 KB per job, NFR-ISS-104). Jobs stream: nothing is held in memory beyond a chunk (NFR-IOX-023, 052). Per user at most `imports` concurrent imports (ST-155, default 1) and 2 exports; further starts are refused with `busy`. Cancel stops the job, issues `KILL QUERY` on the dedicated connection and destroys it. A job and its staged files are removed 24 hours after its end. | Unit (state machine); integration: 200 MB import keeps process memory flat; job record size test. |
| FR-IO-002 | **Typed requests.** Every request is a zod object. Format is one of `sql`, `csv`, `json` (`ST-152` may remove formats, never add); compression one of `none`, `gzip`, `zip`; scope one of `server`, `database`, `tables`, `table`, `result`. Scope parameters are existing names checked against the catalog (SEC-TGT-116). Options are a closed object per format; unknown keys are rejected, values are never coerced to a default (invalid format, mode or number is an error, FR-UPD-004). Table scope accepts a row range (`offset`, `count`, both bounded integers) and an optional filter tree of `rows` (FR-ROW-008). No request has a `sql`, `where`, `order` or path field except `result`, which names a SQL-tab statement (FR-IO-003). | Schema tests; request with unknown option, `sql` field or format `xml` refused. |
| FR-IO-003 | **Export source and consistency.** A database or server export reads through one dedicated connection. Default: `START TRANSACTION WITH CONSISTENT SNAPSHOT` (InnoDB sees one point in time; non-transactional tables are read as they are and the result says so). Option "lock tables" issues `LOCK TABLES ... READ` with release in `finally`. Scope `result` calls `openResultStream` of FR-SQL-026 (text, statement index; class none and `readOnlySafe` only) and writes the rows with the column types the result reports. Tables larger than the optional `maxTableMiB` (from `information_schema` data length) are skipped and listed. Row reads use the text protocol with exact strings for numbers and dates (no JS number rounding, `rows/codecs.ts`). | Integration: row changed during an export does not appear (snapshot); lock released after cancel; 200 000-row `seq` result streams flat. |
| FR-IO-004 | **SQL dump content.** Header comment (DBLoom and server version, time, optional custom text), then session settings that make the file self-contained (`SET NAMES utf8mb4`, `time_zone='+00:00'`, `foreign_key_checks=0`, `unique_checks=0`, `sql_mode` set to `NO_AUTO_VALUE_ON_ZERO`; the previous values are restored at the end), then per object: optional `DROP ... IF EXISTS` (also for selected routines, DATA-ISS-111), the server's own `SHOW CREATE` text for tables, views, routines, triggers, events (not regenerated, DATA-ISS-120), data. Options: structure/data/both, `CREATE DATABASE` (+`USE`) and `DROP DATABASE`, `IF NOT EXISTS`, keys and AUTO_INCREMENT inside CREATE TABLE or as later ALTERs (DATA-ISS-127), table AUTO_INCREMENT value, comments, transaction wrapper, extended inserts with a byte cap (default 1 MiB per statement), routines, triggers, events, views. Triggers and routines are wrapped in `DELIMITER $$` ... `DELIMITER ;`, which the importer's own splitter understands (DATA-UPD-002). Data-only exports contain no `CREATE DATABASE` (DATA-UPD-003). No compatibility modes are offered (DATA-ISS-103). `IF NOT EXISTS` plus later ALTER statements are written conditionally or the foreign keys go into CREATE TABLE where no cycle exists (DATA-ISS-106). | Golden-file tests per product; column-count comparison export vs source; re-import on the same product. |
| FR-IO-005 | **SQL values and order.** NULL as `NULL`; integers and exact decimals as given; floats via `repr` round-trip text; strings escaped by one `quoteLiteral` that is correct with and without `NO_BACKSLASH_ESCAPES`; binary types and BLOBs as `0x...` hex (`''` empty); BIT as `b'..'`; geometry as hex of the server's internal value (observed, spike 0: `HEX(col)` written back as `0x...` re-imports on both products); JSON as a string literal; date and time as the server's string; generated columns are not written (DATA-ISS-102 style). Statement type `INSERT`, `INSERT IGNORE` or `REPLACE`. Result export uses the types the result reports, also for DISTINCT, computed and aliased columns (DATA-ISS-105). Order: databases by name; within one database tables in foreign-key dependency order (referenced first), ties by name, so identical schemas give byte-identical files; a cycle gives a warning in the result and its foreign keys as `ALTER TABLE ... ADD CONSTRAINT` after all data; views after tables, ordered by view dependency (Q7); then routines, triggers, events (DATA-ISS-130). | Unit with hostile strings and a `NO_BACKSLASH_ESCAPES` session; golden order test with a cycle. |
| FR-IO-006 | **CSV export.** One table or result per file. Options: separator, enclosure, escape, line terminator (`LF`, `CRLF`), NULL text (default empty; `NULL` in the Excel preset, section 5.4), header row (default on), UTF-8 BOM (off, once at file start, DATA-ISS-132), remove line breaks inside values, Excel preset (semicolon, CRLF, double quote, header on, NULL as `NULL`, line breaks in values as LF; a preset of the options, FR-IOX-009). Separators, enclosures and escapes come from fixed allow-lists (single characters from `, ; TAB | :` for the separator and `" '` or none for the enclosure). A database or tables scope in CSV is a zip with one file per table (FR-IO-008). Formula neutralisation per FR-IO-023. | Round trip through the importer; Excel preset snapshot; BOM test. |
| FR-IO-007 | **JSON export.** One top-level array. First element `{"type":"header","generator":"DBLoom","version":"x.y.z"}`, then `{"type":"database","name":...}` and `{"type":"table","database":...,"name":...,"columns":[{name,type}],"data":[{col:value,...}]}` objects. Written by a streaming writer (no `JSON.stringify` of the whole table). NULL is `null`; numbers that do not fit an IEEE double (BIGINT, DECIMAL) are JSON strings; binary and geometry are `"0x..."` strings; options pretty-print and keep-unicode (default on). Content type `application/json`. | Parse of the output; 10 000-row stream; BIGINT exactness test. |
| FR-IO-008 | **Compression and zip.** `gzip` streams through `zlib.createGzip` with a flush per chunk. `zip` uses `fflate`'s streaming zip: one entry per file, deflate, UTF-8 names, no ZIP64: an entry or an archive over 4 GiB - 1 is refused with `export_too_large` and the hint to use gzip or no compression (observed, spike 0 and task 12: entries of unknown size stream with a data descriptor and the UTF-8 name flag is set; `fflate`'s streaming writer does not write ZIP64, an entry of 4 GiB + 1 byte is recorded as 1 byte, so the writer stops at the limit; section 5.11). Entry names follow the export file name; "separate files" writes one entry per table, view or section named `<base>_<object>.<ext>` taking the extension from the last dot (FR-IOX-085). Which codecs are available is reported by `getIoCapabilities` and the UI lists only those (DATA-ISS-008). | Unzip with `node:zlib` reader and with the system `unzip` in CI; The 4 GiB limit is covered by a unit test with a small limit; `node scripts/io-spike.mjs zip64` repeats the 4 GiB + 1 measurement (about 70 s). |
| FR-IO-009 | **Delivery.** `GET /api/io/download/<jobId>` (session cookie, CSRF-safe because it is GET without side effects beyond reading the job's own output) streams the output with `Content-Disposition: attachment; filename="<ascii>"; filename*=UTF-8''<encoded>`, explicit `Content-Type` (`application/sql`, `text/csv; charset=utf-8`, `application/json`, `application/gzip`, `application/zip`), `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, no `Content-Length` unless known. Text mode (not for zip) returns at most 2 MiB to a read-only view with a copy action and a notice when truncated; Refresh re-runs the same request. File name: template tokens (section 5.5), sanitised, extension added when missing (`.sql`, `.csv`, `.json`, plus `.gz` or `.zip`). | Header snapshot; file name `../x";.csv` becomes harmless; copy button test. |
| FR-IO-010 | **Honest failure.** If a query fails, the server limit is hit, a table is unreadable or the size cap (ST-158) is reached, the job ends `failed`, the HTTP stream is aborted (never closed cleanly), the browser shows a failed download, the result names the object and the server message, and a partial output is never offered as complete. Option "skip unreadable objects" continues, writes a comment `-- skipped: <name>` (SQL) or a `{"type":"skipped"}` element (JSON), and lists the skips in the result with status `done_with_skips`. Cancel ends `cancelled` the same way (G4). | Integration with a table the user cannot read; abort test with a mid-stream error. |
| FR-IO-011 | **Defaults, templates, last values.** Per user (owner key as in sql-tab): default export format and compression, default import format, mode Quick or Custom, file name template per scope, per-format option defaults, and named export templates (name unique per owner and kind, at most 50, options only, no secrets). Resolution as in file 12: `.env` limits, UI preference inside them, built-in default. The form shows the last submitted values after a reload. A stored default that fails the schema is reported once and replaced by the built-in default visibly. Stateless mode: session memory only, same limits. | Store test; stale default test. |
| FR-IO-012 | **Upload and staging.** `PUT /api/io/upload` takes the file as the raw request body (no multipart parser, no buffering), with the display name and declared format in query parameters, CSRF header required. The server enforces `Content-Length` against the upload limit before reading and counts bytes while reading (a lying or missing length is cut off at the limit). The body streams to a random-named file (`<tmp>/<32 hex>`), mode 0600, in the ENV temp directory (0700, outside the web root, hourly sweep, total quota; ST-155), and is referred to only by an upload id bound to session and user. The display name is kept as metadata for messages, never as a path (SEC-SAU-304). Errors map to the closed list: too large, interrupted, empty, quota full, cannot be stored, with the effective limit in the message; no mention of server configuration files (FR-IOX-095). Browser clients use `XMLHttpRequest` for upload progress and abort. | Integration: oversize, lying length, aborted upload (staged file removed), 0-byte file. |
| FR-IO-013 | **Server import folder.** Off by default; enabled only by `.env` (`DBLOOM_IMPORT_DIR`, ST-153); the UI may only switch it off. A listed file is addressed by an id built from a listing of the folder; the resolved real path must be inside the real folder, must be a regular file (no symbolic link at any component), readable, and is opened with a no-follow check; names are never taken from the client. These files are exempt from the upload limit, not from the decompression, ratio and job limits. | Tests with `..`, absolute path, symlink out, symlink in. |
| FR-IO-014 | **Compression on import.** The type is detected from the first bytes (gzip `1f 8b`, zip `PK`), not the extension. gzip is streamed through `zlib.createGunzip` with a byte counter; zip is read from the staged file's central directory: exactly one entry allowed (`ST-151`), no nested archive (the entry is sniffed again and refused if it is an archive), encrypted or multi-disk archives refused. Decompression stops with a clear error when the output exceeds the decompressed-size cap or the compression ratio exceeds 100:1 (measured on a rolling window, so a bomb is stopped early). | Zip bomb fixture (ratio), two-entry zip, zip inside zip, truncated gzip. |
| FR-IO-015 | **Charset and BOM.** The staged stream is decoded with `TextDecoder` in streaming mode (`{stream:true}`) so a multibyte character split at a chunk boundary decodes correctly. Default `utf-8`; a UTF-8 or UTF-16 BOM selects and is removed (FR-IOX-050); otherwise the user picks from the names `TextDecoder` supports, shown with display names (windows-1252, ISO-8859-x, Shift_JIS, GBK, Big5, EUC-KR, ...). Fatal mode is on: an invalid byte stops the import with an error giving the byte offset, the line and the statement or row number, before that statement runs and with no partial result for CSV and JSON (DATA-ISS-116). The connection charset is `utf8mb4`, set by the adapter, never from user input (SEC-TGT-155). | Property test: same text, chunk boundaries at every offset, identical result; invalid byte test. |
| FR-IO-016 | **Analyse, then confirm.** After upload `analyseImport` streams the file once without executing anything and returns: detected compression and format, size, file name, statement count by class (SQL; classes of FR-SQL, `none`, `soft`, `hard`, refused), the databases it creates, drops or uses, whether it selects a database, for CSV and JSON the first rows, detected columns and row count. A SQL script that needs a database but has neither a selected database nor a `USE` or `CREATE DATABASE` before the first table statement is refused with a message asking to select one (FR-ISS-113). The user then confirms in a dialog that names the server, the database and the file; if any statement is `hard` the dialog states the count and kinds, and `startImport` needs the server-issued confirmation token (HMAC over session, user, target, upload id, analysis hash, expiry, single use; SEC-TGT-118, ST-120). Refused-tier statements (section 5.7) make the start impossible unless the option "skip refused statements" is chosen; account statements are `hard` and listed by kind and count. Read-only mode refuses analysis start, not the analysis itself. | SCN-053, 054; direct call without token refused; analysis does not change the target (statement log). |
| FR-IO-017 | **SQL import run.** The importer reads the decoded text with its own incremental splitter (shared with `sql/parser.ts` rules: quotes, backticks, comments including `/*! ... */`, `DELIMITER`), classifies each statement, and runs it on one dedicated connection (`multipleStatements` stays false; this connection is destroyed at the end, so a `USE` or `SET` inside the script cannot leak into the pool). Options: skip first N statements, ignore errors (continue and count), rollback on error (only helps transactional tables and is said so), disable foreign key checks (default from ST-160; restored in `finally`, also by destroying the connection). On the first failing statement without ignore-errors the job stops with the statement (first 2 000 characters, escaped), its number, byte offset, line and the server's number and message. Server notes (e.g. 1031) are shown as notes, not warnings (FR-ISS-119). The time limit (ST-111) stops cleanly between statements and moves the job to `paused` with its resume point (FR-IO-020). Result: statements run, skipped, failed, notes, duration, source file name. | SCN-055, 056, 058; dump of 100 MB imports with flat memory and the benchmark ratio against the `mysql` client is printed (NFR-ISS-102). |
| FR-IO-018 | **CSV and JSON import into a table.** Mapping step: file columns (CSV header row if the option is set, else positions; JSON keys of the first 1 000 rows) to table columns, each target column chosen from the catalog, "skip" allowed, generated columns not offered. Options: CSV separator, enclosure, escape, line terminator or auto, NULL text, skip first N rows, header row (DATA-ISS-107); conflict handling `error` (default), `ignore` (INSERT IGNORE) or `replace` (REPLACE); "skip duplicates" is `ignore`. Rows are parsed by a streaming parser, converted by `rows/codecs.ts` (exact numbers, hex for binary, dates as given), and inserted with multi-row prepared `INSERT` batches (up to 500 rows or the packet budget) with values only as parameters and identifiers only through `quoteIdent` (SEC-IOX-096). Mode `all or nothing` (default): one transaction, rollback on the first error; mode `keep going`: commit per batch and collect rejected rows with their number and cause. A parse problem (merged columns from a wrong delimiter, a row with the wrong field count, an over-long value) is reported per column and row (first 100 shown, count kept) and the job does not end `done` when any row was rejected (DATA-ISS-006). Decimals with more places than the column are rounded by the server with a note (DATA-UPD-005; observed, spike 0: `1.239` into `DECIMAL(5,2)` stores `1.24` without error under `STRICT_ALL_TABLES` on both). JSON: array of objects (the DBLoom export shape is detected and its `table` element can be chosen) or array of arrays; numbers are read with an exact-number parser so BIGINT and DECIMAL keep their digits. The target table must exist, the user is not asked for a database name when one is selected (FR-PLG-012). | SCN-057, 059; hostile terminators, quotes and `'; DROP` content change nothing outside the table. |
| FR-IO-019 | **Import into a new table.** At database scope a CSV or JSON file can create a table: names from the header (or `col_1...`), types inferred from a sample of the first 10 000 rows (integer width, unsigned, decimal(p,s), datetime, date, time, `VARCHAR(n)` up to 255, `TEXT` above, `LONGTEXT` above 65 535, `JSON` never inferred, everything unclear stays text, DATA-UPD-006), every column nullable, no keys. The user reviews and edits the proposed columns; creation goes through `structure` (`buildStatements` and its plan, FR-STR-002), never through a string built here; the plan is shown as SQL before it runs (FR-STR-003), then the rows are imported as in FR-IO-018 into the new table. A failed import offers to drop the new table, as a normal hard-class drop. | SCN-060; 64-character, duplicate and reserved-word column names handled. |
| FR-IO-020 | **Resume.** When an SQL import stops on the time limit or a transient error, the job keeps `{uploadId, decodedByteOffset, statementNumber, options}` after the last fully run statement (not the last read one). `resumeImport` re-opens the staged file, re-decompresses and skips to the byte offset (bytes of the decoded UTF-8 stream, not characters, DATA-ISS-005), opens a new dedicated connection and applies the session settings again (charset, `sql_mode`, FK checks, `time_zone`, the same `USE` as the job's current database). The same confirmation applies once; no second token is needed for a resume of the same analysed file. CSV and JSON resume by row number. A resume after the staged file was swept is refused with "file no longer available, upload again". | Import 100 MB with limit 10 s: three resumes give the same table as one run (checksum). |
| FR-IO-021 | **Guard and audit.** Import calls `assertWritable` before anything else (read-only refuses without opening a target connection); export does not. Each job writes audit lines: start (kind, scope, format, compression, option summary, database, object names, file name, size), per-statement class counts at the end, end (state, rows or statements, bytes, duration, error number). No row values, no statement text (a failing statement is identified by hash and number), no credentials. Cancel and resume are events too. Read-only forced by `.env` cannot be bypassed by a field. | Log capture test: no cell value in the log. |
| FR-IO-022 | **Limits resolver.** `resolveIoLimits(session)` returns: upload size (ST-150, min of UI, ENV, a proxy-body-limit hint), decompressed size and ratio (ST-151), job wall-clock limit (ST-111), max export size (ST-158), concurrent imports (ST-155), enabled formats and compressions (ST-152), server import folder switch (ST-153), formula neutralisation default (ST-157). Until the settings module exists it reads `Config` defaults; each value is the minimum or intersection of the `.env` bound and the user preference. The import page shows the effective upload limit and, in text, the reason when it comes from `.env`. | Unit test of the resolver; page shows 64 MiB by default. |
| FR-IO-023 | **Output safety.** CSV cells that start with `=`, `+`, `-`, `@`, TAB or CR are prefixed with a single quote by default (ST-157; per-export checkbox if the administrator permits; not applied to numbers that are negative numerals in numeric columns). SQL, JSON and CSV values are never interpreted as HTML anywhere in the pages; the text view is a text node; names, file names and server messages are escaped on output (SEC-TGT-112). The result of a job shows server text as text only. | Cell `=HYPERLINK("x")` exported and shown; `<img onerror>` in a file name and in a server message. |
| FR-IO-024 | **After an import.** A successful or paused import that ran `CREATE`, `DROP`, `ALTER` or `RENAME` emits `structure.changed {db, table?, kind}` per affected object (from the classifier facts, at most 200 events, then one `{db}` event); a data import invalidates the table's row cache (`rows` queries). Both are client invalidations as in FR-SQL-025. | Sidebar shows an imported table without reload. |
| FR-IO-025 | **Drag and drop.** When enabled in the user's preferences, dropping files on the navigation panel shows the overlay "Drop files here" and an upload status panel (file count, minimise, close). Accepted extensions `.sql`, `.csv`, `.json` and their `.gz` and `.zip` forms, case-insensitive (others rejected with the reason). Each file has its own `XMLHttpRequest` upload with a progress bar and a cancel button that aborts the request and removes the staged file; after upload the file opens in the import dialog of the current database (or server). Keyboard path: the same dialog has a file picker. | Playwright: drop two files, cancel one. |
| FR-IO-026 | **Pages and dialogs.** Export and import open as centre tabs (kind `io`) from the tree menus (server, database, table), the table toolbar (hook of `rows`) and the SQL result "Export" button. Export: Quick (one click, defaults, a summary line of what will be produced) and Custom (scope selection with search, format chooser with a panel per format, compression, file name template with token help, text or file, templates, skip large tables, separate files). Import: file choice or drop, analysis result, options per format, mapping step for CSV and JSON, confirmation, progress, result. Progress shows overall and per table where known, then what happened and links back to the page it started from or to the next step (UI-ISS-001). Format option panels render from one option registry (type: boolean, text, number, select, radio, note), each option with an optional documentation link on a fixed host list. All text through `t()`. Design rules: `apple-design` and `design-taste-frontend` (app rules) as for `rows`. | Component tests; axe; Playwright SCN-052 to SCN-063. |
| FR-IO-027 | **Round trip.** Export of a scratch database in SQL, imported into a fresh database on the same product, gives identical `SHOW CREATE TABLE` (modulo AUTO_INCREMENT and the database name) and identical row checksums (`CHECKSUM TABLE` or an ordered hash) for a fixture with: all column types, CJK text, emoji, binary, BIT, JSON, geometry, generated columns, a foreign-key cycle, views, a trigger, a routine, an event, `NULL`s, 100 000 rows. CSV and JSON round trip the rows of one table. A MySQL export imports on MariaDB and the reverse for the subset of the fixture both support. | Integration job `io-roundtrip` per product and cross. |

### 2.5 Deferred and other modules
- **DEFER inside io:** LOAD DATA import (Q2), export of selected rows with related rows (DATA-ISS-101), aliases (FR-PLG-011), non-UTF-8 export (Q3), `UPDATE` statement type, system-versioned history rows, xz and zstd, schema (designer) export, a "create database from file" shortcut.
- **OTHER: sql-tab:** pasted SQL, bookmarks and editor runs (FR-IOX-037, INT-PLG-004); the export hook `openResultStream` is theirs and used here.
- **OTHER: server:** export of user accounts with CREATE USER and grants (DATA-ISS-004 part); server-level SQL page.
- **OTHER: admin:** the settings UI for the ST rows of section 5.8; this module reads `Config` until it exists.
- **OTHER: rows:** the toolbar Export entry, the row selection hook for DATA-ISS-101.
- **DROP:** server-side saving of exports (FR-IOX-030), bzip2, XML, ODS and all formats except SQL, CSV and JSON.

## 3. Scenarios

Style and actors as in `19-scenarios.md`; numbering continues after SCN-051 of file 24. Test targets: `mysql:8.4` on port 33064 and `mariadb:10.11` on port 33061 (root/root, from `compose.test.yaml`), once per product unless a scenario says otherwise. Each Playwright test creates its own scratch database through the fixture (`e2e_<random>`, with `customer` of 1 000 rows where needed) and drops it in `afterEach`. Direct-mode login as in SCN-004. Files for uploads live in `e2e/fixtures/io/`.

### SCN-052 Quick export of a table (D)
*Actor:* developer with SELECT. *Before:* logged in; `e2e_x.customer` with 1 000 rows.
1. The user opens the table's menu, chooses Export, sees Quick mode with the summary "SQL, structure and data, no compression, `customer_e2e_x.sql`" and clicks Export.
*Accept when:* a download starts with `Content-Disposition` attachment, a sanitised name, `Content-Type: application/sql`; the file contains `CREATE TABLE`, 1 000 rows in extended `INSERT` statements and the `SET` header of FR-IO-004; the text view of the same request shows the same text and a working Copy button; the audit log has start and end lines with no cell value; with a read-only session the export still works (FR-IO-021).
*Requirements:* FR-IOX-001, 006, 022; FR-IO-002, 004, 009, 021; SEC-SAU-307; UI-UPD-011.

### SCN-053 Custom export of a database as zip with separate files (D)
1. In Custom mode the user selects database `e2e_x` (three tables, a view), format CSV, compression zip, "separate files", template `@DATABASE@_@TABLE@`, skips tables over 1 MiB, clicks Export.
*Accept when:* the zip contains one entry per table with the name pattern `e2e_x_<table>.csv` (view data included as CSV), a skipped table (fixture of 2 MiB) is listed in the result; CSV headers on; the system `unzip -t` passes; a template with `../` or `"` yields a name with only `[A-Za-z0-9_.-]` and Unicode letters; template saved per scope and offered next time (FR-IO-011); an invalid format value sent directly (`xml`) is refused with a clear error.
*Requirements:* FR-IOX-016, 032, 034, 035, 084, 085, 086; FR-IO-002, 006, 008, 009, 011.

### SCN-054 CSV and JSON specifics (D)
1. Export `customer` as CSV with the Excel preset and BOM on; then as CSV default with a cell `=cmd|' /C calc'!A1`; then as JSON pretty.
*Accept when:* the Excel file starts with the BOM once, uses `;` and CRLF, and NULL as `NULL`; the formula cell is prefixed with `'` by default and exported unchanged when the permitted opt-out is used; the JSON parses, starts with the header object, writes a BIGINT above 2^53 as a string and binary as `"0x..."`; content types are `text/csv; charset=utf-8` and `application/json`; re-importing the CSV with the header option restores the rows.
*Requirements:* FR-IOX-008, 009, 071, 072, 075; DATA-ISS-126, 132; FR-IO-006, 007, 023; ST-157.

### SCN-055 Failure and cancel of an export (D)
*Before:* a table the logged-in user cannot read, and a table with 2 000 000 rows (integration only).
1. The user exports the database with default options, then with "skip unreadable objects", then starts the large export and cancels it.
*Accept when:* the default run ends `failed`, the browser shows a failed download, the result names the table and the server message (error 1142) and no file is offered as complete; the skip run produces a file with `-- skipped: <name>` and the result lists the skip; cancel ends `cancelled`, the dedicated connection is gone from `SHOW PROCESSLIST` within 5 s and the staged output is removed.
*Requirements:* DATA-ISS-001; FR-IO-001, 010; G4.

### SCN-056 Import of an SQL dump with confirmation (D)
*Before:* an empty scratch database selected; fixture `dump.sql.gz` (gzip of an export from SCN-052 plus one `DROP TABLE IF EXISTS`).
1. The user drops the file on the navigation panel (or picks it), sees the analysis (SQL, gzip, 1 018 statements, 1 hard: `DROP TABLE`, target `e2e_x` on the shown server, file name), confirms.
*Accept when:* a start without the confirmation token (direct call) is refused and nothing ran; with it the import runs with progress, the result states the statement count and file name, notes (if any) are shown as notes, FK checks are back to their old value on the pool afterwards, the sidebar lists the new table without reload; a read-only session sees the Import entry but cannot upload (the page says why; the upload route and a direct `startImport` call return the refusal without a target connection); a script with no database selected and no `USE` is refused in the analysis; a `.sql` renamed `.png` is still handled by content, a plain text file renamed `.sql.gz` imports as plain SQL (FR-IO-014, by content; the analysis shows compression `none`), while a damaged archive (gzip or zip magic with a broken stream) is refused with `not_archive`.
*Requirements:* FR-IOX-040, 049, 056, 057, 058, 061; FR-ISS-113, 119; FR-IO-014, 016, 017, 021, 024.

### SCN-057 Import errors, ignore, skip, rollback (D)
*Before:* fixture with 100 statements, statement 50 violates a unique key, statement 80 is `SELECT 1/0`.
1. Run with defaults, then with "ignore errors", then with "skip first 60 statements", then with "rollback" on an InnoDB table.
*Accept when:* the default run stops at statement 50 with its text, number, line, byte offset, errno 1062 and message, and statements 1 to 49 are applied; "ignore errors" reports two failures and 98 executed; the skip run starts at 61; rollback leaves no row of the transactional table from before the failure and the message says DDL and non-transactional tables are not rolled back.
*Requirements:* FR-IOX-040, 056; FR-IO-017.

### SCN-058 Resume after the time limit (D, integration plus one Playwright)
*Before:* `.env` job limit lowered to 10 s for the test; 100 MB dump.
1. Start the import; it pauses at the limit; the user clicks Resume until done.
*Accept when:* each pause is between statements, shows how many statements and bytes are done, resume re-applies charset, `sql_mode`, FK checks and the current database; the final table checksum equals that of an uninterrupted import; a dump with multibyte text split at the pause point (byte offset test) gives identical data; after the staged file was deleted a resume says "file no longer available, upload again".
*Requirements:* NFR-IOX-055; DATA-ISS-005; FR-IO-017, 020; ST-111.

### SCN-059 CSV import into an existing table (D)
*Before:* `customer` empty; CSV with header, delimiter `;`, one quoted cell with a line break, one cell `'); DROP TABLE customer; --`, one row with too many fields.
1. The user uploads, sets separator `;`, header row on, maps columns, mode "all or nothing", imports; then repeats with "keep going".
*Accept when:* all-or-nothing rolls back and names row and column of the bad row, the job state is `failed`; keep-going imports the good rows, lists the rejected row, and the job state is `done_with_rejects` (never plain success, DATA-ISS-006); the hostile cell is stored as text and `customer` still exists; wrong separator is detected in the preview (merged columns warning); `replace` and `ignore` conflict modes behave per MySQL semantics; the upload limit message shows the effective limit when an oversize file is dropped.
*Requirements:* FR-IOX-041, 088, 095; DATA-ISS-006, 107; FR-IO-012, 018; SEC-IOX-096; SEC-TGT-154.

### SCN-060 CSV and JSON into a new table (D)
1. At database scope the user uploads a CSV (ids, decimals, dates, a 400-character text column, a column named `select`) and chooses "new table `imported`"; then a JSON array of objects.
*Accept when:* the proposed types are `BIGINT`/`INT`, `DECIMAL(p,s)`, `DATETIME`, `TEXT` for the long column and `VARCHAR` for short ones; the user edits one type; the preview shows the `CREATE TABLE` from the structure builder (not text built by io); execution creates the table then imports; `select` is quoted correctly; the JSON import keeps a 20-digit number exactly; a failed import offers "drop the new table" as a normal confirmed drop.
*Requirements:* FR-IOX-042; DATA-UPD-006; FR-IO-018, 019.

### SCN-061 Charset and BOM (D)
1. Import a CSV in `windows-1252` (umlauts), a UTF-16LE file with BOM and a UTF-8 file with BOM; then a file with an invalid byte for the chosen charset.
*Accept when:* the three files import with correct text and the BOM is not in the first column name; the invalid file stops with byte offset, line and row, and no row of it is stored; a unit test cuts a UTF-8 text at every byte offset and gets the same data.
*Requirements:* FR-IOX-050, 051; DATA-ISS-116; FR-IO-015; SEC-TGT-155.

### SCN-062 Upload and file safety (D)
1. Upload a file over the limit (with a correct and with a lying `Content-Length`), a zip bomb (1 MiB to 2 GiB), a zip with two entries, a zip inside a zip, a truncated gzip; abort an upload half way; list the server import folder when it is off and when `.env` enables it.
*Accept when:* each is refused with its own message, no staged file remains after an abort or a refusal, the effective limit is shown, disk use of the temp directory stays under the quota; with the folder off the server function answers "not enabled"; with it on, `../etc/passwd`, an absolute path and a symlink pointing out are refused and a regular file inside is listed and importable; staged files are mode 0600 and named by random hex.
*Requirements:* FR-IOX-048, 095; NFR-IOX-094; SEC-PLG-002; SEC-SAU-304, 305; SEC-TGT-071; FR-IO-012, 013, 014.

### SCN-063 Round trip and version differences (D, per product and cross)
1. Export fixture database (FR-IO-027) as SQL, import into a fresh database; then export MySQL and import into MariaDB and the reverse.
*Accept when:* `SHOW CREATE TABLE` and the row checksums match as defined; views, trigger, routine and event exist; the foreign-key cycle imports with FK checks restored; the cross-product runs import the common subset and the result lists the statements the target refused with the server message (no crash, no partial silence); an `IF NOT EXISTS` file imports twice without error (DATA-ISS-106); the benchmark prints the ratio to the `mysql` client.
*Requirements:* DATA-ISS-004, 103, 105, 106, 120, 127, 130; NFR-ISS-102; FR-IO-004, 005, 027.

## 4. Objective of the module spec in one line
The user takes data out as a file that comes back unchanged, and brings a file in only after seeing what it will do and confirming where it is destructive.

## 5. Design

### 5.1 Job flow
```
EXPORT  UI (typed request) -> io.startExport (zod, catalog check, limits) -> job {id}
          job: dedicated connection -> snapshot/lock -> writers (sql|csv|json) -> compressor (none|gzip|zip) -> output file in temp (spool, 0600)
          GET /api/io/download/<id>  streams the spool file (or tees live: Quick text mode and small jobs)   <- progress polled via io.getJob
IMPORT  PUT /api/io/upload (raw body) -> staged file + uploadId
          io.analyseImport {uploadId, format, charset?} -> sniff -> decompress -> decode -> scan (no execution) -> analysis {classes, db, rows sample}
          io.startImport {uploadId, options, mapping?, confirmToken?} -> assertWritable -> token check -> job
          job: dedicated connection -> session settings -> (SQL: split, classify, execute | CSV/JSON: parse, convert, batch INSERT) -> progress
          io.resumeImport {jobId} / io.cancelJob {jobId}
```
Export spools to a temp file by default so a dropped connection or a retry does not re-run the queries and so a failed job can discard its output; download then streams the file with back pressure. Quick mode with a single small table may tee directly. The size cap (ST-158) applies to the spool; spool and staged files count against the temp quota and are removed at job end plus 24 hours or by the hourly sweep. If Q9-style streaming without spool is wanted later, the writer interface does not change.

### 5.2 Request model (sketch, not final code)
```ts
type ExportRequest = {
  scope: { kind: 'server'; databases?: string[] }
       | { kind: 'database'; db: string; tables?: string[]; maxTableMiB?: number }
       | { kind: 'table'; db: string; table: string; range?: { offset: number; count: number }; filter?: FilterNode }
       | { kind: 'result'; db?: string; text: string; statementIndex: number };
  format: 'sql' | 'csv' | 'json';
  compression: 'none' | 'gzip' | 'zip';
  separateFiles?: boolean; view: 'file' | 'text'; fileNameTemplate?: string;
  lock?: boolean; skipUnreadable?: boolean;
  options: SqlOptions | CsvOptions | JsonOptions;   // discriminated by format, closed zod objects
};
type ImportStart = { uploadId: string; format: 'sql'|'csv'|'json'; charset?: string; target: { db?: string; table?: string; newTable?: TableDefinition };
  options: SqlImportOptions | RowImportOptions; mapping?: ColumnMap[]; confirmToken?: string };
```
`newTable` is the typed model of `structure` and is turned into SQL only by its builder.

### 5.3 SQL writer
`SqlWriter` is a pure transform from typed events (`header`, `object`, `row-batch`, `footer`) to text chunks, so it is tested without a database. It never builds object definitions: it asks the connection for `SHOW CREATE TABLE|VIEW|PROCEDURE|FUNCTION|TRIGGER|EVENT` and emits the returned text. Row batches build `INSERT` statements up to the byte cap with the value formatter of FR-IO-005. The importer's splitter tests include every construct the writer emits.

### 5.4 Value formatting
One module `io/values.ts` owns SQL literal, CSV cell and JSON value conversion from the `rows/codecs.ts` read form, per column type kind. CSV: default NULL text is empty for plain CSV and `NULL` for the Excel preset (legacy behaviour kept; the UI shows the choice). Rules for numbers, dates, binary and geometry are the ones in FR-IO-005 to FR-IO-007; geometry hex re-import was confirmed on both products in spike 0.

### 5.5 File names
Template tokens (kept from the legacy names, FR-IOX-034): `@SERVER@` (target host label), `@DATABASE@`, `@TABLE@`, `@COLUMNS@` (first 3 column names joined by `-`), `@YEAR@`, `@MONTH@`, `@DAY@`, `@HOUR@`, `@MINUTE@`, `@SECOND@`, `@HTTP_HOST@` (the request host). Unknown tokens stay as text. Defaults: table scope `@TABLE@_@DATABASE@`, database scope `@DATABASE@`, server scope `@SERVER@`, result scope `export`. After substitution: Unicode normalised (NFC), characters outside letters, digits, `_`, `-` and `.` (Unicode letters and digits allowed, Q4) become `_`, leading dots removed, length at most 120 characters, empty becomes `export`, then the extension chain is added. The header carries an ASCII fallback and the encoded UTF-8 name.

### 5.6 Upload, temp directory, quota
`DBLOOM_TEMP_DIR` (default `<dataDir>/tmp`, created 0700, never inside the store directory or a served directory; startup refuses a world-writable or a symlinked path), `DBLOOM_TEMP_QUOTA_MIB`, hourly sweep removes files older than their job's retention. Upload ids are 128-bit random, bound to session and user; the staged path is derived, never given. The route returns `413` only for a declared oversize; a counted overflow aborts with the closed-list error body.

### 5.7 Import statement policy
Every SQL statement is classified with `classifyStatement` into `none`, `soft` or `hard` as in `sql-tab`. Three tiers (Q6, decided 2026-10-27): (1) **Refused** (guard rail, not a boundary): `SET GLOBAL` and `SET PERSIST`, `KILL`, `SHUTDOWN`, `LOAD DATA` (all forms), `SELECT ... INTO OUTFILE|DUMPFILE`, `INSTALL` and `UNINSTALL PLUGIN`, `FLUSH`, `RESET`, `CHANGE MASTER` / `CHANGE REPLICATION SOURCE`, `START` and `STOP REPLICA|SLAVE`. The user may tick "skip refused statements"; they are then counted and listed. (2) **Hard, allowed with the confirmation token** (FR-IO-016): `DROP`, `TRUNCATE`, `DELETE` without `WHERE`, and the account statements `CREATE USER`, `ALTER USER`, `DROP USER`, `GRANT`, `REVOKE`, `RENAME USER`, `SET PASSWORD`. The analysis and the dialog list these by kind and count (for example "3 GRANT, 1 CREATE USER") so the user sees them before confirming. Full-server dumps legitimately contain them, and the target account's privileges still decide what can run. (3) **Unclassifiable** statements (parser failure) and statements over `PARSE_MAX_BYTES` (256 KiB) count as `hard`. Reason: a dump from a third party is untrusted text.

### 5.8 Settings and limits
| Setting | Source | Floor / default / ceiling |
|---|---|---|
| Upload size (ST-150) | UI within ENV bounds (`DBLOOM_IMPORT_MAX_MIB`) | 1 MiB / 64 MiB / 2 GiB |
| Decompressed size (ST-151) | UI within ENV bounds | 1 MiB / 1 GiB / 4 GiB |
| Ratio, entries, nesting (ST-151) | ENV-only, fixed | 100:1, 1, none |
| Job wall-clock (ST-111) | UI within ENV bounds | 60 s / 900 s / 7200 s |
| Max export size (ST-158) | UI within ENV bounds | 1 MiB / 1 GiB / 8 GiB |
| Concurrent imports (ST-155) | UI within ENV bounds | 1 / 1 / 3 |
| Temp dir, quota | ENV-only | `<dataDir>/tmp`, 10 GiB |
| Server import folder (ST-153) | ENV-only to enable | off |
| Formats (ST-152) | UI within ENV bounds | all three |
| CSV formula neutralisation (ST-157) | UI within ENV bounds | on |
| Import FK checks default (ST-160) | user pref within admin limits | `default` (off for the run, restored) |
Until the settings module exists, `resolveIoLimits` reads these defaults from `Config`.

### 5.9 Store
Migration 4 (migration 3 is the rows `ui_prefs`; built so) adds `io_templates (owner_key, kind, name, options_json, updated_at, PRIMARY KEY(owner_key, kind, name))` and uses `ui_prefs` for per-user defaults and the file name templates per scope (keys `io.*`). Stateless mode: in-memory maps with the same limits. Job records are in memory only (Q5).

### 5.10 Minimum privileges (SEC-TGT-053 input)
Export: `SELECT` on exported tables, `SHOW VIEW` for views, `TRIGGER` for triggers, `EVENT` for events, for routines the privilege to see the body: MySQL 8.4 `SHOW_ROUTINE` (global, `GRANT SHOW_ROUTINE ON *.*`; `EXECUTE`, `ALTER ROUTINE` and `CREATE ROUTINE` show the row but a NULL definition), MariaDB 10.11 `SELECT` on `mysql.proc` (no `SHOW_ROUTINE`; `EXECUTE` and the others give a NULL definition), or ownership/definer on both (section 5.11), `LOCK TABLES` for the lock option, `RELOAD` is never needed. Import: whatever the statements need (`INSERT`, `CREATE`, `ALTER`, `DROP`, ...); CSV and JSON import needs `INSERT` (+`DELETE` for `replace`) and, for a new table, `CREATE`. DBLoom does not pre-check; it runs and maps the error.

### 5.11 Spike 0 results (2026-10-27, `scripts/io-spike.mjs`; MySQL 8.4.13, MariaDB 10.11.19)
| Question | Result |
|---|---|
| Geometry as hex | `HEX(col)` is the 4-byte SRID (0) plus WKB; `INSERT ... VALUES (0x...)` stores the same geometry on both. FR-IO-005 stands. |
| Decimal with extra places, strict mode | Stored rounded (`1.239` to `1.24`), no error, both products. DATA-UPD-005 holds without special code. |
| `NO_BACKSLASH_ESCAPES` | With the mode on, a backslash in a literal is a plain character; `quoteLiteral` must not double backslashes when the session has it (the dump sets `sql_mode` itself, FR-IO-004, so the dump is safe either way). |
| View dependencies | `information_schema.VIEW_TABLE_USAGE`: MySQL yes, MariaDB no (error 1109). A view over a missing table is refused (1146). Q7: parser-based ordering is needed on MariaDB; on MySQL the catalog can confirm it. |
| `SHOW CREATE` text | Tables return `Table, Create Table`; views also return charset and collation columns; functions also return `sql_mode` and database collation. The writer emits only the create text and sets charset itself. |
| Limited user (SELECT, SHOW VIEW) | `SHOW CREATE VIEW` works. `SHOW CREATE FUNCTION` fails with 1305 (not visible without a routine privilege), `SHOW CREATE TRIGGER` with 1227 (needs TRIGGER), `LOCK TABLES` with 1044 (needs LOCK TABLES). Same on both. Section 5.10 stands; an unreadable object is a skip candidate (FR-IO-010). |
| Routine privilege (task 12, `io-spike.mjs priv`) | Without a routine privilege `SHOW CREATE FUNCTION/PROCEDURE` fails with 1305 on both. With `EXECUTE`, `ALTER ROUTINE` or `CREATE ROUTINE` the statement succeeds but the definition column is NULL on both (DBLoom treats NULL as unreadable, `showCreate`). MySQL 8.4: global `SHOW_ROUTINE` returns the text. MariaDB 10.11: `GRANT SHOW_ROUTINE` is a syntax error (1064); `GRANT SELECT ON mysql.proc` returns the text. Section 5.10 corrected. |
| ZIP64 (task 12, `io-spike.mjs zip64`) | `fflate` streaming `Zip` writes no ZIP64: an entry of 4 GiB + 1 byte (67 s, 4.2 MB archive) lists as `1 bytes uncompressed` in `zipinfo`, while `unzip -t` reports OK (it compares modulo 2^32). Fix: `ZipWriter` refuses to pass 4 GiB - 1 per entry or per archive (`export_too_large`). Reading ZIP64 stays refused (`archive_not_allowed`). |
| `START TRANSACTION WITH CONSISTENT SNAPSHOT` | Accepted on both. |
| Prepared multi-row `INSERT` via `execute` | Works on both. |
| `fflate` | See FR-IO-008. |

### 5.12 Round trip and benchmark results (2026-10-27)
Round trip (`tests/io-roundtrip.integration.test.ts`, per product, fixture of FR-IO-027 plus partitions, STORED and VIRTUAL generated columns, CHECK, CJK in utf8mb4/latin1/ascii, emoji with ZWJ, 3 MiB blob, 2 MiB CJK text, views over views, routines, event, 100 000 rows; `compareDatabases` = `SHOW CREATE` modulo AUTO_INCREMENT, `CHECKSUM TABLE`, program names):

| Path | MySQL 8.4 | MariaDB 10.11 |
|---|---|---|
| DBLoom SQL export -> DBLoom import (also gzip, structure only) | identical | identical |
| DBLoom export -> `mysql`/`mariadb` client import | identical | identical |
| `mysqldump`/`mariadb-dump --hex-blob --complete-insert` -> DBLoom import | identical except `types_t.t_float`: the client writes FLOAT with 6 digits (client-side loss, compared by value) | same |
| client dump without `--hex-blob` -> DBLoom import | refused at analysis, `Invalid byte sequence at byte N`: raw binary bytes are not UTF-8; DBLoom never imports them damaged | same |
| CSV and JSON of 4 tables -> DBLoom import | identical checksums | identical |
| Across products, DBLoom export -> DBLoom import (plain and gzip), common subset (typed table with JSON, BIT, STORED/VIRTUAL, FK, partitions, view, function, procedure, trigger, event) | MySQL -> MariaDB: rows, view, function and program names equal | MariaDB -> MySQL: equal |

Benchmark (`node --expose-gc scripts/io-bench.mjs --size-mb 200`, 784 314 rows, 191 MB SQL; DBLoom in the Node process on the Windows host over the docker port, clients inside the container on files in `/tmp`, so the clients skip the network hop; one run each, no warm-up, noisy):

| Measure | MySQL 8.4 | MariaDB 10.11 | NFR | Verdict |
|---|---|---|---|---|
| Export, client dump / DBLoom | 4.1 s (47 MB/s) / 6.9 s (28 MB/s), ratio 1.7 | 1.1 s (171 MB/s) / 7.0 s (27 MB/s), ratio 6.2 | none stated | informational: DBLoom export is about 27 MB/s on both |
| Import, `mysql` client / DBLoom run | 10.3 s / 19.5 s, ratio 1.9 | 6.7 s / 13.9 s, ratio 2.1 | NFR-ISS-102 (factor 3, owner 2026-10-27) | **pass**: 1.9 and 2.1, with the analysis pass 2.3 and 2.7 |
| Import including the analysis pass (separate request, reads the file once for hash and classification) | +4.6 s, ratio 2.3 | +4.0 s, ratio 2.7 | same | same |
| Process RSS growth, export / import (190 MB file) | 163 / 289 MiB | 46 / 321 MiB | NFR-CC-016, NFR-IOX-052 (bounded) | pass: growth is a plateau, not proportional to the file (import 124 MiB at 50 MB, 289 at 200 MB, 283 at 400 MB; export 101, 163, 177 MiB); heap retained after the run about 0 |
| Job record during import | 340 B max | 340 B | NFR-ISS-104 (at most 4 KB) | pass |
| Result export of 200 000 rows (45.7 MB CSV), RSS growth | 22 MiB (last third of the run +11 MiB over the first) | 16 MiB (+9 MiB) | NFR-IOX-023, FR-IO-003 (flat) | pass: growth below half of the output size, heap retained about 0 |

The plateau of 170 to 320 MiB is Node's lazy collection with chunk buffers; it does not grow with the input, but it is larger than "one chunk". The 400 MB run was done for MySQL only. NFR-ISS-102 factor is 3 (owner, 2026-10-27) and is met.

## 6. Tech stack
As file 21 section 3: TypeScript strict, TanStack Start (Nitro routes for upload and download), `mysql2` through the adapter, zod, Vitest, Playwright, shadcn/ui base components, `@tanstack/react-query`. Node built-ins: `node:zlib`, `node:stream`, `node:fs`, `TextDecoder`. Packages (Q1): `fflate`, `csv-parse`, `csv-stringify`, `stream-json`. Own code: streaming JSON writer, the safety limits around the packages.

## 7. Commands
As file 21 section 4, plus:
```
Unit:         npx vitest run tests/io-*.test.ts
Integration:  docker compose -f compose.test.yaml up -d && npx vitest run tests/io.integration.test.ts
E2E:          npx playwright test e2e/io-*.spec.ts
ID check:     node scripts/check-traceability-ids.mjs SPEC/25-module-io.md io     (must report 148 of 148)
Round trip:   npx vitest run tests/io-roundtrip.integration.test.ts
Benchmark:    node --expose-gc scripts/io-bench.mjs [--size-mb 200] [--product mysql|mariadb|both] [--result-rows 200000]   (ratios to the mysql client, NFR-ISS-102; section 5.12)
```

## 8. Project structure (new and touched files)
```
src/server/io/types.ts            requests, options (zod), Job, Analysis, errors                         (contracts, task 0)
src/server/io/values.ts           literal / CSV / JSON value formatters                                  (A)
src/server/io/sql-writer.ts       SQL dump writer (pure)                                                 (A)
src/server/io/csv.ts, json.ts     thin wrappers over `csv-parse`/`csv-stringify`/`stream-json`, own JSON writer (A)
src/server/io/zip.ts              wrapper over `fflate` with entry/ratio/size limits, single-entry reader     (A)
src/server/io/charset.ts          streaming decode, BOM, fatal errors with offsets                       (A)
src/server/io/filename.ts         template expansion, sanitising, headers                                (A)
src/server/io/jobs.ts             job registry, states, progress, concurrency, retention                 (B)
src/server/io/limits.ts, temp.ts  resolveIoLimits, temp dir, quota, sweep, staged files                  (B)
src/server/io/export.ts           scopes, snapshot, ordering, spool, failure handling                    (C)
src/server/io/analyse.ts          sniff, decompress, decode, scan, classification                        (D)
src/server/io/import-sql.ts       splitter driver, execution, resume                                     (D)
src/server/io/import-rows.ts      mapping, type inference, batch insert, rejects                         (D)
src/server/io/folder.ts           server import folder listing and path confinement                      (D)
src/server/io.functions.ts        server functions (thin)                                                (C/D)
src/routes/api/io/upload.ts, download.$id.ts   raw upload and streaming download                        (B)
src/server/io/store.ts            IoPrefsStore / IoTemplateStore interfaces, zod value schemas, memory implementations (B)
src/server/io/http.ts             handlers of the upload and download routes (B)
src/server/store/sqlite-store.ts  migration 4 (io_templates), io prefs in ui_prefs                                             (B, announced)
src/server/audit.ts, structure/events.ts   additive edits listed in task 0
src/components/io/*.tsx           export-tab, import-tab, option-panels, scope-picker, mapping-step, job-progress, drop-overlay   (E)
src/components/io/registry.ts     option registry (FR-IO-026)                                            (contracts; E)
src/components/shell/*            tab kind `io`, tree menu entries, drop overlay                         (E only for this module)
src/i18n/en.json                  prefix io.                                                             (E)
tests/io-*.test.ts, tests/io.integration.test.ts, tests/io.bench.test.ts, e2e/io-*.spec.ts, e2e/fixtures/io/   (A..F)
```

## 9. Code style
As file 21 section 6. Handlers stay thin:
```ts
export const startImportFn = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator(startImportSchema)                      // zod; no SQL, no path
  .handler(async ({ context, data }) => {
    assertWritable(context.guard)                    // read-only refuses first
    const upload = takeUpload(context.session, data.uploadId)       // bound to session and user
    const analysis = await requireAnalysis(upload)   // the one analysed in this session
    verifyImportToken(context.guard, analysis, data.confirmToken)   // required when a hard statement exists
    return startImportJob(context, upload, analysis, data.options)
  })
```
Writers are pure functions over iterables of typed events; nothing in `src/server/io/` builds SQL except `sql-writer.ts` (dump text, from server-returned definitions) and the batch `INSERT` builder in `import-rows.ts` (identifiers through `quoteIdent`, values as parameters); a lint rule limits template strings with SQL keywords to those two files.

## 10. Testing strategy
- Unit: value formatters (hostile strings, NO_BACKSLASH_ESCAPES, every type kind), SQL writer golden files, CSV/JSON round trip, ZIP writer against `node:zlib`/system unzip and reader against hostile archives, charset decoder at every chunk boundary, file name sanitiser table, job state machine, limits resolver, token issue/verify, statement policy table.
- Integration (MySQL 8.4 on 33064, MariaDB 10.11 on 33061, plus a limited user): all scopes, snapshot consistency, lock release, skip and fail paths, import of every statement class, resume equality, `NO_BACKSLASH_ESCAPES` session, round trip and cross-product, 200 000-row streaming memory check, 100 MB benchmark.
- E2E (Playwright): SCN-052 to SCN-063, one product by default, full matrix in CI; no Playwright run concurrently with another agent's (shared build and scratch sweep); specs that change a stored preference restore it.
- Security checks: forged POST without CSRF, `sql` or `path` field in any request, token replay and tamper, symlink and traversal, zip bomb, lying length, no cell value or credential in logs, formula injection.
- CI as in file 21 section 8.

## 11. Boundaries
- **Always:** test first for writers, parsers and the zip module; spike before relying on a vendor fact; keep memory flat (stream, back pressure); verify existing names against the catalog; reuse `quoteIdent`, `quoteLiteral`, the guard, the classifier and the structure builder; text through `t()`; `apple-design` and `design-taste-frontend` for every screen; run lint, typecheck, unit and the touched e2e before reporting done.
- **Ask first:** a dependency beyond the four of Q1 (and `iconv-lite` for Q3 later), changing the store shape beyond migration 3, changing the audit line format, adding a format or compression, changing the guard classes, any commit or push.
- **Never:** accept SQL text, paths or file names for the file system from the client; build DDL outside the structure builder; enable `multipleStatements`; run an uploaded statement without classification; skip the token check for a `hard` import; offer a partial export as complete; hold a file in memory; log cell values or credentials; render file or server text as HTML; save exports on the server.

## 12. Success criteria
1. SCN-052 to SCN-063 pass on MySQL 8.4 and MariaDB 10.11.
2. The round trip of FR-IO-027 is identical on each product and for the common subset across products.
3. A 2 GiB export and a 2 GiB import (manual) and the 200 000-row and 100 MB tests keep process memory flat.
4. An export that fails or is cancelled is never delivered as complete; a hard import never starts without the server-checked token; read-only refuses import without opening a target connection.
5. Zip bomb, traversal, symlink, lying length and formula injection fixtures are refused or neutralised.
6. The *verify* cells are filled in from spike 0 and task 12 (section 5.11); none is open. ZIP64 writing is not offered (limit and message in FR-IO-008).
7. Lint, typecheck, unit, integration and e2e green in CI on Node 22.13 and 24; axe clean.

## 13. Task breakdown and work packages

Packages A to F can run in parallel (as separate subagents, only when the owner asks) after task 0, because each package owns its files and talks to the others through `src/server/io/types.ts` (frozen by task 0; changes need the coordinating agent). Shared files: `store/sqlite-store.ts` and `audit.ts` are package B's; `en.json` and shell files are package E's.

| Task | Package | Files (owner) | Acceptance | Verify |
|---|---|---|---|---|
| 0 Contracts and spike | coordinator | `io/types.ts`; spike script under `scripts/` | Zod schemas, Job, Analysis, error codes compile; spike reports geometry hex re-import, `SHOW CREATE` privilege needs, view dependency source (`VIEW_TABLE_USAGE` on MariaDB), strict-mode decimal rounding, `NO_BACKSLASH_ESCAPES` literal | `npm run typecheck`; spike log filled into this file |
| 1 Values, SQL writer | A | `values.ts`, `sql-writer.ts`, tests | FR-IO-004, 005 against fake events | Unit golden files |
| 2 CSV, JSON | A | `csv.ts`, `json.ts`, tests | FR-IO-006, 007, 018 parser | Unit round trip, hostile CSV |
| 3 ZIP, charset, file names | A | `zip.ts`, `charset.ts`, `filename.ts`, tests | FR-IO-008, 009, 014 (reader), 015 | Unit; system `unzip -t`; chunk-boundary property test |
| 4 Jobs, limits, temp | B | `jobs.ts`, `limits.ts`, `temp.ts`, routes, store migration | FR-IO-001, 011 (store), 012, 022; upload and download routes | Unit; integration for upload errors and sweep |
| 5 Export | C | `export.ts`, `io.functions.ts` (export part), integration part | FR-IO-002, 003, 010, 021 (export), 027 (export half) | Integration both products |
| 6 Analyse and SQL import | D | `analyse.ts`, `import-sql.ts`, `folder.ts`, `io.functions.ts` (import part) | FR-IO-013, 016, 017, 020, 021, 024 | Integration; resume equality; token tests |
| 7 CSV/JSON import | D | `import-rows.ts`, tests | FR-IO-018, 019, 023 | Integration; hostile content |
| 8 Components | E | `components/io/*`, `en.json` (prefix) | FR-IO-025, 026 against mocked server functions; design pass | Component tests; axe |
| 9 Shell integration | E | shell files | Tab kind `io`, menus, drop overlay, `rows` toolbar and SQL result Export entry wired | SCN-004/005 still pass |
| 10 E2E | F | `e2e/io-*.spec.ts`, fixtures | SCN-052 to SCN-063 | Green on both products |
| 11 Round trip and benchmark | F (after 5, 6, 7) | `tests/io-roundtrip.integration.test.ts`, `scripts/io-bench.mjs` | FR-IO-027; NFR-ISS-102 ratio printed | Both products and cross (DONE 2026-10-27, section 5.12) |
| 12 Verify cells | coordinator | this file | Spike and integration results replace *verify* | Spec updated (DONE 2026-10-27, section 5.11) |

Order: 0 alone; then A (1, 2, 3), B (4), E (8) in parallel; C (5) and D (6, 7) after A and B publish interfaces; 9 after 8; 10 and 11 last. Conflicts: none by file ownership; the only cross-package edits are the lint rule (A) and the store migration (B).

## 14. Open questions for the owner (max 10, each with a recommended default)

| # | Question | Recommended default |
|---|---|---|
| Q1 | Own code or packages for ZIP and CSV/JSON streaming? | **DECIDED (owner, 2026-10-27): packages** (`fflate`, `csv-parse`, `csv-stringify`, `stream-json`), pinned, checked by fixtures. |
| Q2 | CSV import through `LOAD DATA` or only batched parameterised INSERT? | **DECIDED (owner, 2026-10-27): disabled for now**, INSERT only; the idea is recorded in FUTURE.md as FU-011. |
| Q3 | Export in a non-UTF-8 charset? | **DECIDED (owner, 2026-10-27): UTF-8 only**; import supports the `TextDecoder` charsets. |
| Q4 | File name characters beyond `[A-Za-z0-9_-]`? | **DECIDED (owner, 2026-10-27): Unicode letters and digits, `_`, `-`, `.`**; the rest becomes `_`; ASCII fallback in the header. |
| Q5 | Jobs are in memory; losing running jobs and resume on a server restart? | **DECIDED (owner, 2026-10-27): acceptable** for slice 1. |
| Q6 | Statement policy for imported SQL. | **DECIDED (owner, 2026-10-27): three tiers of section 5.7**; account statements (`GRANT`, `CREATE USER` and similar) are hard, allowed with the confirmation token and listed in the analysis. |
| Q7 | View order in a dump: derive from parsed table references (works on both, needs the parser), or from `VIEW_TABLE_USAGE` (MySQL only, *verify* MariaDB)? | **DECIDED (assistant on the owner's "go", 2026-10-27): Parser-based references, catalog as check; spike 0 confirmed `VIEW_TABLE_USAGE` exists on MySQL 8.4 only (MariaDB 10.11: error 1109).** |
| Q8 | Export of selected rows with their related rows (DATA-ISS-101): second slice? | **DECIDED (assistant on the owner's "go", 2026-10-27): Second slice with the `rows` selection hook.** |
| Q9 | Spool exports to a temp file (retry, discard on failure, size cap exact) or pure live streaming? | **DECIDED (assistant on the owner's "go", 2026-10-27): Spool by default; Quick mode of a small single table streams live.** |
| Q10 | A mid-stream export failure aborts the download (G4, decided). Should the user also be able to download the partial file for analysis? | **DECIDED (assistant on the owner's "go", 2026-10-27): No partial download.** |

## 15. Implementation notes (2026-10-27, packages A, B, E built)
- **Package A:** the CSV writer is own code (not `csv-stringify`): the allow-listed options "no enclosure" and "backslash escape" cannot round-trip through it; `csv-parse` reads. ZIP64 archives are refused on import (`archive_not_allowed`); a truncated archive is `not_archive`; the ratio is checked after a 1 MiB grace; file name time tokens are UTC; inside a dump strings use backslash escaping (the dump sets `sql_mode`); the transaction wrapper is per table, because DDL commits implicitly; the writer does not reorder events (tables, views, routines, triggers, events), `createDatabase` needs `createText` from `SHOW CREATE DATABASE`; `deferForeignKeysTo` lists the referenced tables of a cycle.
- **Package B:** migration number is 4. Upload errors are `{error:{code,message}}` with 413 (too large), 507 (quota), 400 (interrupted, empty, invalid format), 403 (read-only). Not done: the 2 MiB text view of FR-IO-009 (belongs to a server function or `?view=text`, package C); reject details beyond about 10 are cut from the 4 KB job record (`rejectedCount` stays exact), so package D keeps the full 100 elsewhere; spool and staged files must be registered for cleanup by C and D (`temp.remove`, `retain`).
- **Package E:** runs against a mock `IoApi`; the integrator calls `setIoApi(createServerIoApi({...}))` once and exposes `previewNewTable` from the structure builder. The rows toolbar and SQL result Export entries are not wired yet. Real axe, Playwright and the visual and phone-width check are still to do. Import menu entries stay enabled in read-only mode; Start is disabled with the reason (SCN-056).
- **Contract additions by the coordinator:** `ImportAnalysis.confirmToken`, `rows.inferred`, `rows.jsonTables`, `analyseRequest.rowOptions`, `mayDisableFormulaNeutralisation`; a server import folder file is passed in the `uploadId` field of `analyseImport`.
- **State:** unit suite 1882 passed, 2 skipped; typecheck and lint clean. Open: packages C (export, functions), D (import), tasks 9 (rows/SQL entries), 10 to 12.
