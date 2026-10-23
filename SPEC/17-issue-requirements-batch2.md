# 17 — Requirements derived from open LegacyAdmin issues, second review

**Status: PROPOSED, not approved; wording drafted by subagents and only sampled by the orchestrator.** Subsystem code `ISS` (numbers from 101). Continuation of `16-issue-requirements.md` for the rest of the gap rows of `15-open-issues-triage.md` (`OPEN.md` item 21).

## 1. Method and limits

- **Input:** 347 gap rows (GAP-BUG or GAP-FEATURE) that were not among the 132 priority candidates and not flagged as PHP or build specific by the keyword match: 92 created before 2019 (82 reviewed by Sonnet subagents and 10 read by the orchestrator in a sample) and 255 created in 2019 or later (reviewed by Haiku subagents; the requirement wording of the 10 orchestrator rows is the orchestrator's own). The 44 UNCLEAR rows and the rows flagged as PHP or build specific were not reviewed.
- **Review:** each agent read the **full issue and all comments** with the `gh` client (not only 700 characters), and gave one disposition per issue: ACCEPT (a new requirement), MERGE (added to an existing requirement of `16-issue-requirements.md`), COVERED (already required elsewhere in the SPEC) or DROP (with a reason). The requirement wording of section 2 is the agents' wording, lightly normalised; the orchestrator read about 25 of them and found them specific and testable, but **has not reviewed all 145**.
- **Result:** 145 requirements remain after the duplicate and conflict review of section 3 (35 issues were folded into other requirements of this file); 71 issues merged (listed in the issue column of the requirements in `16-issue-requirements.md`), 15 covered, 81 dropped. Every issue has exactly one disposition in section 4.
- **Evidence rule:** as in `16-issue-requirements.md`: the requirements rest on upstream issue reports; defects were **not reproduced**. Several threads say a problem could not be reproduced or was fixed (the agents noted this in their reasons); those requirements are still accepted where the issue is open and the behaviour is testable.
- **Duplicates and conflicts:** reviewed by the orchestrator after the agents finished (section 3): 35 overlapping issues were folded into 27 requirements, 6 conflicts were resolved by rewriting the requirements, 5 issues were merged into requirements of file 16 and 1 was dropped. Overlaps with requirements of file 16 were checked by topic only, not word by word.
- **Scope:** every requirement is subject to the scope decision (`OPEN.md` item 1). A few assume features that the SPEC does not yet have (for example #19259 positional parameter binding and #19178 multi-word keyword autocomplete) and need an owner decision on scope.

## 2. Requirements

### Data handling

| ID | Requirement | Issue |
|---|---|---|
| DATA-ISS-101 | **PROPOSED.** DBLoom shall offer export of selected rows together with all rows related through foreign keys, followed recursively with cycle protection, in an order that imports cleanly. | #5852 |
| DATA-ISS-102 | **PROPOSED.** The insert and edit forms shall never send values for generated columns (they are shown read-only), so inserting into a table with VIRTUAL or STORED columns succeeds. | #11909 |
| DATA-ISS-103 | **PROPOSED.** An export in any offered compatibility mode shall contain complete table definitions with all columns, or the mode shall not be offered; a test shall compare column counts of export and source. | #12971 |
| DATA-ISS-104 | **PROPOSED.** When a column used in a partitioning expression is renamed, DBLoom shall detect this beforehand and either explain that the server refuses it or offer to re-create the partitioning with the new column name in the same operation, never surfacing only a raw unknown-column error. | #13043 |
| DATA-ISS-105 | **PROPOSED.** Export of a query result shall quote values according to the column types reported for the result set, including DISTINCT, computed and aliased columns, and a test shall import the exported file of a DISTINCT query again. | #13693 |
| DATA-ISS-106 | **PROPOSED.** An export made with IF NOT EXISTS shall be safe to import again: foreign keys and other later ALTER statements shall be skipped or created conditionally, or the export shall offer DROP TABLE IF EXISTS first. | #13845 |
| DATA-ISS-107 | **PROPOSED.** CSV import shall offer an option stating that the first row contains column names, used to name the columns when a table is created from the file and to map columns when importing into an existing table. | #14081 |
| DATA-ISS-108 | **PROPOSED.** Entering a hexadecimal literal (0x101 or X'101') as a default or value for an integer column shall be sent unquoted, or converted to its decimal value, so that the statement succeeds. | #14396 |
| DATA-ISS-109 | **PROPOSED.** Timestamp columns in browse and edit forms shall show the time zone that applies to the value next to it, which is the time zone of the connection session, and that time zone shall be settable per connection. | #14872 |
| DATA-ISS-110 | **PROPOSED.** Inline editing shall be offered only for result rows that identify a single base-table row through a unique key; for DISTINCT, GROUP BY, aggregate or other results without that identity the edit action shall be hidden or disabled. | #15523 |
| DATA-ISS-111 | **PROPOSED.** When DBLoom exports selected routines, it shall offer the same optional DROP statement that the database export offers, and when the option is on the file shall contain a DROP statement before each CREATE statement of the selected routines. | #16242 |
| DATA-ISS-112 | **PROPOSED.** From a row, DBLoom shall list the rows of other tables whose foreign key references that row's value, one group per referencing table and column, and shall offer an insert form for the referencing table with the foreign key column preset to that value. | #16535 |
| DATA-ISS-113 | **PROPOSED.** Before a foreign key is created or changed, DBLoom shall compare the referencing and referenced column types and warn, naming both types, when they differ in integer size, signedness, string length or character set; shall warn when the parent or child table uses a storage engine that does not enforce foreign keys and shall not report the constraint as created; and shall list the ALTER statements and state that they may lock the involved tables. The user may choose to run them with foreign_key_checks disabled for that session only, and the setting shall be restored afterwards. | #16699, #16891, #18062 |
| DATA-ISS-114 | **PROPOSED.** When a table structure changes, DBLoom shall keep the saved column order and visibility of columns that still exist, remove only the entries of dropped columns, and show added columns at the end and visible. | #17189 |
| DATA-ISS-115 | **PROPOSED.** Text entered in any multi-line editor, and the member values of an ENUM or SET column, shall be stored and written to the generated statement exactly, including repeated, leading and trailing spaces and line breaks, and the saved column definition shall show the change. | #17397, #17035 |
| DATA-ISS-116 | **PROPOSED.** An import whose bytes are not valid in the selected character set shall stop with an error that gives the byte offset or line number and the statement number, and shall not write a partial result. Importing a file in a legacy single-byte character set shall convert all characters, including ASCII control characters inside string literals, to UTF-8, and never end in an internal error. | #17401, #18173 |
| DATA-ISS-117 | **PROPOSED.** The routine editor shall offer and keep CHARACTER SET and COLLATE for every parameter and return value of a procedure or function, and re-opening a routine shall show those clauses unchanged. | #17419 |
| DATA-ISS-118 | **PROPOSED.** When a column has a data type that DBLoom does not know, browse, search, insert and edit shall show the column with the server's type name and a message that the type is not supported, and shall not raise an internal error. | #18183 |
| DATA-ISS-119 | **PROPOSED.** The SQL import and the SQL editor shall pass MySQL executable comments (/*! ... */ and /*M! ... */) to the server unchanged so that the server applies them, and the statement splitter shall neither drop nor split on them. | #18323 |
| DATA-ISS-120 | **PROPOSED.** An exported view or routine definition shall be the server's own definition text (as returned by SHOW CREATE) without re-generation by the application, so that it re-imports unchanged on MySQL 8.4 and MariaDB 10.11. | #18515 |
| DATA-ISS-121 | **PROPOSED.** Displaying a result set shall run the row-identity analysis once per base table and not once per row, so that display time stays close to query time, and a user setting shall turn off row editing for views. | #18539 |
| DATA-ISS-122 | **PROPOSED.** The browse view shall offer a setting with the values full (link and value lookup), links (link without value lookup) and none (no relation lookup); with links or none the listing shall issue no per-row lookup query. | #19045 |
| DATA-ISS-123 | **PROPOSED.** Generated SQL shall name utf8mb4 instead of the utf8 alias for every character set it uses, so that a search or a browse produces no server warning on MySQL 8.4. | #19056 |
| DATA-ISS-124 | **PROPOSED.** When the insert form adds several rows, a nullable ENUM column of each new row shall start as NULL, and the form shall never preselect a value that is not a member of the ENUM list, so that an untouched field inserts NULL. | #19383 |
| DATA-ISS-125 | **PROPOSED.** A search on a binary column shall accept a hex literal (0x...) typed or copied from the displayed value and compare it as bytes, so that a row displayed as 0x7F000001 is found by searching for 0x7F000001. | #19384 |
| DATA-ISS-126 | **PROPOSED.** CSV exports shall be served with media type text/csv and JSON exports with media type application/json, both in the download headers and in the export file metadata. | #19398 |
| DATA-ISS-127 | **PROPOSED.** The SQL export shall offer an option that writes primary and unique keys, indexes and AUTO_INCREMENT of each table inside its CREATE TABLE statement, so that a file of one table recreates the table as it is when imported alone, and an option that emits each table's create, data and key statements together so that a failing import identifies the table. | #19411, #15386 |
| DATA-ISS-128 | **PROPOSED.** Opening a row for editing shall pre-fill the form with the row's current stored values for a source query of at least 4 KB, and the result shall be the same behind at least two reverse-proxy configurations. | #19604 |
| DATA-ISS-129 | **PROPOSED.** DBLoom shall display every BIT(n) value in browse in one consistent format, and the value shown after an edit shall use that same format. | #19622 |
| DATA-ISS-130 | **PROPOSED.** A SQL export of several tables shall write each referenced table before the tables that reference it, with ties broken by name so that two identical schemas produce byte-identical output; when foreign keys form a cycle DBLoom shall warn the user and write the foreign keys of the cycle as ALTER statements at the end, instead of exporting silently. An option keeps the server order. | #19725, #6225 |
| DATA-ISS-131 | **PROPOSED.** Moving, copying or renaming a database, table or column shall recreate each affected view from the definition stored by the server. The only change allowed is replacing qualifiers that name the source schema by the target schema, done with the SQL tokenizer and not by text search, with an option to keep the original references. Before a rename, DBLoom shall list the views whose definition references the old name and either update them in the same operation after user confirmation or stop the rename. A view that cannot be recreated shall be named in an error and the source database shall not be dropped. | #19759, #13757, #16215 |
| DATA-ISS-132 | **PROPOSED.** The CSV export shall offer an option to write a UTF-8 byte-order mark at the start of the file, off by default, and the mark shall be written once per file. | #20010 |
| DATA-ISS-133 | **PROPOSED.** DBLoom shall match database and table names against the catalog according to the server's lower_case_table_names setting, and a table whose status information is incomplete or missing shall still open, showing the missing values as unknown and without an error. | #20048 |
| DATA-ISS-134 | **PROPOSED.** When an export is converted to a non-UTF-8 character set and a character cannot be represented in it, DBLoom shall either substitute a visible replacement character and report how many were replaced, or stop the export with a clear message; it shall never fail with an internal error. | #20128 |
| DATA-ISS-135 | **PROPOSED.** The foreign keys that the server reports for a system-versioned table (a definition that contains PERIOD FOR SYSTEM_TIME) shall be listed in the structure, relation and browse views; DBLoom reads them from the catalog under the general rule of DATA-ISS-017. | #20190, #20095 |
| DATA-ISS-136 | **PROPOSED.** For a system-versioned table on MariaDB, the export shall offer an option, off by default, to include all historical rows (all system-time rows), and the option shall be hidden on servers without system versioning. | #20322 |
| DATA-ISS-137 | **PROPOSED.** The CSV bulk-load import shall accept each character set the target server supports, pass it to the load statement as the data character set, and show an error naming the actual cause when a set cannot be used. | #20400 |
| DATA-ISS-138 | **PROPOSED.** When a column is edited and its collation is left at the table default, DBLoom shall send no COLLATE clause, so the column keeps following the table collation and only the properties the user changed differ in SHOW CREATE TABLE before and after the save. | #20411 |

### Behaviour

| ID | Requirement | Issue |
|---|---|---|
| FR-ISS-101 | **PROPOSED.** The SQL console shall let the user set session variables such as sql_mode for their own connection session without requiring global privileges, and show the effective values. | #12087 |
| FR-ISS-102 | **PROPOSED.** An administrator or user shall be able to set a default database per connection that is opened after login, with an explicit URL database taking precedence. | #12102 |
| FR-ISS-103 | **PROPOSED.** Paging, sorting, re-running and exporting a result set whose query depends on session state (a variable set by an earlier statement, or a batch of several statements) shall return the same rows as the first page: the page query shall run in the session that holds the state, or the whole batch shall be re-run in one session, and the user shall be able to reopen the full original batch text for editing. | #12156, #17051 |
| FR-ISS-104 | **PROPOSED.** Before running an UPDATE or DELETE from the SQL editor, DBLoom shall show the number of rows it would affect (or a dry-run estimate) and, above a user-configurable threshold per statement type, require explicit confirmation. | #12267 |
| FR-ISS-105 | **PROPOSED.** When dropping a database or table, DBLoom shall list accounts that still hold privileges on it and, if the current user may revoke, offer to revoke them as part of the drop. | #12381 |
| FR-ISS-106 | **PROPOSED.** The SQL page shall let the user run one statement or script against a chosen set of databases and show the result or error per database. | #12725 |
| FR-ISS-107 | **PROPOSED.** The database structure page shall offer changing the storage engine of several selected tables in one action, with per-table result reporting and a clear error for tables that fail. | #12893 |
| FR-ISS-108 | **PROPOSED.** When a statement fails or times out (a user query, or the creation of a routine, view or trigger), DBLoom shall show the server error code and message prominently above the statement, shall show the statement in a scrollable, truncated area with a copy action so that the message stays visible for statements of any length, and shall mark the error position when the server gives one. | #12915, #16054, #12314 |
| FR-ISS-109 | **PROPOSED.** When the user adds an index on a TEXT or BLOB column without a prefix length, DBLoom shall require or prompt for the prefix length before submit instead of failing at the server. | #12970 |
| FR-ISS-110 | **PROPOSED.** After an inline cell edit is saved, DBLoom shall re-read the edited row from the server and update all displayed cells of that row, including generated columns and values changed by triggers. | #13106 |
| FR-ISS-111 | **PROPOSED.** When the default character set or collation of a database is changed, DBLoom shall warn that stored routines relying on the defaults must be recreated and offer to recreate them. | #14578 |
| FR-ISS-112 | **PROPOSED.** A login session may hold connections to several configured servers. Switching the active connection shall keep the authenticated connection of the earlier one until that connection ends, times out or the user disconnects it. Every request shall use the TLS setting and control database of the connection it belongs to (given in its own context), never those of the server currently selected in the navigation. | #14913, #15981 |
| FR-ISS-113 | **PROPOSED.** Starting an import shall show the target server, the database and the file name and shall require an explicit confirmation before the first statement runs. A script imported without a target database selected and without a USE statement shall be refused with a clear message asking for a database (or the single available one preselected), and DBLoom shall never report success when statements failed. | #14923, #13331 |
| FR-ISS-114 | **PROPOSED.** Running a script that contains LOCK TABLES or UNLOCK TABLES shall complete or fail with an error; when the user cancels the run or the request ends, DBLoom shall end the running statement and the server shall release that session's table locks. The SQL editor syntax check shall accept valid LOCK TABLES and UNLOCK TABLES statements without error markers, and the interface shall state that table locks and other session-scoped state end when the request ends. | #15176, #16018 |
| FR-ISS-115 | **PROPOSED.** On MySQL 8.4 DBLoom shall collect query profiling from performance_schema and shall not run SHOW PROFILE, so no deprecation warning is shown; when performance_schema is disabled it shall say so. | #15209 |
| FR-ISS-116 | **PROPOSED.** The status advisor shall never show two recommendations for one server variable that point in opposite directions (a test shall fail when two rules give opposite advice), shall not fire a query-cache rule when the live variables show the query cache disabled or absent (including MySQL 8.4), and shall report unknown, not a conclusion, when a variable it depends on is missing or empty. | #15222, #17667, #19667 |
| FR-ISS-117 | **PROPOSED.** When a routine cannot be listed or executed because the account lacks a metadata privilege, DBLoom shall show the server error and name the privilege that is missing, for example SELECT on mysql.proc on MariaDB. | #15383 |
| FR-ISS-118 | **PROPOSED.** DBLoom shall record in the query history every statement it executes on the user's behalf. A multi-statement submission is one entry that holds all submitted statements and marks the statement that failed and the number executed. Statements that DBLoom generates itself (browse, search, inline edit) are recorded as separate entries marked as generated and are hidden in the history view by default, with a filter to show them. | #16047, #15506 |
| FR-ISS-119 | **PROPOSED.** When an import succeeds, DBLoom shall show server notes produced by its statements (such as note 1031 for storage engine options) as notes and not as warnings, and shall report the import as successful when no statement failed. | #16270 |
| FR-ISS-120 | **PROPOSED.** Saving a setting that takes several values, after it was reverted to its default, shall store exactly the default value; blank lines entered by the user shall be dropped or stored as an empty string and shall never add a list entry. | #16702 |
| FR-ISS-121 | **PROPOSED.** When the database server is stopped or the connection is lost, DBLoom shall show a controlled error message with a retry option, and shall never show raw driver warnings, stack traces or internal file paths to the user. | #16763 |
| FR-ISS-122 | **PROPOSED.** DBLoom shall accept an IPv6 server address with or without square brackets in the connection form and shall connect to that address. | #16856 |
| FR-ISS-123 | **PROPOSED.** Any server-side request that formats or analyses SQL text shall finish within a bounded time, and on failure or timeout it shall return a well-formed error and leave the editor text unchanged. | #17342 |
| FR-ISS-124 | **PROPOSED.** The result grid shall render any result set, including columns with a scalar subquery and no alias, without a server or script error, and shall show the expression text as the column header. | #17357 |
| FR-ISS-125 | **PROPOSED.** Any statement that returns rows, including DELETE, INSERT and REPLACE with RETURNING on MariaDB 10.11, shall show the returned rows in the result grid, and the RETURNING keyword shall be highlighted in the SQL editor. | #17628 |
| FR-ISS-126 | **PROPOSED.** The SQL editor shall offer an option to run all statements submitted together inside one transaction: the transaction is committed only if every statement succeeds, and after the first error all statements of that transaction are rolled back and the error is shown. | #17834 |
| FR-ISS-127 | **PROPOSED.** A form or dialog submit shall send one request per user action: while a request is pending further submits are ignored, and reopening a dialog shall not repeat an earlier submit. | #18104 |
| FR-ISS-128 | **PROPOSED.** Renaming a database shall work for names made only of digits or equal to 0, shall move all tables and views with their definitions, shall complete for a database with at least 500 tables without a request timeout, and shall show its confirmation dialog on screen. | #18105 |
| FR-ISS-129 | **PROPOSED.** When a request refers to something that is missing or invalid (a database that does not exist or cannot be read, an export request without its parameters, a bookmark that has no database), DBLoom shall show a clear not-found, connection or validation message (or the export form) and shall never show an internal error, warning or stack trace. A bookmark shall store the database it was saved for. | #18107, #18185, #18215 |
| FR-ISS-130 | **PROPOSED.** The account list shall show only accounts read from the server's account table; a failure to read or decode an account shall be reported once as an error message and not as an account row. | #18647 |
| FR-ISS-131 | **PROPOSED.** GIS visualization shall render geometries of any SRID the server reports without a script error; where the base map cannot be projected for an SRID, it shall show the geometries without the map and say why. | #18925 |
| FR-ISS-132 | **PROPOSED.** Every list of object names shown to the user (databases, tables, views, triggers, routines, events) shall use one configurable natural sort order, so that tbl_2 sorts before tbl_10 wherever such names are listed. | #18964 |
| FR-ISS-133 | **PROPOSED.** Statements that DBLoom executes shall always quote identifiers with the central quoting function (SEC-TGT-051). A setting shall let the SQL that DBLoom shows, copies or exports quote identifiers only when the target server needs it (reserved words, special characters, leading digits); the default is always quoted, and both forms shall be accepted by MySQL 8.4 and MariaDB 10.11. | #19157 |
| FR-ISS-134 | **PROPOSED.** The SQL editor's parameter binding shall recognise positional ? placeholders as well as named placeholders, and shall offer one input in which all values are entered as a comma-separated list in placeholder order. | #19259 |
| FR-ISS-135 | **PROPOSED.** When a statement fails, the result area shall show only the error, and no rows, row count or query time of an earlier statement. | #19282 |
| FR-ISS-136 | **PROPOSED.** The trigger editor shall let the user set the execution order of triggers with the same timing and event by the server's FOLLOWS or PRECEDES clause where the server supports it, and the trigger list shall show that order. | #19453 |
| FR-ISS-137 | **PROPOSED.** The SQL shown after a routine or event is created or changed shall be executable as shown, including the DELIMITER lines needed for bodies that contain semicolons, and a test shall run the shown text unchanged. | #19578 |
| FR-ISS-138 | **PROPOSED.** The server process list shall accept the active-only filter and the sort by time descending as URL query parameters, so that loading such a URL shows the filtered and sorted list without a form submit. | #19608 |
| FR-ISS-139 | **PROPOSED.** Changing the sort order of a browse result shall show the first page of the newly sorted result, and the page number shall reset to 1. | #19609 |
| FR-ISS-140 | **PROPOSED.** DBLoom shall offer a setting that makes every SQL statement it generates use a database-qualified table name (db.table), and the default shall keep the unqualified form. | #19718 |
| FR-ISS-141 | **PROPOSED.** If DBLoom offers a visual query builder, the generated SELECT shall reference each selected table once, join each table on its declared relation, and run without error on MySQL 8.4 and MariaDB 10.11. | #19723 |
| FR-ISS-142 | **PROPOSED.** The foreign-key editor shall show the stored ON DELETE and ON UPDATE action of an existing constraint as the selected values, so that reopening a constraint saved with RESTRICT shows RESTRICT. | #19752 |
| FR-ISS-143 | **PROPOSED.** The database structure page shall not wait on the row count of a locked table: the exact count shall be bounded by a statement timeout (for example 2 seconds), and on timeout the page shall show the approximate count instead. | #19819 |
| FR-ISS-144 | **PROPOSED.** DBLoom shall send user-entered SQL to the server exactly as typed and shall show it back unchanged: re-running an edited text shall not change it (test: run SELECT 1 -- foobar three times); sorting a result of a user-written query shall not alter the query text, and if the query cannot be sorted safely DBLoom shall sort in the client or disable the sort control and state the reason; session statements such as SET FOREIGN_KEY_CHECKS shall be added only when the user enables an explicit option, off by default. A delimiter may be added to a statement ending in a comment only where execution needs it. | #19973, #17635, #16114 |
| FR-ISS-145 | **PROPOSED.** A saved query with numbered variable placeholders shall show one input per variable number up to the highest number used, and every placeholder in the executed text shall be replaced, including when the numbers have gaps or repeat. | #20348 |
| FR-ISS-146 | **PROPOSED.** When a binary column is displayed as an image, a value that is not a valid image of the declared media type shall show a placeholder or an error for that cell only, and the rest of the result page shall still render. | #20412 |
| FR-ISS-147 | **PROPOSED.** A table whose storage engine is not installed or not supported shall still be listed in the database structure view and the designer with its name and whatever metadata the server returns, unknown values shown as unknown, and neither view shall fail with an error. | #20493 |

### User interface

| ID | Requirement | Issue |
|---|---|---|
| UI-ISS-101 | **PROPOSED.** The table structure view shall mark each index that carries a foreign key and each index that is used by a foreign key of another table, distinguishing outgoing and incoming relations. | #12697 |
| UI-ISS-102 | **PROPOSED.** The SQL editor shall offer an action that runs only the currently selected text when a selection exists, otherwise the whole content. | #12749 |
| UI-ISS-103 | **PROPOSED.** The display value for a referenced row shall be configurable as one or several columns of the target table and shall default to the first text column when none is configured; it may be shown beside the key value in result tables. | #12835 |
| UI-ISS-104 | **PROPOSED.** The multi-row insert form shall offer a way to apply a chosen function (for example NOW()) to the same column of all new rows at once. | #12842 |
| UI-ISS-105 | **PROPOSED.** Write actions (insert, edit, delete, structure changes) shall be hidden or disabled when the connected account lacks the needed privilege, taking column-level privileges into account. | #12997 |
| UI-ISS-106 | **PROPOSED.** In the column editor, the default value of an ENUM or SET column shall be chosen from a list that always reflects the members currently entered in the same form. | #13120 |
| UI-ISS-107 | **PROPOSED.** The add-column form shall let the user add or remove additional column rows before saving, without restarting the dialog. | #13299 |
| UI-ISS-108 | **PROPOSED.** Confirmation dialogs for destructive actions shall state the action and the exact object name in the title or first line, and any SQL statement shown in a confirmation dialog shall be selectable as text and have a button that copies it to the clipboard. | #13747, #17876 |
| UI-ISS-109 | **PROPOSED.** When a recent-items entry refers to a database or table that no longer exists, DBLoom shall show a message saying the item no longer exists and shall remove the entry from the recent list. | #13807 |
| UI-ISS-110 | **PROPOSED.** The foreign-key value picker in the insert and edit forms shall offer creating a new row in the referenced table in a dialog and then select it, without leaving the form. | #14506 |
| UI-ISS-111 | **PROPOSED.** Where a column default is shown, an empty string shall be displayed with a distinct styled label (for example Empty string) that cannot be confused with a literal default text, and NULL or no default shall also be visibly distinct. | #14735 |
| UI-ISS-112 | **PROPOSED.** For binary or file columns holding a PDF, DBLoom shall offer an inline preview and upload and download that keep the file type. | #14743 |
| UI-ISS-113 | **PROPOSED.** The tooltip of a truncated cell value shall show its full length and a leading excerpt of the value (configurable, default 200 characters). | #14767 |
| UI-ISS-114 | **PROPOSED.** DBLoom shall display SQL text and cell values with all whitespace preserved (runs of spaces as typed, long lines still wrapping), and the value view of text and binary columns shall show control characters and special spaces (CR, LF, TAB, non-breaking space, zero-width characters) visibly and offer a read-only hexadecimal view of the stored bytes that does not change the stored value. | #14954, #19707 |
| UI-ISS-115 | **PROPOSED.** DBLoom shall let the user press the Delete key to start deleting the rows selected in the browse grid, and shall still require an explicit confirmation before any row is removed. | #16150 |
| UI-ISS-116 | **PROPOSED.** DBLoom shall draw the chosen label column for every geometry in the GIS visualization whether or not the base map layer is enabled, and the result shall not depend on the order of the map layers. | #16213 |
| UI-ISS-117 | **PROPOSED.** Selecting a database in the navigation shall reload that database's table list from the server, so that objects created or dropped outside DBLoom appear without a manual refresh, and DBLoom shall not poll the server in the background. | #16471 |
| UI-ISS-118 | **PROPOSED.** Hiding a table in the navigation shall ask for confirmation or offer an undo for several seconds, and the hidden tables shall be listed where the user can show them again. | #16566 |
| UI-ISS-119 | **PROPOSED.** After a successful save of a database object (trigger, routine, event, view or table), DBLoom shall clear the unsaved-change state of that form, so that leaving the page shows no confirmation unless the user changed something after the save. | #16598 |
| UI-ISS-120 | **PROPOSED.** When the connected server is MySQL 8.0.17 or later and the user selects ZEROFILL in the column editor, DBLoom shall show a warning that the attribute is deprecated, and the warning shall not block saving. | #16742 |
| UI-ISS-121 | **PROPOSED.** If the navigation tree lets the user hide items, each navigation page shall show the configured number of visible items, so that hidden items leave no gaps and no empty pages. | #17155 |
| UI-ISS-122 | **PROPOSED.** The routine editor shall allow creating a procedure or function with zero parameters, and its save and execute controls shall stay visible and enabled when the parameter list is empty. | #17609 |
| UI-ISS-123 | **PROPOSED.** When the rollback option is enabled for a run, DBLoom shall not show the DML confirmation; when it is disabled, the confirmation shall state that the changes will be committed. | #17627 |
| UI-ISS-124 | **PROPOSED.** Pickers that list many options (the table and column pickers of the foreign-key editor, and the column position selectors such as AFTER) shall filter their options by typed text, so that a database with hundreds of tables or a table with many columns can be searched without scrolling. | #18031, #19874 |
| UI-ISS-125 | **PROPOSED.** The table browse page shall offer an auto-refresh interval (off by default, with at least 30 seconds, 1 minute and 30 minutes), which re-runs the current query keeping the page, sort and search criteria, and which stops when the user selects off or leaves the page. | #18073 |
| UI-ISS-126 | **PROPOSED.** SQL autocomplete shall offer the built-in function names of the connected MySQL 8.4 or MariaDB 10.11 server that match the typed prefix (for example UNIX_ suggests UNIX_TIMESTAMP), and inserting one shall add its parentheses. | #18091, #16327 |
| UI-ISS-127 | **PROPOSED.** Every table-list filter (navigation, database view and export page) shall accept several terms separated by the pipe character and show the tables that match any of them; the export page filter shall also offer substring and regular-expression matching, and select-all there shall apply only to the visible, filtered tables; the filter of the database view shall also match tables that have a column whose name contains the typed text. | #18097, #17742, #12153 |
| UI-ISS-128 | **PROPOSED.** The column visibility menu of a result grid shall be scrollable so that every column can be reached, also for tables with more than 100 columns. | #18336 |
| UI-ISS-129 | **PROPOSED.** When a foreign key is created, the referenced table shall be preselected if a column name matches a table name plus a key column pattern (for example tbl_location_id suggests tbl_location.id), and the user shall be able to change the suggestion. | #18353 |
| UI-ISS-130 | **PROPOSED.** Every chart shall show a tooltip for each of its data points on hover, including charts whose series come from a column, and a failure in one chart shall show an error inside that chart area without breaking the page or other charts. | #18429 |
| UI-ISS-131 | **PROPOSED.** Every rendered page shall contain each id attribute value at most once, and an automated check over all pages shall find no duplicate id. | #19108 |
| UI-ISS-132 | **PROPOSED.** When the user types the first word of a common keyword phrase (at least INNER JOIN, LEFT JOIN, GROUP BY and ORDER BY), SQL autocomplete shall suggest the full phrase and insert it as one unit. | #19178 |
| UI-ISS-133 | **PROPOSED.** The login form shall pre-select the server that the user chose last time in the same browser, when that server is still configured, and this feature shall store no credential. | #19297 |
| UI-ISS-134 | **PROPOSED.** A setting, off by default, shall place keyboard focus in the first empty login field when the login page loads, and the login page shall remain fully usable without it. | #19340 |
| UI-ISS-135 | **PROPOSED.** DBLoom SQL autocomplete shall match names by subsequence as well as by prefix, so that typing the first letters of each underscore-separated part (for example pmu for prefix_modulename_users) suggests the matching name. | #19649 |
| UI-ISS-136 | **PROPOSED.** DBLoom shall decode and display table and column comments with the same character set on every page, so that non-ASCII text such as CJK characters looks identical in browse and in structure. | #19658 |
| UI-ISS-137 | **PROPOSED.** The browse and result pages shall show the displayed row range 1-based (rows 1-17 of 17 for a first page of 17 rows), consistent with LIMIT numbering; for a CALL statement that returns a result set, the range shall match the rows actually shown, and either paging is applied consistently or it is disabled for that result with a visible notice. | #19890, #17861 |
| UI-ISS-138 | **PROPOSED.** The inline SQL edit field shall grow with its content up to a fixed maximum height (about 10 lines), so that earlier lines do not scroll out of view while typing a short multi-line query. | #19917 |
| UI-ISS-139 | **PROPOSED.** The table list of a database shall show each table's reclaimable free space (DATA_FREE from the server statistics) next to its data and index size. | #19921 |
| UI-ISS-140 | **PROPOSED.** Result grids shall show long values of every type, including geometry and binary, truncated to the configured partial-text length in every result set, including joined results and results without a unique key, and shall not show the full value inline while partial texts is selected. | #20430 |

### Security

| ID | Requirement | Issue |
|---|---|---|
| SEC-ISS-101 | **PROPOSED.** On connecting, DBLoom shall refuse a server below the minimum version with a message naming the version (ARCH-TGT-003), and for a supported version that is past or within six months of its vendor end of life shall show a non-blocking notice naming the version. | #12356 |
| SEC-ISS-102 | **PROPOSED.** The second-factor challenge page shall always offer a logout action and, after a failed or timed-out attempt, a retry without reloading the page. | #14132 |
| SEC-ISS-103 | **PROPOSED.** The authentication log shall contain exactly one entry per login, failed login and logout, a logout shall be recorded as a logout, and each entry shall contain the target server identifier (configured name or host and port) together with the user name. | #14720, #17415 |
| SEC-ISS-104 | **PROPOSED.** After session expiry, a new login shall connect to the server chosen on the login form in every case; a test with the same credentials on two servers shall show the chosen server connected. | #16081 |
| SEC-ISS-105 | **PROPOSED.** DBLoom shall let a user enrol more than one second factor (several passkeys, a hardware key and an authenticator app) and remove any one of them, and shall refuse to remove the last remaining factor unless two-factor authentication is switched off for that user. When two-factor authentication is required by the administrator policy (SEC-TGT-014), a user without a second factor shall be able to do nothing but enrol one before getting any other access. | #16347, #15472, #14335 |
| SEC-ISS-106 | **PROPOSED.** When DBLoom changes one scope of an account's privileges (global, database or table), it shall leave the grants of every other scope unchanged, and it shall leave the authentication data of the account unchanged. A test shall show with SHOW GRANTS that a database-level grant survives a change of the global privileges, and shall compare the authentication string and plugin before and after, finding no field set to null. | #16446, #18794 |
| SEC-ISS-107 | **PROPOSED.** DBLoom shall connect to accounts that use the client_ed25519 authentication plugin on MariaDB 10.11, or shall refuse the login with a message that names the unsupported plugin. | #17200 |
| SEC-ISS-108 | **PROPOSED.** A failed connection to a target server, including a refusal because the server has too many connections, shall not end the DBLoom login session; the user shall see the connection error and be able to retry. | #17355 |
| SEC-ISS-109 | **PROPOSED.** The privilege editor shall list and grant the global dynamic privileges that the connected MySQL server reports (including SHOW_ROUTINE) and shall not offer a privilege the server does not support. | #17537 |
| SEC-ISS-110 | **PROPOSED.** After a privilege change DBLoom shall re-read the grants of the account and shall report an error naming each privilege that was requested to be removed but is still held, instead of reporting success. When a grant or revoke is built for a database name containing _ or %, the scope shall match exactly that database, verified on MySQL 8.4 and MariaDB 10.11. | #17699, #17612 |
| SEC-ISS-111 | **PROPOSED.** DBLoom shall default new and changed accounts to caching_sha2_password, shall offer mysql_native_password only when the connected server reports it as enabled, and shall show a deprecation notice when a user chooses it. | #18586 |
| SEC-ISS-112 | **PROPOSED.** The login page may be prefilled with a server and username given as URL parameters, but a password shall never be accepted from a URL, and a URL with a username shall not log the user in. | #19502 |
| SEC-ISS-113 | **PROPOSED.** DBLoom shall show a visible warning on the account overview and on the account edit page for every account that holds global INSERT or UPDATE privilege but not CREATE USER, because such an account can modify privilege data directly. | #19617 |
| SEC-ISS-114 | **PROPOSED.** Rendering the login page or another unauthenticated page shall not change the session identifier or the CSRF token of an existing session; the identifier shall be regenerated at successful login (SEC-TGT-040), so a login form rendered earlier still submits after other requests. | #20462 |
| SEC-ISS-115 | **PROPOSED.** When a user is given the grant option at global, database, table or routine scope, DBLoom shall generate the grant so that the option is set on MySQL 8.4 and MariaDB 10.11 (for example with WITH GRANT OPTION), the resulting privileges shall equal those of the equivalent manual GRANT statement, and the privilege editor shall show the option as granted after saving. | #20521, #19605 |

### Non-functional

| ID | Requirement | Issue |
|---|---|---|
| NFR-ISS-101 | **PROPOSED.** A long-running statement started by a user shall not block other requests of the same session or user, so that a second browser tab stays usable while an ALTER runs. | #12724 |
| NFR-ISS-102 | **PROPOSED.** Importing a dump through DBLoom shall take no more than a stated factor of the time of the mysql client for the same file (the factor is set in the quantitative targets, OPEN.md item 5), and a test with a 100 MB dump shall measure it. | #14397 |
| NFR-ISS-103 | **PROPOSED.** Opening the table list of a database with 15,000 tables shall use a bounded number of metadata queries (not one or more per table, such as SHOW INDEXES), shall render the first page within 5 seconds on the reference environment of the performance tests, and shall load index details only for the displayed tables. | #17497 |
| NFR-ISS-104 | **PROPOSED.** During an import the session shall hold only progress metadata; the session entry shall not grow by more than 4 KB during an import, whatever the size of the file. | #18692 |
| NFR-ISS-105 | **PROPOSED.** DBLoom shall not load the query history on page load; it shall fetch the history only when the user opens the history view, and page load time shall not depend on the number of stored history entries. | #19694 |

## 3. Duplicates and conflicts resolved

- **#12915 + #16054, #12314** (FR-ISS-108): same need: failed statements must show a readable error and the statement
- **#13747 + #17876** (UI-ISS-108): same component: confirmation dialogs
- **#19973 + #17635, #16114** (FR-ISS-144): same rule: user-written SQL is never changed
- **#15176 + #16018** (FR-ISS-114): same topic: LOCK TABLES
- **#12156 + #17051** (FR-ISS-103): same need: paging, sorting and export of a result must be consistent with the session that produced it
- **#16047 + #15506** (FR-ISS-118): **Conflict.** 16047 recorded every generated statement as its own entry, 15506 wanted one entry per submission; both kept by separating user-submitted from generated statements
- **#17699 + #17612** (SEC-ISS-110): same need: privilege changes are verified
- **#20521 + #19605** (SEC-ISS-115): same requirement: grant option
- **#16446 + #18794** (SEC-ISS-106): same rule: a privilege change touches nothing else
- **#16347 + #15472, #14335** (SEC-ISS-105): same need: several second factors; 14335 (require 2FA) is already SEC-TGT-014 and only its enrolment rule is kept here
- **#14720 + #17415** (SEC-ISS-103): same log
- **#18097 + #17742, #12153** (UI-ISS-127): same component: name filter of table lists
- **#18031 + #19874** (UI-ISS-124): same need: long pickers must be searchable
- **#18091 + #16327** (UI-ISS-126): same requirement: function names in autocomplete
- **#17397 + #17035** (DATA-ISS-115): same rule: text is stored exactly
- **#14954 + #19707** (UI-ISS-114): same need: show whitespace and control characters
- **#19411 + #15386** (DATA-ISS-127): same export option
- **#19725 + #6225** (DATA-ISS-130): **Conflict.** 6225 wanted a fixed order by name, 19725 wanted referenced tables first; both hold when the order is dependency order with ties broken by name
- **#19759 + #13757, #16215** (DATA-ISS-131): **Conflict.** 13757 rewrote schema references in copied views, 19759 forbade rewriting; the rule below allows only a tokenizer-based replacement of the source-schema qualifier
- **#20190 + #20095** (DATA-ISS-135): same need: foreign keys of system-versioned tables; the general catalog rule is DATA-ISS-017 of file 16
- **#17401 + #18173** (DATA-ISS-116): same need: charset errors in imports
- **#18107 + #18185, #18215** (FR-ISS-129): same rule: invalid input gets a controlled message
- **#15222 + #17667, #19667** (FR-ISS-116): same component: server status advisor
- **#16699 + #16891, #18062** (DATA-ISS-113): same flow: checks before creating or changing a foreign key
- **#19890 + #17861** (UI-ISS-137): same rule: displayed row range
- **#14923 + #13331** (FR-ISS-113): same flow: starting an import
- **#14913 + #15981** (FR-ISS-112): **Conflict.** 14913 kept several authenticated connections, 15981 spoke of a session bound to one server; both hold when every request carries its own connection context
- **#19157** (FR-ISS-133): **Conflict.** quoting only when needed conflicted with SEC-TGT-051 (one central quoting function); now it applies only to displayed or exported text
- **#12356** (SEC-ISS-101): **Conflict.** the notice for servers below the minimum conflicted with ARCH-TGT-003 (such servers are refused)
- **To file 16:** #13449 into FR-ISS-004; #19021 into UI-ISS-006; #18761 into UI-ISS-006; #19017 into UI-ISS-003; #12559 into UI-ISS-003.
- **Dropped:** #18970 (Cosmetic click target of a legacy navigation icon; dropped in the duplicate and conflict review.)
- **Also found:** #14335 (require two-factor authentication) is already SEC-TGT-014 and only its enrolment rule was kept; DATA-ISS-017 of file 16 was reworded to the general rule that table structure is read from the catalog, and #20190 is its system-versioned case.

## 4. Disposition of every reviewed issue

| Issue | Title | Disposition | Target or reason |
|---|---|---|---|
| #5547 | Export split archives | MERGE | DATA-ISS-002 |
| #5852 | Export Records and Relations | ACCEPT | DATA-ISS-101 |
| #6096 | Export tables list must be ordered by constraints | DROP | Maintainers noted constraints are already emitted at the end of the export so table ordering is not needed. |
| #6225 | Make export sql more friendly to side-by-side comparison | DUPLICATE | duplicate of DATA-ISS-130 (#19725) |
| #6331 | Icons of keys, FK cell value, translation. | DROP | Mixed request (key icons, FK display, translations); translation answered, FK display exists as relational display column, icons cosmetic. |
| #6350 | unhex() in exports | DROP | Wants every value exported as unhex() calls for supposed injection safety; weak rationale, proper escaping suffices. |
| #9887 | Missing variables on partial import | MERGE | DATA-ISS-005 |
| #11392 | Support high-resolution displays | DROP | High-resolution icons were fixed upstream with SVG icons and DBLoom uses resolution-independent assets. |
| #11571 | FEATURE: Handle COLUMN_JSON | DROP | Wants MariaDB dynamic column COLUMN_JSON display; niche legacy feature, workaround is a CAST in the query. |
| #11909 | can't insert row into table that contains generated column | ACCEPT | DATA-ISS-102 |
| #12031 | Adding group by functionality in table itself. | DROP | Vague idea of a group-by icon in the browse grid, no agreed design and unresolved clutter concern. |
| #12087 | Allow setting session variables (eg: sql_mode) | ACCEPT | FR-ISS-101 |
| #12102 | Default DB | ACCEPT | FR-ISS-102 |
| #12117 | Back not working correctly on export | MERGE | UI-ISS-001 |
| #12150 | Doesn't detect duplicate index | COVERED | FR-DTB-064 |
| #12153 | Filtering: Exporting tables | DUPLICATE | duplicate of UI-ISS-127 (#18097) |
| #12156 | Unable to browse results when SQL contains a user defined variable | ACCEPT | FR-ISS-103 |
| #12267 | Proposal: add option to set warning if more than X rows are affected b | ACCEPT | FR-ISS-104 |
| #12286 | Designer should remember expanded/collapsed state | DROP | Designer layout detail with no discussion; designer scope is undecided and the item is cosmetic. |
| #12312 | Adding a common prefix for column names | DROP | Maintainers called a common column-name prefix a minor use case that would complicate the interface. |
| #12314 | Better error reporting when creating routines | DUPLICATE | duplicate of FR-ISS-108 (#12915) |
| #12353 | Setup script: suggest using SSL when available | DROP | Concerns the legacy setup script; TLS failure reporting for targets is already in SEC-ISS-001 and the thread doubted the approach. |
| #12356 | Warn user when using an outdated or vulnerable MySQL version | ACCEPT | SEC-ISS-101 |
| #12377 | Reduce metadata exposure in PDF report | DROP | PDF export with TCPDF metadata is legacy specific and PDF export is not a DBLoom requirement. |
| #12381 | DROP database and user privileges | ACCEPT | FR-ISS-105 |
| #12428 | Dumps containing "SET NAMES utf8mb4" sometimes cause collation errors  | DROP | Charset mismatch of old dumps with a collation dropdown that could not select utf8; vague and mostly a support question. |
| #12466 | Use Prepared Statements instead of Dynamic SQL Queries when possible | DROP | Maintainers argued prepared statements are unsuitable for this tool and decided not to pursue; it is an implementation detail. |
| #12467 | Use Strict SQL_MODE by default | DROP | Too vague and an implementation choice; session SQL mode is set by DBLoom's own connection policy. |
| #12506 | Improve the update message | DROP | Update-notice wording of the legacy app; release-notes link already added and the rest is cosmetic. |
| #12559 | [shortcuts] WRT Ctrl navigation in grid editor #6068 | MERGE | UI-ISS-003 |
| #12697 | Foreign keys user-experience enhancement | ACCEPT | UI-ISS-101 |
| #12724 | Session locking | ACCEPT | NFR-ISS-101 |
| #12725 | Sugestion - Run SQL in all (or selected) databases | ACCEPT | FR-ISS-106 |
| #12728 | Back-link on database-privileges edit page | DROP | Vague complaint about a missing back link on one legacy page; no discussion. |
| #12749 | Run the mouse selected query | ACCEPT | UI-ISS-102 |
| #12835 | Text to display for foreign keys | ACCEPT | UI-ISS-103 |
| #12842 | MySQL data function shortcut on insert rows no longer works | ACCEPT | UI-ISS-104 |
| #12870 | Export using user defined variables results in NULL | MERGE | FR-ISS-014 |
| #12893 | Change table types for a group of tables | ACCEPT | FR-ISS-107 |
| #12915 | Feature request for slow systems in memory or bandwidth | ACCEPT | FR-ISS-108 |
| #12970 | Adding key to text field doesn't prompt for required key size | ACCEPT | FR-ISS-109 |
| #12971 | Export Database structure with MSSQL compatibility fails to create tab | ACCEPT | DATA-ISS-103 |
| #12997 | Read Only fields | ACCEPT | UI-ISS-105 |
| #13012 | Hiding Tables in Server Overview doesn't reduce the Pages | MERGE | FR-ISS-004 |
| #13027 | Report also count query timings | MERGE | DATA-ISS-016 |
| #13036 | Disability tools | COVERED | UI-ISS-003 |
| #13043 | Unable to rename column when it's part of a partition | ACCEPT | DATA-ISS-104 |
| #13049 | Choose your layout at main menu | DROP | Vague wish to choose what the main menu shows; thread only points to another layout issue. |
| #13106 | Calculated column value is not being updated after an inline edit | ACCEPT | FR-ISS-110 |
| #13120 | Dropdown when editing enum default value | ACCEPT | UI-ISS-106 |
| #13220 | Document accesibility status (VPAT) | DROP | Request for a VPAT accessibility report document, not a software behaviour. |
| #13299 | Can't add extra columns when adding columns | ACCEPT | UI-ISS-107 |
| #13300 | Option to keep query editable directly | DROP | Maintainer pointed to the existing retain-query-box option; remaining remark is a cosmetic size preference. |
| #13331 | The process to create a table in a database is non-intuitive | DUPLICATE | duplicate of FR-ISS-113 (#14923) |
| #13449 | hide-db globaly for AllowArbitraryServer | MERGE | FR-ISS-004 |
| #13587 | Designer should show tables from other databases by default | DROP | Concerns the legacy designer showing and saving tables of other databases; designer scope deferred and the thread shows no clear reproduction. |
| #13623 | Blocks in the new multi-table query UI should be movable | DROP | Cosmetic and layout suggestion for a legacy multi-table query builder UI. |
| #13624 | Bookmarked search disappeared from the new multi-table query UI | DROP | Answered in the thread: the multi-table query tool never had bookmarks; Query-By-Example was removed. |
| #13652 | Export View is creating table as well | DROP | Thread explains the extra table in a view export is an intentional stand-in to resolve view dependencies on import; reporter did not provide a defect beyond expectation. |
| #13693 | Exporting query results with DISTINCT clause produce SQL with string v | ACCEPT | DATA-ISS-105 |
| #13747 | Drop table confirmation | ACCEPT | UI-ISS-108 |
| #13750 | Order distinct values table by count | DROP | Vague request to sort the per-column distinct-values list by count; users can already sort by clicking the column header. |
| #13757 | "Copy database to" operation creates views referring to the original d | DUPLICATE | duplicate of DATA-ISS-131 (#19759) |
| #13795 | Warning the user before executing a query not using index | DROP | Maintainer states a reliable index check needs EXPLAIN on every query, which is too costly; manual explain is already covered by FR-TGT-231. |
| #13807 | Improve error message when Recent table/database doesn't exist | ACCEPT | UI-ISS-109 |
| #13843 | Better integrate storing user preferences in browser local storage | DROP | Concerns browser local storage fallback for the legacy configuration storage; DBLoom stores preferences server-side per user. |
| #13845 | Foreign key constraints with IF NOT EXISTS | ACCEPT | DATA-ISS-106 |
| #13879 | Confusion around settings RowActionType/ActionLinksMode | DROP | Confusion between two legacy config options for action icons; partly fixed and specific to legacy settings. |
| #13916 | Cannot make seperate connection on NamedPipe(Windows) | DROP | Named pipe connection hang on Windows; answered in thread as a PHP or setup problem (use socket or TCP). |
| #13937 | Table Search Slow w/ Foreign Keys | MERGE | DATA-ISS-012 |
| #13943 | Adaptive Fonts | DROP | Request for bigger adaptive fonts on large monitors; vague and handled by browser zoom and theming. |
| #13944 | Deleting a pma database user deletes all legacyadmin data | DROP | Deleting a MySQL user wiped the legacy configuration-storage data; DBLoom keeps its own data separate from server accounts. |
| #13949 | Actions are in More menu while there's plenty of space. | DROP | Layout of row action menu in legacy structure page; answered with a config option and cosmetic. |
| #13959 | Too many fields(>13 in my case) in a table leading to page overflow | MERGE | UI-ISS-006 |
| #14081 | Migrate feature of ODS import to CSV import: First column contains col | ACCEPT | DATA-ISS-107 |
| #14100 | Add support for encrypted .zip files for import and export | DROP | Niche request for password-protected zip import/export; better handled by encrypting files outside the app, and covered partly by compression support. |
| #14129 | Allow Multiple U2F Devices | COVERED | SEC-TGT-011 |
| #14132 | 2FA Request Page Enhancements | ACCEPT | SEC-ISS-102 |
| #14215 | Bar graph has fixed height | MERGE | NFR-ISS-002 |
| #14300 | Importing a SQL TRIGGER statement with backslash as content, and then  | MERGE | DATA-ISS-004 |
| #14335 | Force two-factor auth | DUPLICATE | duplicate of SEC-ISS-105 (#16347) |
| #14366 | Add high-level column types and integrate data to external websites | DROP | Custom pseudo column types; maintainers pointed to existing transformation plugins and the reporter built them that way. |
| #14396 | Support using hexadecimal constants in input fields for numeric values | ACCEPT | DATA-ISS-108 |
| #14397 | Too much time for a database import | ACCEPT | NFR-ISS-102 |
| #14506 | Suggestion: Adding a link to create entry into related table2 when ins | ACCEPT | UI-ISS-110 |
| #14526 | Can't add index in edit field form. | MERGE | DATA-ISS-011 |
| #14578 | Changing collations may need to drop and recreate stored procedures | ACCEPT | FR-ISS-111 |
| #14655 | column without index, Foreign Key auto to be default indexed, missing  | DROP | Report is unclear and the second foreign key is covered by the primary key prefix, so no separate index is expected; no resolution in thread. |
| #14720 | AuthLog: sucessful logins repeated in log file, logouts not correctly  | ACCEPT | SEC-ISS-103 |
| #14735 | Empy string default | ACCEPT | UI-ISS-111 |
| #14743 | Support PDF format in Input/OutputTransformation | ACCEPT | UI-ISS-112 |
| #14767 | Tooltip for truncated strings | ACCEPT | UI-ISS-113 |
| #14872 | Suggest showing connection time zone when displaying / inserting times | ACCEPT | DATA-ISS-109 |
| #14913 | Saved Logins for Server Switching. | ACCEPT | FR-ISS-112 |
| #14917 | Not possible to use an iprange or cidr in TrustedProxies | COVERED | SEC-TGT-127 |
| #14923 | DB import should ask confirmation | ACCEPT | FR-ISS-113 |
| #14954 | Allow displaying exact string contents (VARCHAR as binary or hexadecim | ACCEPT | UI-ISS-114 |
| #14989 | Text size controller button in legacyadmin, SQL. | DROP | The font-size control was removed upstream in favour of browser zoom, and the thread ends with the default size as a matter of taste. |
| #15020 | [shortcuts] "Goto Anything" navigation like Sublime Text | MERGE | UI-ISS-003 |
| #15125 | Alignment of any modal is not flexible | MERGE | UI-ISS-006 |
| #15143 | select @var issue | MERGE | FR-ISS-014 |
| #15176 | LegacyAdmin hangs on LOCK TABLES statement with MySQL 5.7 | ACCEPT | FR-ISS-114 |
| #15195 | Positioning Panel | DROP | Cosmetic placement of the logout control; the thread is a layout preference with no agreed design, and DBLoom defines its own navigation. |
| #15203 | copy row/edit and insert as new does not consider different UPDATE/INS | MERGE | FR-ISS-002 |
| #15209 | `Warning: #1287 'SHOW PROFILE' is deprecated and will be removed in a  | ACCEPT | FR-ISS-115 |
| #15222 | Server Status Advisor: Increase or Decrease key_buffer_size? | ACCEPT | FR-ISS-116 |
| #15291 | pagination allowed behind last row in view | MERGE | DATA-ISS-016 |
| #15317 | LegacyAdmin silently ignores MySQL errors on export | MERGE | DATA-ISS-001 |
| #15383 | User requires mysql.proc SELECT access to execute routines | ACCEPT | FR-ISS-117 |
| #15386 | ZIP Export with discrete table files have indexes elsewhere! | DUPLICATE | duplicate of DATA-ISS-127 (#19411) |
| #15443 | Enhance CSV export - include table structure | DROP | Request for an extra structure file next to a CSV export; a convenience request with no maintainer decision, and the structure can already be exported in the SQL format. |
| #15449 | Suggestions missing in autocomplete | MERGE | UI-ISS-002 |
| #15472 | Two factor authentication should allow more than one U2F device | DUPLICATE | duplicate of SEC-ISS-105 (#16347) |
| #15506 | History table saving only last query in multi query statement | DUPLICATE | duplicate of FR-ISS-118 (#16047) |
| #15523 | inline editing in "select distinct" does not quote the values correctl | ACCEPT | DATA-ISS-110 |
| #15599 | Popup disappears too fast | DROP | Report without reproduction steps; the maintainers could not identify the popup, and the thread ended without a fix. |
| #15815 | For Designer: retain Designer Page (for the session) after bouncing ba | DROP | Convenience request to restore the legacy Designer page after navigating away; not a defect and it depends on the legacy Designer, which is an open scope item (OPEN item 7). |
| #15825 | X XPRIMARY clipboard doesn't work in text areas | DROP | Clipboard primary-selection behaviour depends on the X11 session, the browser and the editor widget; it is not a DBLoom requirement that can be tested. |
| #15890 | Bad Ui: Chart not responsive ( navigation -> status -> query statistic | MERGE | UI-ISS-006 |
| #15900 | Request response error text | MERGE | FR-ISS-012 |
| #15920 | Edit row in new tab destroys session in both tabs with multi server se | MERGE | FR-ISS-006 |
| #15961 | Non intuitive UI on search Results Page | DROP | Cosmetic request to render result toggles as buttons on the legacy results page; a visual design choice with no functional defect. |
| #15964 | There should be a quick guide for beginners (after installation proces | DROP | Onboarding tips and a beginner guide are a documentation feature request, not a defect, and are not testable as a requirement. |
| #15981 | "Current Server" list breaks per server "ssl" parameter when using Sig | DUPLICATE | duplicate of FR-ISS-112 (#14913) |
| #15993 | do not expose PMA_VERSION in requests | MERGE | NFR-ISS-001 |
| #16018 | Lock tables does not work from legacyadmin.... But ok from SQL Client l | DUPLICATE | duplicate of FR-ISS-114 (#15176) |
| #16020 | [shortcuts] keyboard shortcut to Clear MySQL command window? | DROP | Minor keyboard convenience to clear the console; no defect, and the thread only confirms it could be nice. |
| #16024 | relation between tables | DROP | Request to use a SET column as a multi-value relation picker; this models a many-to-many link that the DBLoom foreign-key model does not provide and is not a defect of the picker. |
| #16047 | SQL history doesn't log generated queries | ACCEPT | FR-ISS-118 |
| #16054 | With long routines, error messages  can't be read | DUPLICATE | duplicate of FR-ISS-108 (#12915) |
| #16081 | Logged in to wrong server after session timeout | ACCEPT | SEC-ISS-104 |
| #16114 | Unable to order a SQL query | DUPLICATE | duplicate of FR-ISS-144 (#19973) |
| #16150 | Capturing “Delete” Keypress and remove selected elements | ACCEPT | UI-ISS-115 |
| #16213 | Chosen label not shown on GIS-visualization. | ACCEPT | UI-ISS-116 |
| #16215 | Renaming a database, table, or column should adjust view definitions t | DUPLICATE | duplicate of DATA-ISS-131 (#19759) |
| #16242 | Routine export to include DROP | ACCEPT | DATA-ISS-111 |
| #16243 | Could the "Edit Routine" modal remember its last position and size? | DROP | Remembering the size and position of the routine editor dialog is a cosmetic convenience with no effect on data or behaviour. |
| #16270 | LOCK/UNLOCK commands in imported sql dumps files generate warnings | ACCEPT | FR-ISS-119 |
| #16327 | Obvious functions missing in type autocomplete suggestions | DUPLICATE | duplicate of UI-ISS-126 (#18091) |
| #16347 | Support hardware token and app 2FA simultanously | ACCEPT | SEC-ISS-105 |
| #16358 | Page selector of tables subtree in left panel randomly disappears | MERGE | FR-ISS-005 |
| #16408 | Display "Packed" for indexes fro MyISAM tables only | MERGE | UI-ISS-007 |
| #16446 | Changing a user's global privileges revokes all database-specific ones | ACCEPT | SEC-ISS-106 |
| #16471 | click on the database, Left navigation did not refresh | ACCEPT | UI-ISS-117 |
| #16518 | [Mozilla Firefox] 5.0.4  right click copy in SQL | DROP | The reported Firefox failure was disputed in the thread: a maintainer showed right-click copy working after selecting text in Firefox 86, and the 2022 follow-up was never answered, so no testable defect remains. |
| #16535 | Link to foreign records referencing a certain primary key / Inverse di | ACCEPT | DATA-ISS-112 |
| #16566 | Confirm before hiding tables or allow undo operation | ACCEPT | UI-ISS-118 |
| #16598 | Security question for unsaved changes after save trigger | ACCEPT | UI-ISS-119 |
| #16699 | Designer should warn when trying to create relationships of different  | ACCEPT | DATA-ISS-113 |
| #16702 | Saving default transformation settings | ACCEPT | FR-ISS-120 |
| #16742 | ZEROFILL is deprecated and will be removed in MySQL | ACCEPT | UI-ISS-120 |
| #16763 | A PHP warning is given when the SQL server is shutdown or restarted | ACCEPT | FR-ISS-121 |
| #16788 | [tree] Unable to load a DB contents on another page | MERGE | FR-ISS-005 |
| #16856 | IPv6 servers: don't enforce brackets | ACCEPT | FR-ISS-122 |
| #16858 | Add ability to fix unit type of output numbers in single output block  | DROP | Request to force one display unit per numeric column block; the Size column is sortable, so values can be compared without changing the display. |
| #16861 | [MariaDB 10.5] Privileges changes | MERGE | FR-ISS-002 |
| #16891 | Designer should warn if trying to define a new relationship reference  | DUPLICATE | duplicate of DATA-ISS-113 (#16699) |
| #17035 | Changing Value in enum column type is not changing when we have space  | DUPLICATE | duplicate of DATA-ISS-115 (#17397) |
| #17038 | LegacyAdmin storage detection false positive working table & using the  | DROP | Defect in the legacy detection of the la_ configuration storage tables, which checks the wrong database; it is specific to the LegacyAdmin storage tables. |
| #17051 | Add Edit, Pagination, and export handling-options for multi-statement  | DUPLICATE | duplicate of FR-ISS-103 (#12156) |
| #17099 | Mention the database name in some errors. | DROP | Request to add the database name to error messages; the maintainers declined because the wording comes from the database server and should not be changed by the client. |
| #17155 | Hidden tables don't flow into previous tree pages | ACCEPT | UI-ISS-121 |
| #17189 | Redoing column visibility / order property to keep it while tables cha | ACCEPT | DATA-ISS-114 |
| #17200 | Implements ed25519 authentication method | ACCEPT | SEC-ISS-107 |
| #17273 | Password generation should satisfy mySQL validate password plugin sett | MERGE | FR-ISS-009 |
| #17312 | Filtering broken when table have a primary key | COVERED | FR-DTB-091 |
| #17328 | #1054 - Unknown column 'undefined' in 'where clause' and #1064 - You h | MERGE | DATA-ISS-015 |
| #17342 | Uncaught TypeError: can't access property "split", string is undefined | ACCEPT | FR-ISS-123 |
| #17355 | LegacyAdmin resets session data when server reaches maximum concurrent  | ACCEPT | SEC-ISS-108 |
| #17357 | Adding subquery into select list causes fatal error | ACCEPT | FR-ISS-124 |
| #17397 | Multiline on textarea doesn't work if string has multiple spaces | ACCEPT | DATA-ISS-115 |
| #17401 | iconv(): Detected an illegal character in input string | ACCEPT | DATA-ISS-116 |
| #17415 | Logging the SQL host on the authentication log | DUPLICATE | duplicate of SEC-ISS-103 (#14720) |
| #17419 | stored procedure is missing support for charset collation | ACCEPT | DATA-ISS-117 |
| #17425 | GIS visualisation ends up in a very high cost query | MERGE | NFR-ISS-002 |
| #17452 | Access denied to "SHOW MASTER LOGS" at every login/logout | MERGE | FR-ISS-002 |
| #17479 | USE command not working from within a database | MERGE | FR-ISS-014 |
| #17497 | big trouble using legacyadmin with large databases with 15k tables. Any | ACCEPT | NFR-ISS-103 |
| #17502 | It is not possible to set password for legacyadmin user using configura | DROP | The password configuration wizard of the Debian and Ubuntu package rejected a password the MySQL policy accepts, and the thread attributes the case to the packaged installer and the MySQL policy. |
| #17537 | Add SHOW_ROUTINE global privilage option | ACCEPT | SEC-ISS-109 |
| #17548 | Sort Columns in the Sidebar | DROP | Request to sort sidebar columns by column order and to relabel the MUL key indicator; cosmetic, and the thread shows no decision. |
| #17564 | Copy/Move Column | DROP | Request to copy or move columns between tables; the thread shows no maintainer agreement and the data movement semantics are undefined, so it is a feature proposal and not yet a requirement. |
| #17597 | TypeError: LegacyAdmin\Export::getFilenameAndMimetype(): Argument #5 ($ | MERGE | DATA-ISS-002 |
| #17609 | Execute button disappears on creating new PROCEDURE when removing last | ACCEPT | UI-ISS-122 |
| #17612 | Backslash being added to database names when granting privileges to a  | DUPLICATE | duplicate of SEC-ISS-110 (#17699) |
| #17618 | UI/UX regression: Missing tbl_group link in navigation tree for groups | MERGE | UI-ISS-004 |
| #17627 | Hide confirmation request if "Rollback when finished" | ACCEPT | UI-ISS-123 |
| #17628 | Display output of `DELETE … RETURNING …` | ACCEPT | FR-ISS-125 |
| #17635 | Semicolon repeatedly suffixed onto SQL if query ends in comment | DUPLICATE | duplicate of FR-ISS-144 (#19973) |
| #17667 | Advisor: Suboptimal caching method VS The query cache is not enabled | DUPLICATE | duplicate of FR-ISS-116 (#15222) |
| #17699 | No change after permission revoke | ACCEPT | SEC-ISS-110 |
| #17742 | Search for fields (columns) within the search tool | DUPLICATE | duplicate of UI-ISS-127 (#18097) |
| #17834 | [Feature] Execute multiple queries from the query textbox inside one t | ACCEPT | FR-ISS-126 |
| #17861 | Paging issue with Stored Procedure Results | DUPLICATE | duplicate of UI-ISS-137 (#19890) |
| #17876 | Copy Query to Clipboard Feature from the Modal-Box. | DUPLICATE | duplicate of UI-ISS-108 (#13747) |
| #18031 | Dropdown in "Create relation" to Select2 Widget | ACCEPT | UI-ISS-124 |
| #18037 | LegacyAdmin does not stream the export data when "Add CREATE PROCEDURE  | MERGE | DATA-ISS-002 |
| #18057 | Uncaught TypeError: Cannot read properties of undefined (reading 'trim | DROP | Uncaught JavaScript TypeError in the legacy designer's save-page flow with no comments; it depends on the designer feature (OPEN.md item 7) and has no requirement independent of it. |
| #18062 | "Online"/Instant Foreign Key updates | DUPLICATE | duplicate of DATA-ISS-113 (#16699) |
| #18073 | Please add "auto-refresh" feature to the table view | ACCEPT | UI-ISS-125 |
| #18091 | Obvious suggestions missing in autocomplete | ACCEPT | UI-ISS-126 |
| #18097 | Filter tables - " " character | ACCEPT | UI-ISS-127 |
| #18104 | Create view button doesn't unbind jQuery events | ACCEPT | FR-ISS-127 |
| #18105 | Rename database has multiple bugs | ACCEPT | FR-ISS-128 |
| #18107 | Undefined array key 0 | ACCEPT | FR-ISS-129 |
| #18173 | Internal error: TypeError: `LegacyAdmin\Encoding::convertString()`: Ret | DUPLICATE | duplicate of DATA-ISS-116 (#17401) |
| #18183 | TypeError: preg_replace(): Argument #3 ($subject) must be of type arra | ACCEPT | DATA-ISS-118 |
| #18185 | TypeError: LegacyAdmin\Controllers\Export\ExportController::setGlobalsF | DUPLICATE | duplicate of FR-ISS-129 (#18107) |
| #18215 | LegacyAdmin\Dbal\InvalidDatabaseName: The database name must be a non-e | DUPLICATE | duplicate of FR-ISS-129 (#18107) |
| #18323 | MySQLTutorial classicmodels sample database fails to load due to PHPMy | ACCEPT | DATA-ISS-119 |
| #18336 | Toggle column visibility menu does not scroll to the end | ACCEPT | UI-ISS-128 |
| #18353 | Feature: Use Select2 with search field in "create relation to foreign  | ACCEPT | UI-ISS-129 |
| #18358 | Creating Relations: Automatic pre-selection based on normalization | DROP | Feature idea to auto-select the referenced table in the relation dialog; the description is unclear and no maintainer agreed to it. |
| #18429 | Uncaught TypeError: can't access property 0, neighbor.data is undefine | ACCEPT | UI-ISS-130 |
| #18515 | View export missing when contain union statement | ACCEPT | DATA-ISS-120 |
| #18539 | LegacyAdmin extremely slow on view. Ability to disable row editing on v | ACCEPT | DATA-ISS-121 |
| #18560 | Uncaught TypeError: can't access property 0, chartData[key][j] is unde | DROP | Not reproducible (no steps), and the system monitor chart code it concerns was replaced by a different chart library in the 6.0 development line. |
| #18572 | Show this query here again checkbox configuration | DROP | Default state of one legacy checkbox on the SQL page; a cosmetic per-install default, the same class as #18637 which is already dropped. |
| #18586 | mysql_native_password authentication plugin is deprecated in MySQL 8.1 | ACCEPT | SEC-ISS-111 |
| #18647 | v. 5.2.1 displays errors messages as user accounts | ACCEPT | FR-ISS-130 |
| #18692 | Import data is stored in session | ACCEPT | NFR-ISS-104 |
| #18708 | Unable to work with foreign keys when partial unique index exist. | DROP | Report does not say what fails when a partial unique index with a functional key part exists; not reproduced, the maintainer asked for the bug location, and the thread is stale. |
| #18754 | Integrate explainmysql.com to Help With Understanding EXPLAIN Output | DROP | Asks to send EXPLAIN plans to a third-party service; sending query plans off-site conflicts with the self-hosted design, and the local display of explain output is already required by FR-TGT-231. |
| #18761 | LegacyAdmin login page - Language: German - username and colon behind n | MERGE | UI-ISS-006 |
| #18794 | Changing privileges deletes the user password | DUPLICATE | duplicate of SEC-ISS-106 (#16446) |
| #18802 | Wrong row total for LegacyAdmin 5.2.1 with query including "LEFT JOIN"  | MERGE | DATA-ISS-016 |
| #18842 | Abrir um arquivo pdf/docx/word salvo em um blob | DROP | Support question (Portuguese) about opening a BLOB file as PDF; answered in the thread by renaming the file extension. |
| #18898 | Columns header transparent when scrolling | DROP | Cosmetic transparent header background, marked as a duplicate and fixed by a commit in the thread. |
| #18925 | GIS Visualization issue - Uncaught TypeError: can't access property "g | ACCEPT | FR-ISS-131 |
| #18964 | `$cfg['NaturalOrder']` is ignored in Create new trigger modal | ACCEPT | FR-ISS-132 |
| #18967 | "Browse foreign values" should show correct uuid keys | MERGE | DATA-ISS-013 |
| #18970 | Mouse pointer not accurate when hovering or clicking icons in sidebar | DROP | Cosmetic click target of a legacy navigation icon; dropped in the duplicate and conflict review. |
| #18997 | Export/Import with a column being a binary(16) doesn't work correctly | MERGE | DATA-ISS-004 |
| #19017 | Console tab is taking focus | MERGE | UI-ISS-003 |
| #19021 | Horizontal scrollbar on Browse tab should only apply to table content | MERGE | UI-ISS-006 |
| #19045 | Optional key relationships to speed up listing | ACCEPT | DATA-ISS-122 |
| #19056 | Searching in tables should use UTF8MB4, not just utf8, to avoid warnin | ACCEPT | DATA-ISS-123 |
| #19075 | Language combobox is hard to read | DROP | The sort order and alignment of the language selector labels is a cosmetic detail of the legacy selector; the DBLoom language selector is designed separately. |
| #19108 | Duplicate ids on same page | ACCEPT | UI-ISS-131 |
| #19130 | Ability to disable SQL editor toolbar buttons | DROP | A request to hide the SELECT, INSERT, UPDATE and DELETE template buttons of the SQL editor is a UI preference, not a defect; hiding buttons is not an access control, which is the job of database privileges. |
| #19142 | Export/Import database problem | MERGE | DATA-ISS-004 |
| #19157 | Add config parameter: Enable/Disable backtick quoting | ACCEPT | FR-ISS-133 |
| #19178 | better hint / autocompletion for INNER JOIN, LEFT JOIN, GROUP BY | ACCEPT | UI-ISS-132 |
| #19253 | SLAVE MONITOR Privilege missing / lost when saving User | MERGE | FR-ISS-002 |
| #19259 | Bind Parameters - support `?` | ACCEPT | FR-ISS-134 |
| #19279 | Copying A DB To NewDB Then Drop NewDB, Then Copying DB To NewDB Again  | MERGE | DATA-ISS-007 |
| #19282 | Misleading query results on query fail | ACCEPT | FR-ISS-135 |
| #19295 | TypeError: implode(): Argument #1 ($pieces) must be of type array, str | MERGE | FR-ISS-013 |
| #19297 | Login screen could remember the server selected last time | ACCEPT | UI-ISS-133 |
| #19311 | Support of Cluster  MySQL connections (Read & Write Ports) | DROP | A read and write port split is done by a routing layer such as MySQL Router or a proxy that exposes separate endpoints; DBLoom can connect to such an endpoint, and routing is a deployment concern. |
| #19340 | Provide config option to autofocus Username field on login page | ACCEPT | UI-ISS-134 |
| #19360 | Display database comments next to database names in sidebar list (tree | MERGE | UI-ISS-005 |
| #19369 | Option to skip first line when importing a CSV file into existing tabl | COVERED | FR-IOX-041 |
| #19383 | After the second line of the INSERT contains a non-null nullable ENUM  | ACCEPT | DATA-ISS-124 |
| #19384 | Searching on a VARBINARY field | ACCEPT | DATA-ISS-125 |
| #19398 | Improve mime types when exporting as CSV and JSON | ACCEPT | DATA-ISS-126 |
| #19411 | More options for export function | ACCEPT | DATA-ISS-127 |
| #19430 | Feature Request: 6.0 Bootstrap Auto Mode and Default it | COVERED | UI-UPD-005; ST-214 |
| #19453 | Add Support for Trigger Execution Order in MariaDB | ACCEPT | FR-ISS-136 |
| #19463 | POINT Columns Cause Missing PRIMARY KEY and AUTO_INCREMENT Attributes  | MERGE | DATA-ISS-004 |
| #19489 | 6.0 - The code font size is smaller compared to 5.2 | DROP | Font size of the legacy 6.0 theme stylesheet; the thread proposes CSS changes to a legacy theme, which is cosmetic and not relevant to DBLoom's own styling. |
| #19502 | Allow prepopulating username from GET parameter for bookmarks/links | ACCEPT | SEC-ISS-112 |
| #19539 | MySQL 8.0.30: GIPK Mode insert errors | COVERED | FR-DTB-134 |
| #19543 | Execute option is disabled but user has the EXECUTE privilege | COVERED | FR-DTB-081 |
| #19573 | import sql file | COVERED | FR-UIX-018 |
| #19576 | New Event form's Go button missing | MERGE | UI-ISS-007 |
| #19577 | Modals become inaccessible when changing the browser window size | MERGE | UI-ISS-006 |
| #19578 | After creating an event/procedure shown query is missing `DELIMITER $$ | ACCEPT | FR-ISS-137 |
| #19601 | Numbers format | DROP | Request to accept digit-group separators such as spaces or underscores in numeric input; the thread argues against silently rewriting user input, and DATA-ISS-014 already requires a validation message for values that cannot be parsed. |
| #19604 | Existing values are no longer filled in automatically when editing row | ACCEPT | DATA-ISS-128 |
| #19605 | does not set a GRANT at the database level for a database user | DUPLICATE | duplicate of SEC-ISS-115 (#20521) |
| #19608 | Status/Processes: allow URL to specify "show only active" and sort by  | ACCEPT | FR-ISS-138 |
| #19609 | It no longer goes to page 1 after sorting | ACCEPT | FR-ISS-139 |
| #19617 | Show warning when users can directly manipulate mysql database without | ACCEPT | SEC-ISS-113 |
| #19618 | Incorrect default value when changing/altering a column if the default | MERGE | DATA-ISS-010 |
| #19622 | Inconsistent Display of `BIT(n)` Values in "Browse" View in Decimal an | ACCEPT | DATA-ISS-129 |
| #19626 | Fail to copy database when it includes descending Indexes | MERGE | DATA-ISS-007 |
| #19633 | Wrong "Wrong default value" error | DROP | Reported only on LegacyAdmin 5.2.1; maintainers could not reproduce it on 5.2.2 and the reporter did not confirm a current version. |
| #19637 | View bug: The latest records are not visible when navigating through p | DROP | Support question on LegacyAdmin 4.9 (out of support); not reproduced on current versions, and the apparent missing rows are a sort-order and configuration question. |
| #19649 | Support fuzzy matching table names | ACCEPT | UI-ISS-135 |
| #19657 | [Bug]: SQL Parser Error with CASE Statement and column Alias | COVERED | FR-TGT-230 |
| #19658 | [Bug]:  browse column comment charset wrong while comments on structur | ACCEPT | UI-ISS-136 |
| #19667 | [Bug]: legacyadmin 5.2.1 "Advisor" incorrectly reports RDBMS Engine running 32 | DUPLICATE | duplicate of FR-ISS-116 (#15222) |
| #19669 | [Bug]: Spacial data reverts x and y whenever edited | MERGE | DATA-ISS-010 |
| #19671 | [Bug]: Warning in ./libraries/classes/DatabaseInterface.php#815 - Unde | DROP | PHP warning from a legacy view editor; the maintainers could not reproduce it on 5.2.2 or 6.0 and the report is stale. |
| #19673 | [Bug]: Export incomplete view | MERGE | DATA-ISS-004 |
| #19679 | [Bug]: binary(16) DEFAULT value is incorrectly exported | MERGE | DATA-ISS-004 |
| #19692 | [Bug]: Exporting views with union does not put a space before the keyw | MERGE | DATA-ISS-004 |
| #19694 | [Feat]: Fetch console history only when required (switched to history  | ACCEPT | NFR-ISS-105 |
| #19707 | [Bug]: duplicate whitespace not displayed | DUPLICATE | duplicate of UI-ISS-114 (#14954) |
| #19718 | [Feat]: Setting to output all SQL to include the database name | ACCEPT | FR-ISS-140 |
| #19723 | [Bug]: Visual Query Builder incorrect SQL syntax | ACCEPT | FR-ISS-141 |
| #19725 | [Feat]: Simbiat Libraries Integration | ACCEPT | DATA-ISS-130 |
| #19726 | [Feat]: visualize changes on refresh | DROP | Optional highlighting of changed values after re-running a query is a feature request that the thread calls complicated for large data sets; no defect and no decision. |
| #19728 | [Bug]: Encoding conversion is not working when exporting in CSV format | COVERED | UI-IOX-021 |
| #19741 | [Bug]: "Simulate Query" in LegacyAdmin 5.2.1 Incorrectly Reports No Row | DROP | The simulated row count was wrong in 5.2.1 and is fixed in 5.2.2 (#18536) according to the thread. |
| #19742 | [Bug]: Cannot insert or edit Point type columns with LegacyAdmin UI | COVERED | FR-IOX-067 |
| #19752 | [Bug]: foreign constraint on add/edit cascade always preselected | ACCEPT | FR-ISS-142 |
| #19759 | [Bug]: renaming DB with a view fails | ACCEPT | DATA-ISS-131 |
| #19761 | [Bug]: No load mask when copying table | MERGE | UI-ISS-001 |
| #19787 | "WITH ROLLUP" Shows "Expects delimiter" Syntax Error in LegacyAdmin, SQ | DROP | Duplicate of #18238 and fixed in 5.2.2 according to the thread; the parser message no longer appears. |
| #19806 | [Bug]: Remote Login uses own hostname as destination for Remote Server | DROP | Caused by legacy config.inc.php host handling of a remote server; no maintainer response, and DBLoom server configuration is a separate design. |
| #19819 | [Bug]: legacyadmin hangs when counting rows for locked table in schema  | ACCEPT | FR-ISS-143 |
| #19874 | [Feat]: Dropdown with search function on selected fields | DUPLICATE | duplicate of UI-ISS-124 (#18031) |
| #19882 | [Feat]: search with wildcards | MERGE | FR-ISS-007 |
| #19890 | [Bug]: When browsing a table, the row count ("Showing rows 0-16") shou | ACCEPT | UI-ISS-137 |
| #19905 | [Bug]: 'Add CREATE PROCEDURE ...' option not loaded in database export | DROP | Saved export templates are a legacy feature that the DBLoom specification does not define, and the thread has no decision. |
| #19916 | [Bug]: Reverse https reverse proxy setup using LegacyAdmin 5.2.3 does t | DROP | Legacy JavaScript error check misfires behind a reverse proxy; the reporter's fix is a patch to legacy ajax.js, not a DBLoom requirement. |
| #19917 | [Bug]: Edit inline shows scrollbar and hides query | ACCEPT | UI-ISS-138 |
| #19921 | [Feat]: Display Database structure: List of all tables: please, show t | ACCEPT | UI-ISS-139 |
| #19936 | [6.0] On import of a CSV, the table is created but no data is imported | MERGE | DATA-ISS-006 |
| #19948 | CSV import should recognize TRUE and FALSE as boolean ? | DROP | Boolean type inference for CSV was declined by maintainers as unsafe; FR-IOX-042 already defines the CSV type detection. |
| #19949 | [Bug]: Browse tab in DB schema page may link to invalid table | MERGE | FR-ISS-006 |
| #19973 | [Feat]: Add an option to not modify the executed SQL in any way | ACCEPT | FR-ISS-144 |
| #19999 | [6.0]: SQL export options are shown on other export formats | MERGE | UI-ISS-007 |
| #20010 | [Feat]: Byte Order Mark (BOM) and delimiter for CSV exports | ACCEPT | DATA-ISS-132 |
| #20018 | [Feat]: Export data only when export all table | COVERED | FR-IOX-005 |
| #20048 | [Bug]: ErrorException: Undefined array key "Create_time" | ACCEPT | DATA-ISS-133 |
| #20055 | [Bug]: ShowDatabasesNavigationAsTree not working as expected | DROP | Report about the legacy ShowDatabasesNavigationAsTree switch with an expected behaviour tied to the legacy navigation option; no maintainer response and no DBLoom requirement. |
| #20067 | SQL errors when user does not have admin privileges | MERGE | FR-ISS-002 |
| #20095 | [Bug]: Adding system versioning to a table makes foreign keys unusable | DUPLICATE | duplicate of DATA-ISS-135 (#20190) |
| #20101 | [Bug]: The LegacyAdmin configuration storage is not completely configur | DROP | Warning about the legacy configuration-storage (la_ tables) for a disabled feature; the issue has no body and the storage is not used by DBLoom. |
| #20128 | [Bug]: ErrorException: iconv(): Wrong encoding, conversion from "utf-8 | ACCEPT | DATA-ISS-134 |
| #20186 | [Feat]: Default text searches to %like% instead of just like | MERGE | FR-ISS-007 |
| #20190 | Undefined array key 0 in Relation.php getForeigners() when parsing Sho | ACCEPT | DATA-ISS-135 |
| #20236 | [Bug]: TypeError with no actionable info prevents loading throbber rem | MERGE | FR-ISS-012 |
| #20254 | [Bug]: Tree collapses when clicking | MERGE | FR-ISS-005 |
| #20322 | [Feat]: Add Export option with version history | ACCEPT | DATA-ISS-136 |
| #20323 | [Bug]: Modal showing when editing a datetime value | DROP | Legacy inline-edit dialog that opens a query modal on the second Enter in a datetime cell; no maintainer response and no general requirement, to be retested in the DBLoom grid editor. |
| #20332 | [Bug]: zlib compressed columns return inproper prefilled edit form, st | MERGE | DATA-ISS-004 |
| #20348 | [Bug]: Bookmark variables with non-sequential [VARIABLEn] numbers are  | ACCEPT | FR-ISS-145 |
| #20362 | [Bug]: No error message when inserting into la_history fails | MERGE | FR-ISS-012 |
| #20366 | [Bug]: [6.0] Export writes to file instead of streaming output | MERGE | DATA-ISS-002 |
| #20392 | [Feat]: transformation support for search | DROP | Asks for input transformations in the search form, a feature of legacy transformation plugins that the SPEC does not scope (only a deferred idea in FUTURE.md); no defect is reported. |
| #20400 | [Bug]: "CSV using LOAD DATA" import with charset selection results in  | ACCEPT | DATA-ISS-137 |
| #20411 | [Bug]: Editing a column using table default Collation then hard sets t | ACCEPT | DATA-ISS-138 |
| #20412 | [Bug]: imagecreatefromstring(): Data is not in a recognized format | ACCEPT | FR-ISS-146 |
| #20422 | [Bug]: Unable to render 60k record into legacyadmin 5.2.3 | DROP | Support request for a slow nine-table join across two databases in a legacy version; no defect is shown, and the thread gives tuning advice and a snapshot to try rather than a fix. |
| #20430 | [Bug]: Geometry column not truncated when table is joined | ACCEPT | UI-ISS-140 |
| #20448 | [Bug]: Pagination count is not accurate | MERGE | DATA-ISS-016 |
| #20453 | [6.0]: SkipLockedTables shows No tables found in database. | DROP | Concerns the legacy SkipLockedTables configuration directive, which hides all tables of a database list; the directive is a legacy PHP setting with no DBLoom counterpart, and the defect does not apply to DBLoom's table list. |
| #20462 | [Bug]: Unconditional Session::secure() before login form invalidates s | ACCEPT | SEC-ISS-114 |
| #20493 | [6.0]: Issues after DUCKDB engine is removed | ACCEPT | FR-ISS-147 |
| #20509 | [Bug]: Cannot sort column DESC by click when it is named COUNT(*) | MERGE | FR-ISS-008 |
| #20521 | Grant option is silently dropped when editing privileges on MySQL 8.0. | ACCEPT | SEC-ISS-115 |
| #20540 | [Bug]: Export nullable binary value | COVERED | FR-IOX-073 |
| #20556 | [Feat]: Update table name filter to filter all pages of table names, n | MERGE | FR-ISS-005 |

## 5. Open points

- The owner shall confirm or reject the requirements; none is approved. Because the wording is machine drafted, every requirement should be read before approval, and duplicates merged.
- The 44 UNCLEAR rows and the rows flagged as PHP or build specific (48 of the gap rows) are not reviewed.
