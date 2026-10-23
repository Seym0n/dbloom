# 03 — Database / Table / SQL Subsystem Specification

Source of truth: LegacyAdmin 5.2.3 at `legacy-release`.
In this copy the class autoload root is `libraries/classes/` with the namespace root flattened
(no `LegacyAdmin/` subfolder), i.e. `libraries/classes/Table.php` holds `LegacyAdmin\Table`.
All evidence citations use paths relative to the legacy root plus a 1-based line number.

Requirement ID scheme: `TYPE-DTB-nnn`.

Review status: wave-1 review applied (see `reviews/wave1-database-table.md`); wave-2 review applied (see `reviews/wave2-db-io-plugins.md`: wave-1 edits re-verified against code, query-box path resolved, SEC-DTB-005 added, `Verification:` lines added). Items marked "(corrected in review wave 2)" or "(added in review wave 2)" come from wave 2. Items marked "(corrected in review wave 1)" had factual or citation errors fixed; items marked "(added in review wave 1)" are new. Config defaults below are from `libraries/config.default.php`; permitted value lists are in `libraries/config.values.php` (see CON-CFG-027 in 01-configuration.md).

Types: FR (functional), NFR (quality), SEC (security), UI (interface), DATA (data model/storage),
CPT (concept/config-storage), DEP (dependency/version), INT (integration), CON (constraint).

---

## 1. Browse and query results

### FR-DTB-001 — Query execution pipeline
The system shall execute user-supplied SQL through a single pipeline that (a) parses the query, (b) resolves the targeted database/table from the parsed SELECT, (c) appends a LIMIT clause when applicable, (d) executes it, (e) counts total rows, and (f) renders either the result table or a no-results message.
Evidence: `libraries/classes/Controllers/Sql/SqlController.php:137-212` (ParseAnalyze → executeQueryAndSendQueryResponse); `libraries/classes/ParseAnalyze.php:28-75`; `libraries/classes/Sql.php:1680-1800`.
Verification: execute `SELECT * FROM t` (t with more than 25 rows) through the SQL tab and through the table Browse link; assert a result grid with 25 rows, the shown SQL ends in `LIMIT 0, 25`, and the displayed total equals `SELECT COUNT(*) FROM t`; then run the syntactically wrong `SELEC 1` and assert the original text and server error are shown without a LIMIT. (added in review wave 2)

### FR-DTB-002 — Browser default query
(corrected in review wave 1) When no SQL query is submitted but both `db` and `table` are known, the system shall (a) use the bookmark whose label equals the table name (looked up for the current user and db via `Bookmark::get(..., 'label', ...)`) as the default browse query, announcing "Using bookmark "%s" as default browse query."; otherwise (b) generate `SELECT * FROM `table`` and, when `$cfg['TablePrimaryKeyOrder']` is not `NONE` (default `NONE`; allowed ASC/DESC) and the table has a primary key, append ` ORDER BY `table`.`<first PK column>` <ASC|DESC>`. The generated query is routed through the same pipeline and `$goto` is reset to empty. If no query is available and no table is selected, `Util::checkParameters(['sql_query'])` aborts the request.
Evidence: `libraries/classes/Sql.php:502-546` (`getDefaultSqlQueryForBrowse`); `libraries/classes/Controllers/Sql/SqlController.php:123-133`; `libraries/config.default.php:2578-2580`.

### FR-DTB-003 — Automatic LIMIT clause
(corrected in review wave 1) The system shall append `LIMIT <pos>, <max_rows>` (values from the session `tmpval`; `pos` default 0, `max_rows` default `$cfg['MaxRows']` = 25, permitted values 25/50/100/250/500 per config.values.php, or the literal `all`) to a query only when ALL hold: the parser reported zero errors; `max_rows` is not `all`; the statement is not an export or analyse; it is `SELECT ... FROM` or a subquery; and it has no user-written LIMIT. Syntactically wrong queries shall never be altered so the true error is shown (see NFR-DTB-002).
Evidence: `libraries/classes/Sql.php:380-394` (isAppendLimitClause); `Sql.php:146-154` (getSqlWithLimitClause); invocation at `Sql.php:1729-1733`; `libraries/classes/Display/Results.php:3487-3496` (defaults for max_rows/pos).
Verification: with `MaxRows` 25 run (a) `SELECT * FROM t`, (b) `SELECT * FROM t LIMIT 5`, (c) `SHOW TABLES`, (d) `SELECT * FROM t` with the page size set to `all`; assert a LIMIT is appended only in (a). (added in review wave 2)

### FR-DTB-004 — Total result-count computation
The system shall compute the un-limited row count for paginated SELECTs by rewriting the statement into `SELECT COUNT(*) FROM (SELECT … ) as cnt`, removing programmatic ORDER BY and LIMIT, substituting a single expression list, and dropping SQL_NO_CACHE (Sql.php:749-794). When no LIMIT was appended the returned row count is used directly as the total; when `max_rows` is greater than the number of returned rows the total is computed as `pos + numRows` without any COUNT query; for non-SELECT statements the total is 0. The rewritten count query is executed with `fetchValue` and a `false` result is treated as 0.
Evidence: `libraries/classes/Sql.php:698-801`.

### FR-DTB-005 — "Just browsing" fast count
For a single-table SELECT with no WHERE/HAVING/GROUP/UNION/DISTINCT/function/join (WHERE is empty or `WHERE 1`), the system shall use the table's cached/approximate count (`Table::countRecords()`) instead of running a COUNT query, then, if that approximate value is below `$cfg['MaxExactCount']` (default 50000), obtain the exact count with `countRecords(true)` (`SELECT COUNT(*)`). `Table::countRecords` returns a cached `ExactRows` value when present; for non-forced counts it reads `Rows` from the table status and returns it as-is when it is >= `MaxExactCount`. (corrected in review wave 1: exact-count rule made precise)
Evidence: `libraries/classes/Sql.php:403-419` (isJustBrowsing), `730-747` (count shortcut); `libraries/classes/Table.php:693-760` (checkIfMinRecordsExist/countRecords(forceExact)); `libraries/config.default.php:2635-2644` (`MaxExactCount = 50000`; `MaxExactCountViews` at 2642-2644).

### FR-DTB-006 — Position clamping (corrected in review wave 1)
After rows are deleted (DeleteRowsController) or tables are emptied (EmptyTableController) and `pos` is non-empty, the system shall recompute `pos` with the exact row count: if `rowCount <= pos` and `pos != 0`, then `pos = (ceil(rowCount / max_rows) - 1) * max_rows` (division by zero is suppressed with `@`). This clamping is NOT applied on ordinary browse requests; there an out-of-range `pos` simply yields an empty page. Navigation buttons: Next = `pos + max_rows`, Previous = `max(0, pos - max_rows)`, End = `(ceil(unlim_num_rows / max_rows) - 1) * max_rows`; with `max_rows = all` both offsets are 0.
Evidence: `libraries/classes/Sql.php:1809-1839` (`calculatePosForLastPage`, `getStartPosToDisplayRow`); callers `libraries/classes/Controllers/Table/DeleteRowsController.php:71-73`, `libraries/classes/Controllers/Database/Structure/EmptyTableController.php:108-110`; `libraries/classes/Display/Results.php:957-980, 3827-3840`.
Verification: delete the only row of the last page (page size 25, 26 rows, pos = 25) through the checkbox delete, and assert the page shown afterwards starts at pos 0 (formula `(ceil(rowCount/max_rows)-1)*max_rows`); browse directly with `pos=1000` and assert an empty page without clamping. (added in review wave 2)

### FR-DTB-007 — Remembered sort order
(corrected in review wave 1) When `$cfg['RememberSorting']` (default true) is enabled and the query is a single-table `SELECT * FROM t` (no COUNT/export/function/analyse, exactly one table, select list empty or exactly `*`, no UNION), the system shall (a) store the query's ORDER BY clause in the table UI property `Table::PROP_SORTED_COLUMN` when the query has one, or (b) when it has none, re-apply the stored clause (with the `` `table`. `` prefix stripped) by rewriting the query and re-parsing it. It shall skip this when the request came from the SQL query box (`$_SESSION['sql_from_query_box']`, which is then cleared) or from the "sort by key" dropdown (`sort_by_key`). The "remove sort" link carries `discard_remembered_sort=1`. UI properties persist in the config-storage `table_uiprefs` table when available and otherwise in the session only.
Evidence: `libraries/classes/Sql.php:359-373` (isRememberSortingOrder), `95-137` (handleSortOrder), `1699-1715` (conditions); `libraries/classes/Display/Results.php:1932`; `libraries/config.default.php:2585-2587`; `libraries/classes/Table.php:1877-1994` (getUiProp/setUiProp/removeUiProp).
Evidence (additional): `libraries/classes/Sql.php:95-137` (handleSortOrder / `Table::PROP_SORTED_COLUMN`), `1699-1715` (conditions); `libraries/classes/Table.php:1877-1994` (getUiProp/setUiProp/removeUiProp).

### FR-DTB-008 — Server warnings surfacing
After an executed query the system shall fetch MySQL warning messages (`SHOW WARNINGS`) via `Operations::getWarningMessagesArray` and display each as a notice under the result.
Evidence: `libraries/classes/Sql.php:1755,1794-1797` (getWarningMessagesArray → Message::notice); `libraries/classes/Operations.php:757`; warning retrieval interface `libraries/classes/Dbal/DbalInterface.php:413` (`getWarnings`).

### FR-DTB-009 — Row count accuracy for views/merged behavior
The system shall distinguish real tables from views (`Table::isView()`) and updatable views, and shall not copy data when duplicating a view as a table. For views, `Table::countRecords` returns an unknown count (false) when `$cfg['MaxExactCountViews']` is 0 (default); otherwise it counts with a LIMIT of that value, and when the total equals `MaxExactCountViews` the result footer shows the notice "This view has at least this number of rows" (corrected in review wave 1: description of view counting added; see also CON-DTB-001).
Evidence: `libraries/classes/Table.php:234-311` (isView/isUpdatableView/isMerge); `Table.php:1283-1285` (data copy skipped for views); `Table.php:733-840` (countRecords view branch); `libraries/classes/Display/Results.php:3995-4005` (view-count notice).

### FR-DTB-010 — Large/odd cell display behavior in results
The system shall expose configurable result-display behaviors: rows per page (`MaxRows`, default 25), character truncation of long text cells (`LimitChars`, default 50, applied when `pftext` = `P`, partial; `F` = full text, forced for EXPLAIN), and repeated header rows (`RepeatCells`, default 100; 0 disables) as used by the results renderer and the foreign-value browser. These are remembered per (server, db, SQL md5) in `$_SESSION['tmpval']['query']`, which keeps at most 10 distinct queries (oldest evicted). A "Show all" control is offered only when `$cfg['ShowAll']` is true or the total is at most 500 rows. (corrected in review wave 1: limits made explicit)
Evidence: `libraries/config.default.php:1276-1278, 2555-2557, 2606-2608`; `libraries/classes/Display/Results.php:961-1012` (session_max_rows/max_rows handling); `libraries/classes/BrowseForeigners.php:40-46` (limitChars from cfg); `libraries/classes/Display/Results.php:870-880, 2228-2229, 3464-3590`.

### FR-DTB-011 — Relational column dropdown
The system shall offer a value dropdown for relational (FK/internal-relation) columns in browse results (inline edit). (corrected in review wave 2: concrete behaviour) `getHtmlForRelationalColumnDropdown(db, table, column, currentValue)` loads the column's foreigners via `Relation::getForeigners` and `getForeignData`; when the related table has more than `$cfg['ForeignKeyMaxLimit']` rows (`disp_row` is null) it renders a text field with a "browse" link (`sql/relational_column_dropdown` template, current value from POST `curr_value`), otherwise a `<select>` of the related values built by `foreignDropdown` honoring `ForeignKeyDropdownOrder`. See also FR-DTB-160.
Evidence: `libraries/classes/Sql.php:239-310` (getHtmlForRelationalColumnDropdown), `310-374` (SET full values / column values).

### FR-DTB-012 — Profiling and query time
The system shall measure the execution time of every statement run through `/sql` and, when the session flag `$_SESSION['profiling']` is set, collect and show profiling data. (corrected in review wave 2: concrete behaviour) Profiling is switched on by request parameter `profiling` (checkbox; `profiling_form` without it switches it off) and only if the server reports `@@have_profiling` (cached in the session); while on, each query is preceded by `SET PROFILING=1` and followed by `SHOW PROFILE`, whose rows feed the profiling table and pie chart. Profiling is skipped when `show_as_php` is requested.
Evidence: `libraries/classes/Sql.php:843,851,885` (Profiling::enable, `lastQueryExecutionTime`, Profiling::getInformation).

### UI-DTB-001 — "Show as PHP"
When requested, the system shall render the raw result without executing display transformations … and shall skip result rendering when `show_as_php` is set.
Evidence: `libraries/classes/Sql.php:836-843`.

## 2. SQL runner (multi-query, delimiters, errors, bookmarks)

### FR-DTB-020 — Query sources
The system shall accept an SQL query from: POST `sql_query`, a bookmark (POST `bkm_fields.bkm_sql_query`), or GET `sql_query` validated by signature.
Precedence is bookmark field, then POST, then signed GET. A GET `sql_query` whose signature fails is silently ignored (no error), after which the default-browse rule of FR-DTB-002 or the missing-parameter abort applies. A `bkm_fields.bkm_database` value overrides the current database. (corrected in review wave 1)
Evidence: `libraries/classes/Controllers/Sql/SqlController.php:106-132`.

### SEC-DTB-001 — HMAC signature on GET queries
The system shall sign SQL queries passed through URLs with an HMAC-SHA256 (session HMAC secret + blowfish secret) and refuse GET `sql_query` values whose `sql_signature` does not match.
Evidence: `libraries/classes/Core.php:971-994` (signSqlQuery/checkSqlQuerySignature, `hash_equals`); enforced at `libraries/classes/Controllers/Sql/SqlController.php:111-115`. The same signing is used for row where-clauses (see SEC-DTB-003).
Verification: request `/sql?sql_query=SELECT 1&sql_signature=<wrong>` and assert the query is ignored (default browse or missing-parameter abort), and with a signature produced by the application for that exact text assert it runs; changing one character of the query must invalidate the signature. (added in review wave 2)

### SEC-DTB-002 — DROP DATABASE gating
The system shall reject `DROP DATABASE` statements unless `$cfg['AllowUserDropDatabase']` is true or the user is a superuser.
The check cannot be bypassed by client-supplied `is_js_confirmed`; the error shown is '"DROP DATABASE" statements are disabled.'. (corrected in review wave 1: rights are denied when AllowUserDropDatabase is false AND the user is not a superuser, i.e. superusers may always drop)
Evidence: `libraries/classes/Sql.php:442-451` (hasNoRightsToDropDatabase); enforcement with mysqlDie at `libraries/classes/Controllers/Sql/SqlController.php:147-170`.
Verification: as a non-superuser with `AllowUserDropDatabase=false` submit `DROP DATABASE x` (also with `is_js_confirmed=1`) and assert the error '"DROP DATABASE" statements are disabled.' and the database still exists; as superuser assert it is dropped. (added in review wave 2)

### FR-DTB-021 — Multi-statement execution with delimiter (corrected in review wave 1; corrected in review wave 2)
The plain `/sql` route (`SqlController`) executes exactly one submitted string via `tryQuery` and does not split statements. Multi-statement SQL typed in the query box is split by the import pipeline, not by `/sql` (verified in review wave 2, closes former Gap 1): the query-box form (`templates/sql/query.twig:1`, `id="sqlqueryform"`) posts to `/import` with the textarea `sql_query`, the text input `sql_delimiter` (`query.twig:111-112`, shipped default `;`) and, for parameterised queries, `parameterized` plus `parameters[<name>]`. `ImportController` (`:149-173`) first replaces each named parameter in the text (non-numeric values are quoted with `escapeString`; a parameter is replaced only when followed by a non-identifier character or at the end of the string), then sets `import_text = sql_query`, `import_type = 'query'`, `format = 'sql'` and `$_SESSION['sql_from_query_box'] = true`. `ImportSql::doImport` splits the text with `BufferedQuery` using the POSTed `sql_delimiter`. Up to 49 statements are queued and then run one by one through the SQL controller (each is parsed with `ParseAnalyze`, executed and rendered; `$_SESSION['is_multi_query']` is set when more than one statement is valid); when a 50th statement arrives the queued statements are flushed and all further ones are executed directly by `Import::executeQuery` (FR-IOX-040, FR-IOX-101). Separately, the delimiter is used in the rollback pre-check (`Import::handleRollbackRequest`, `explode($sqlDelimiter, ...)`) and in `SimulateDmlController` (FR-IOX-100); routine execution uses a single `multi_query` and iterates result sets.
Evidence: `templates/sql/query.twig:1-12, 111-112`; `libraries/classes/Controllers/Import/ImportController.php:149-173, 683-725`; `libraries/classes/Plugins/Import/ImportSql.php:102-135`; `libraries/classes/Sql.php:850`; `libraries/classes/Import.php:188-278, 1357-1362`; `libraries/classes/Controllers/Import/SimulateDmlController.php:54`; `libraries/classes/Database/Routines.php:1162-1216`.
Verification: in a test database submit `INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); SELECT COUNT(*) FROM t;` from the SQL tab; assert the request goes to `/import` (browser network log), that two rows exist afterwards and that the last result table is shown. Repeat with delimiter `$$` and the text `SELECT 1$$ SELECT 2$$` and assert two statements run. Submit the same text directly to `/sql` and assert the server reports a syntax error (no splitting). Submit 60 `INSERT` statements and assert all 60 rows exist and that statements 50-60 were executed by the import itself. (added in review wave 2)

### FR-DTB-022 — Transaction/rollback helper for DML
The system shall offer a rollback request helper (POST `rollback_query`) that only permits it when every non-empty statement (split on `sql_delimiter`) parses as INSERT/UPDATE/DELETE/REPLACE and every referenced table is transactional (InnoDB); otherwise it fails with "Only INSERT, UPDATE, DELETE and REPLACE SQL queries containing transactional engine tables can be rolled back."; if eligible it issues `START TRANSACTION` before the run (the import controller rolls back afterwards).
Evidence: `libraries/classes/Import.php:1357-1436` (handleRollbackRequest, checkIfRollbackPossible, isTableTransactional).
Verification: post `INSERT INTO innodb_t VALUES (9);` with `rollback_query=1` and assert the row does not persist; post the same against a MyISAM table or with a `SELECT` and assert the message "Only INSERT, UPDATE, DELETE and REPLACE SQL queries containing transactional engine tables can be rolled back." (added in review wave 2)

### FR-DTB-023 — Error reporting on failure
The system shall, on query failure, output the server error together with the failing SQL ("MySQL said: …") and exit; per-statement errors may be collected instead when `$cfg['IgnoreMultiSubmitErrors']` is enabled (default false; the error is then returned in `extra_data['error']`). When the request is a "goto file" request the error is returned as a JSON error message (request status false) instead of the mysqlDie page; in both cases execution stops. (corrected in review wave 1)
Evidence: `libraries/classes/Sql.php:554-566` (handleQueryExecuteError → `Generator::mysqlDie`); `Sql.php:858-864` (extraData error / IgnoreMultiSubmitErrors); `libraries/classes/InsertEdit.php:1349-1372`.

### FR-DTB-024 — Session durability during long queries
The system shall close the PHP session before executing a query and reopen it afterwards to avoid session locks during long-running statements.
Evidence: `libraries/classes/Sql.php:845-857` (session_write_close / session_start(['use_cookies' => false]); skipped under the test-suite constant).

### FR-DTB-025 — Bookmark (saved SQL) creation
(corrected in review wave 1) The system shall store the executed query as a bookmark after a successful execution when POST `bkm_label` is non-empty. With `bkm_replace`, every existing bookmark of the current user and database with the same label is deleted first (it does NOT create a special "replace" bookmark type). A bookmark requires non-empty query and label (`Bookmark::createBookmark` returns false otherwise); with `bkm_all_users` the owner is stored as the empty string (visible to all users); when the bookmark feature is not configured the owner is '' and `save()` returns false. A separate explicit "store bookmark" request (`store_bkm`) is handled by SqlController::addBookmark and answers "Bookmark %s has been created." or "Bookmark not created!" (AJAX), or redirects to `$goto` with `&label=` otherwise; there `bkm_all_users` must equal the string `true`.
Evidence: `libraries/classes/Sql.php:577-619, 866-878`; `libraries/classes/Controllers/Sql/SqlController.php:176-182, 215-245`; `libraries/classes/Bookmark.php:112-131, 199-218`.
Verification: run a query with `bkm_label=lbl` twice with and without `bkm_replace` and assert one versus two rows in `la_bookmark`; with `bkm_all_users` assert `user = ''`; with an empty label assert no row. (added in review wave 2)

### FR-DTB-026 — Bookmarks with variables
(corrected in review wave 1) The system shall support bookmark queries containing `[VARIABLEn]` placeholders (regex `/\[VARIABLE[0-9]*\]/`; `[VARIABLE]` is accepted for variable 1 for backward compatibility). `getVariableCount` returns the number of matches. `applyVariables` first strips a `/* ... */` comment that encloses a placeholder, then replaces placeholder i with `escapeString(value_i)`; a missing or empty (`empty()`, so also "0") value is replaced by the empty string.
Evidence: `libraries/classes/Bookmark.php:152-194` (getVariableCount regex `/\[VARIABLE[0-9]*\]/`, applyVariables with escapeString).
Evidence (creation): `libraries/classes/Bookmark.php:199-240` (createBookmark from `bkm_fields`).

### FR-DTB-027 — SQL history
(corrected in review wave 1) The system shall record each executed query (db, table, query) in `$_SESSION['sql_history']`, capped at `$cfg['QueryHistoryMax']` (default 25, oldest dropped), and skip queries longer than `$cfg['MaxCharactersInDisplayedSQL']` (default 1000 characters). When the history feature exists and `$cfg['QueryHistoryDB']` is true (default false) the entry is additionally inserted into the config-storage `history` table (username, db, table, timevalue=NOW(), sqlquery) and old rows are purged per user. `getHistory` returns false when the history feature is not configured (even if a session history exists), the session list newest first when QueryHistoryDB is off, and otherwise the user's DB rows ordered by `id DESC`.
Evidence: `libraries/classes/ConfigStorage/Relation.php:667-740` (setHistory/session list + cap + DB insert), `741-775` (getHistory); `libraries/classes/Console.php:129-135`; storage feature `libraries/classes/ConfigStorage/Features/SqlHistoryFeature.php:13-21` (history table under ConfigStorage database).
Verification: with `QueryHistoryMax` 25 run 30 distinct queries and assert 25 in `$_SESSION['sql_history']` (oldest dropped); run a query longer than 1000 characters and assert it is not recorded; with `QueryHistoryDB` true assert rows in `la_history`. (added in review wave 2)

### FR-DTB-028 — Routine execution surplus result sets
When executing a stored routine that returns more than one result set, the system shall iterate all result sets of the multi_query (storeResult / moreResults / nextResult) and render each as a browse table, reporting affected rows of the last statement.
Evidence: `libraries/classes/Database/Routines.php:1168-1245`.

### CPT-DTB-001 — Configuration-storage backends for query features
The system shall persist bookmarks, SQL history and saved QBE searches in dedicated configuration-storage tables (bookmark, history, saved QBE) when the respective features are configured.
Table definitions: `la_bookmark(id, dbase varchar(255), user varchar(255), label varchar(255), query text)`; `la_history(id bigint, username varchar(64), db, table, timevalue timestamp, sqlquery text)`; `la_savedsearches(id, username, db_name, search_name varchar(64), search_data text; unique(username, db_name, search_name))` (`sql/create_tables.sql:39-48, 79-90, 293-304`). (corrected in review wave 1: storage columns added)
Evidence: `libraries/classes/ConfigStorage/Features/BookmarkFeature.php`, `SqlHistoryFeature.php`, `SavedQueryByExampleSearchesFeature.php` (classes exist, instantiated from RelationParameters); bookmark save path `libraries/classes/Bookmark.php:112-131` (save()).

## 3. Database create / drop / rename / copy

### FR-DTB-030 — Database rename/move
The system shall implement database rename ("move") and copy with: creation of the target database before copying (for move or on request), execution of stored procedure/function definitions statement-by-statement (no DELIMITER client syntax), stand-in tables for views during copy, table copy with dropped FK constraints, view handling after tables, accumulated constraint creation, event definitions (servers ≥ 5.1), bookmark duplication, privilege-adjustment hooks, and (on move) dropping the source database.
Evidence: `libraries/classes/Controllers/Database/OperationsController.php:82-227` (full flow; events gate at `147-152` `getVersion() >= 50100`; DROP DATABASE at `170-174`).
Evidence (procedures/events/stand-ins/constraints/bookmarks): `libraries/classes/Operations.php:54-135, 176-306, 282-446, 452-488` (runProcedureAndFunctionDefinitions, createDbBeforeCopy, getViewsAndCreateSqlViewStandIn, copyTables, runEventDefinitionsForDb, handleTheViews, adjustPrivilegesMoveDb, createAllAccumulatedConstraints, duplicateBookmarks).

### FR-DTB-031 — Same-name and empty-name guards for db copy
The system shall reject database rename/copy requests with an empty target name and reject copies to the identical source name; with `lower_case_table_names = 1` the target name is lowercased first.
Evidence: `libraries/classes/Controllers/Database/OperationsController.php:89-100` (empty name, same-name error), `92-95` (lowercase).

### FR-DTB-032 — Switch to copied database
After a database copy, the system shall optionally switch the current working database to the new one (persisted per-session flag).
Evidence: `libraries/classes/Controllers/Database/OperationsController.php:197-207`; `Operations.php:468-487` (duplicateBookmarks once per db).

### FR-DTB-033 — Privileges adjustment on copy/rename
The system shall optionally adjust user privileges on database copy/rename (and on table move/copy) when the user requests it.
Evidence: `libraries/classes/Operations.php:309-446` (adjustPrivilegesMoveDb/CopyDb), `790-880` (adjustPrivilegesRenameOrMoveTable/CopyTable).

### FR-DTB-034 — Database comment
The system shall store database comments in the configuration storage relation feature (`option`), set from the Operations tab.
Evidence: `libraries/classes/Controllers/Database/OperationsController.php:235-237` (setDbComment); storage design columns in `libraries/classes/ConfigStorage/Features/RelationFeature.php` (comment list populated via Relation).

## 4. Table create / drop / rename / copy / truncate

### FR-DTB-040 — Table creation
The system shall generate `CREATE TABLE db.tbl` statements from a form of columns, keys, partitions and table options, and execute them.
Evidence: `libraries/classes/CreateAddField.php:391-434` (getTableCreationQuery builds `CREATE TABLE …`); column specification generation `libraries/classes/Table.php:479-692` (ColumnDefinition for ALTER/CREATE).

### FR-DTB-041 — Table name validation
(corrected in review wave 1) The system shall validate table names with `Table::isValidName($name, $isBackquoted)`: reject names with trailing whitespace (even when backquoted) and zero-length names; when not backquoted additionally reject leading whitespace and any character outside `[a-zA-Z0-9_$]`; when backquoted accept everything else. The function checks only syntax; the 64-character MySQL identifier limit is not checked by LegacyAdmin (left to the server error). On rename the new name is lowercased when `lower_case_table_names = 1`.
Evidence: `libraries/classes/Table.php:1445-1470` (isValidName); `Table.php:1480-1482` (getLowerCaseNames === '1' → strtolower).
Verification: call table creation/rename with names `a b` (accepted only when backquoted), `a-b`, ` a`, `a ` and an empty string; assert rejection per the rules (trailing space always rejected, other characters only when not backquoted); with `lower_case_table_names=1` assert rename to `AbC` stores `abc`. (added in review wave 2)

### FR-DTB-042 — Table rename
The system shall rename a table with `RENAME TABLE old TO new` (works for tables and views). When moving across databases the system shall drop the source triggers first and restore them if the rename fails; after success it shall update configuration-storage records (`renameTable`).
Evidence: `libraries/classes/Table.php:1511-1563` (trigger drop/restore, RENAME TABLE …; `tryQuery` + error list); config-storage rename at `Table.php:1553-1554` and fallback copy path `Table.php:1321-1323`.

### FR-DTB-043 — Native rename fast path
For move-with-data requests, the system shall attempt the direct native `RENAME TABLE` first and only fall back to the export-based copy when it fails.
Evidence: `libraries/classes/Table.php:992-1000` (moveCopy: `if ($move && $what === 'data')` → rename() and return).

### FR-DTB-044 — Table copy phases
The system shall copy a table in explicit phases: (0) read structure via the SQL export plugin, (1) `DROP VIEW|TABLE IF EXISTS` on the target if requested, (2) build the new CREATE statement with retargeted name, (3) add constraints with identifier names removed (they must be unique), (4) add indexes (constraint names removed; executed for `one_table` and `db_copy` modes), (5) re-apply AUTO_INCREMENT value (`one_table`/`db_copy` modes only).
Evidence: `libraries/classes/Table.php:1056-1278`, error URL `Table.php:1006-1027` (source/target existence checks).
Verification: copy a table with structure and data, with FK constraint, indexes and an AUTO_INCREMENT value, using the Operations tab; assert the copy has the same columns, indexes and auto-increment value, constraints are recreated under new generated names, and a data-only copy creates no table. (added in review wave 2)

### FR-DTB-045 — Data copy semantics
The system shall copy data with `SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO'`, inserting only non-generated columns (`INSERT INTO … (cols) SELECT cols FROM source`); nothing is copied for views or `structure-only` requests.
Evidence: `libraries/classes/Table.php:1283-1301`; generated-column filtering via `getNonGeneratedColumns` (`Table.php:1721-1740`).

### FR-DTB-046 — Copy of metadata in config storage
On copy, the system shall duplicate column comments/MIME-transformations, display-field entries, and internal relations from the configuration storage to the new table; on data-only copies relation maintenance is preserved automatically. (clarified in review wave 2) The `column_info` row layout and the transformation semantics are owned by 06-plugins.md (DATA-PLG-008); this requirement owns only the lifecycle events that copy rows (table copy/move here, view creation in FR-DTB-070) or delete them (ALTER ... DROP COLUMN / DROP through the SQL box: `Sql.php:920-943` calls `Transformations::clear`; the drop-table, empty-table and database controllers use `RelationCleanup`; see FR-PLG-032).
Evidence: `libraries/classes/Table.php:1335-1429` (comments copy, displaywork/table_info, relwork/relation duplication).

### FR-DTB-047 — Table drop
The system shall distinguish `DROP VIEW` vs `DROP TABLE` per object type and clean up configuration-storage rows for the removed object.
Evidence: `libraries/classes/Table.php:1306-1327`; multi-drop including views: `libraries/classes/Controllers/Database/Structure/DropTableController.php:46-125`.
Evidence (cleanup side): `libraries/classes/Sql.php:920-942` (deleteTransformationInfo on ALTER/DROP statements), `Sql.php:891` (relationCleanup).

### FR-DTB-048 — Truncate (empty) tables
The system shall support truncating selected tables with `TRUNCATE tbl;`, skipping views and non-existent selections; confirm beforehand via a Yes/No dialog ("No change" flash when declined).
Evidence: `libraries/classes/Controllers/Database/Structure/EmptyTableController.php:67-124` (guard at 74-79, view skip at 87, TRUNCATE at 91-96).

### FR-DTB-049 — Foreign-key check suspension
For destructive operations (drop/empty tables, row deletes, DB copy), the system shall optionally disable `FOREIGN_KEY_CHECKS` and restore the original value afterwards.
Evidence: `libraries/classes/Utils/ForeignKey.php:45-84` (isCheckEnabled, handleDisableCheckInit/Cleanup setting the session variable OFF/ON); usage examples `EmptyTableController.php:81,112`; `DropTableController.php:70,125`; `DeleteRowsController.php:57,75`; `Sql.php:1696-1792` (reset `defaultFkCheck` around query runs).

## 5. Table alterations, columns, indexes, foreign keys

### FR-DTB-060 — Column add (deferred or immediate)
The system shall add one or more columns to a table (`ALTER TABLE … ADD …`), form a combined DDL, and apply it after creating the table in a single pass for creation flows.
Evidence: `libraries/classes/CreateAddField.php:63-219` (`isCreateTable ? '' : 'ADD '`), `462-484` (getColumnCreationQuery builds `ALTER TABLE …`), `484` (tryColumnCreationQuery).

### FR-DTB-061 — Full alter-table operation set
The system shall support the standard set of table alterations from the Operations tab (engine change, collation, row format, PACK_KEYS / CHECKSUM / DELAY_KEY_WRITE / page checksum engine options, auto-increment value, comments), with Aria/MyISAM specials gated by engine detection.
Evidence: `libraries/classes/Operations.php:665-770` (getTableAltersArray), `881-902` (changeAllColumnsCollation); `libraries/classes/Controllers/Table/OperationsController.php:228-247, 430-487` (pack_keys/checksum/page_checksum, has_auto_increment).
Evidence (engine checks): `libraries/classes/Table.php:214-332` (isEngine, isMerge), `365-430` (getStorageEngine/Comment/Collation/NumRows/RowFormat/getAutoIncrement).

### FR-DTB-062 — Column model introspection
The system shall provide column lists and metadata for forms (including reserved-name reporting, unique columns, and indexed columns) from information-schema-grade queries.
Evidence: `libraries/classes/Table.php:1582-1740` (getUniqueColumns, getIndexedColumns, getColumns, getColumnsMeta, getNonGeneratedColumns), `2018-2038` (getReservedColumnNames), `2040-2066` (getNameAndTypeOfTheColumns).

### FR-DTB-063 — Index create/edit/delete with version modes
The system shall generate `ALTER TABLE … ADD [PRIMARY|UNIQUE|INDEX|SPATIAL|FULLTEXT] idx (col(sub-part)…) [KEY_BLOCK_SIZE] [USING type] [WITH PARSER p] [COMMENT '…']` and, in edit mode, drop the replaced index in the same ALTER (`DROP PRIMARY KEY,` or `DROP INDEX `old`,` before the ADD). The statement is validated before execution with the errors "The name of the primary key must be "PRIMARY"!" (PRIMARY index with another name), "Can't rename index to PRIMARY!" and "No index parts defined!"; an empty PRIMARY name defaults to PRIMARY; `USING <type>` is emitted only for non-SPATIAL/FULLTEXT indexes on non-TokuDB engines; a `preview_sql` request returns the SQL without executing. When the server supports `ALTER TABLE … RENAME INDEX … TO …` (MySQL ≥ 5.7.0 / MariaDB ≥ 10.5.2) the rename shall use that syntax instead of drop+add.
Evidence: `libraries/classes/Table.php:2081-2189` (index query generation incl. error "The name of the primary key must be "PRIMARY"!", SPATIAL/FULLTEXT/type restrictions, TOKUDB gating); `libraries/classes/Table/Indexes.php:45-93` (doSaveData with isCompatibleRenameIndex); `libraries/classes/Query/Compatibility.php:137-149`.
Verification: create a PRIMARY index named `x` and assert the error "The name of the primary key must be \"PRIMARY\"!"; edit an index and assert one ALTER statement with `DROP INDEX` followed by `ADD`; submit with `preview_sql=1` and assert the SQL is returned without schema change. (added in review wave 2)

### DATA-DTB-001 — Index type flags
The system shall model index choices as a bit-field of PRIMARY/UNIQUE/INDEX/SPATIAL/FULLTEXT and load indexes from `information_schema` per table and per choice set (default mask 31 = all).
Evidence: `libraries/classes/Index.php:18-22` (const flags), `141-161` (getFromTable / getFromTableByChoice with `$choices = 31`).

### FR-DTB-064 — Duplicate index detection
The system shall report duplicate indexes of a table as notices. (corrected in review wave 2: concrete behaviour) `Index::findDuplicates` loads all indexes, pops the last one and compares it with every remaining one by `getCompareData()` (same columns, order, uniqueness and type attributes); the first equal pair per index yields the notice "The indexes %1$s and %2$s seem to be equal and one of them could possibly be removed."; tables with fewer than two indexes yield no output.
Evidence: `libraries/classes/Index.php:595` (findDuplicates); rendered into indexes list `libraries/classes/Sql.php:899-907` (refresh after dropped column).

### FR-DTB-065 — Foreign-key add/change/drop (native)
The system shall manage InnoDB foreign keys from a diff of submitted vs. existing constraints: create when none exists or changes detected (db, table, column mapping, constraint name, ON DELETE/UPDATE ≠ RESTRICT defaults), drop+recreate otherwise, drop when fields emptied; the system shall generate `ALTER TABLE tl DROP FOREIGN KEY name;`. When no ON DELETE/ON UPDATE action is stored for an existing constraint it is treated as `RESTRICT`.
Evidence: `libraries/classes/Table.php:2319-2428` (updateForeignKeys, drop at 2401-2419, ON DELETE/UPDATE defaults at 2368-2377); FK creation `Table.php:2427+` (getSQLToCreateForeignKey); preview SQL mode (`preview_sql` postings are not executed, only displayed: `Table.php:2407-2419`).

### FR-DTB-066 — Internal (virtual) relations
The system shall maintain relation-table (configuration storage) relations which are not enforced by the engine, updatable without native FK support, and remove them with the display-field update.
Evidence: `libraries/classes/Table.php:2197-2229` (updateDisplayField), `2229-2319` (updateInternalRelations).
Evidence (reserved-name listing): `libraries/classes/Table.php:2040-2064` (getNameAndTypeOfTheColumns).

### DATA-DTB-002 — Central columns dictionary
The system shall maintain a per-user central column list (a shared column dictionary) with add/remove/sync/consistency operations across databases.
Table `la_central_columns(db_name, col_name, col_type, col_length, col_collation, col_isNull, col_extra, col_default; PK(db_name, col_name))` (`sql/create_tables.sql:311-324`); `getColumnsList(db, from=0, num=25)` pages with `LIMIT from, num` and `num = 0` returns all rows. (corrected in review wave 1)
Evidence: `libraries/classes/Database/CentralColumns.php:96-833` (getParams, getColumnsList(from/num=25), getCount, syncUniqueColumns, deleteColumnsFromList, makeConsistentWithList, getFromTable, updateOneColumn, updateMultipleColumn); controllers `libraries/classes/Controllers/Database/CentralColumnsController.php` and `Structure/CentralColumns/*Add|Remove|PopulateColumns`; `libraries/classes/Controllers/Table/Structure/CentralColumnsAddController.php`, `CentralColumnsRemoveController.php`.

## 6. Views

### FR-DTB-070 — View creation
(corrected in review wave 1) The system shall create (`createview`, optionally `OR REPLACE`) or alter (`alterview`) views from a SELECT with: mandatory name (error "View name can not be empty!" when the submitted name is empty), ALGORITHM in {UNDEFINED, MERGE, TEMPTABLE}, optional DEFINER (a bare name without `@` is backquoted as a user only), SQL SECURITY in {DEFINER, INVOKER}, an optional comma-separated column list, and `WITH {CASCADED|LOCAL} CHECK OPTION`. Values outside the whitelists are silently omitted. On success the transformation metadata of the underlying columns is copied to the view columns (column map from the SELECT); on failure the server error (with the SQL when `ajax_dialog`) is returned and the request status is false. The SELECT text (`view[as]`) and column list are inserted verbatim.
Evidence: `libraries/classes/Controllers/View/CreateController.php:60-190` (whitelists 60-74, name check 77-83, statement build 85-141, failure 143-158, transformation copy 160-185).
Evidence (view introspection/updatable classification): `libraries/classes/Table.php:234-311` (isView/isUpdatableView).

### FR-DTB-071 — View drop/alter flows (corrected in review wave 1)
The system shall drop views with `DROP VIEW` (per-object type in multi-drop, see FR-DTB-047) and alter views with `ALTER ... VIEW` (FR-DTB-070). Unlike events, routines and triggers (FR-DTB-084) view redefinition has no backup/restore step. (The previous text conflated views with the event backup behavior.)
Evidence: `libraries/classes/Table.php:1311-1313` (DROP VIEW in move path); `libraries/classes/Controllers/Database/Structure/DropTableController.php:46-125`; `libraries/classes/Controllers/View/CreateController.php:85-141`.

## 7. Triggers, procedures, functions, events management

### FR-DTB-080 — Routine management
The system shall allow browsing, creating, editing, executing and dropping procedures/functions: it reads definitions via `DELIMITER $$`-tagged parsing, builds forms with parameters (IN/OUT/INOUT types, sizes), builds `CREATE PROCEDURE/FUNCTION` SQL from the form (including definer + privilege backup and `FLUSH PRIVILEGES` handling when the SUPER-privs changed during edit).
Evidence: `libraries/classes/Database/Routines.php:80-306` (handleEditor/handleRequestCreateOrEdit), `309-435` (backupPrivileges, create, flushPrivileges), `436-670` (getDataFromRequest / getDataFromName), `554-586` (`new Parser('DELIMITER $$…')` for definition), `955-1069` (getQueryFromRequest).
Evidence (version-aware error messages for missing DELIMITER handling): `Routines.php:194+` ("Execute the created query").

### FR-DTB-081 — Routine execute dialog
The system shall show an execute dialog for routines, executing a CALL with the submitted parameter values via a single multi-query, reporting the number of affected rows and rendering every returned result set; only offered to users with EXECUTE privilege on the db (else the direct-execute fallback).
Evidence: `libraries/classes/Database/Routines.php:1134-1264` (handleExecuteRoutine), `1440-1517` (getRow: `hasExecutePrivilege`, `execute_routine` vs `execute_dialog`), `1354-1423` (getExecuteForm).

### FR-DTB-082 — Trigger management
The system shall allow creating, editing and dropping triggers per table/database, with forms generated from `information_schema` metadata and `CREATE TRIGGER` statements submitted without a client DELIMITER. Validation (collected in an error list, all shown together): definer must contain `@` ("The definer must be in the "username@hostname" format!"), name required, timing in {BEFORE, AFTER}, event in {INSERT, UPDATE, DELETE}, table must be one of the database's tables, definition required; the statement always ends `FOR EACH ROW <definition>`. Editing drops then recreates the trigger and restores the backed-up definition when the re-create fails ("Sorry, we failed to restore the dropped trigger.").
Evidence: `libraries/classes/Database/Triggers.php:30-33, 59-160, 366-437` (main, handleEditor, getDataFromRequest/Name, getEditorForm, `getQueryFromRequest` "CREATE TRIGGER query"); listing query `libraries/classes/Query/Generator.php:207-260` (getInformationSchemaTriggersRequest / getInformationSchemaDataForCreateRequest).

### FR-DTB-083 — Event management with scheduler status
The system shall allow creating, editing, dropping events with statuses; it must validate schedule inputs: type in {RECURRING, ONE TIME}; RECURRING needs a non-zero interval value (`EVERY intval(v) unit`) with unit in {YEAR, QUARTER, MONTH, DAY, HOUR, MINUTE, WEEK, SECOND, YEAR_MONTH, DAY_HOUR, DAY_MINUTE, DAY_SECOND} and optional STARTS/ENDS; ONE TIME needs an AT timestamp; it emits `ON COMPLETION [NOT] PRESERVE`, status in {ENABLE, DISABLE, DISABLE ON SLAVE} (displayed ENABLED/DISABLED/SLAVESIDE_DISABLED), comment and definition; it shall show whether `event_scheduler` is ON (value `ON` or `1`).
Evidence: `libraries/classes/Database/Events.php:32-60, 83+` (handleEditor with drop_item), `268-500` (getDataFromRequest/Name, getEditorForm, getQueryFromRequest with schedule validation "You must provide a valid type/exe time/…"), `482-487` (getEventSchedulerStatus via SHOW GLOBAL VARIABLES).

### FR-DTB-084 — Routine/event multi-update transactionality
When replacing an existing routine, trigger or event definition, the system shall fetch the current definition, execute a `DROP ... IF EXISTS` step and, if the new CREATE fails, re-run the backed-up definition; if that also fails it reports "Sorry, we failed to restore the dropped <routine|trigger|event>." with the backed-up query and the MySQL error. This is best-effort, not an atomic transaction (DDL is auto-committed). (corrected in review wave 1: scope extended to routines/triggers)
Evidence: `libraries/classes/Database/Events.php:98-186` (drop_item pattern), `495-508` (checkResult with dbi->getError()); `libraries/classes/Database/Triggers.php:117-160, 430-437`; `libraries/classes/Database/Routines.php:195-250, 1530-1540`.

## 8. Search (QBE, find & replace, zoom, multi-table)

### FR-DTB-090 — Database-wide search
The system shall search across all (or selected) tables of a database for one of five match types — at least one word, all words, exact phrase substring, exact phrase whole field, or regexp — producing per-table SELECT *, COUNT(*) and DELETE queries, with an optional column restriction. For types 1-2 the search string is split on single spaces; types 3-5 use the whole string. Types 1-3 wrap each word in `%...%`; type 5 uses REGEXP; every column is compared as `CONVERT(col USING utf8)`. Words are combined with OR for type 1 and AND otherwise (columns within a word are OR-ed); empty words are skipped; if no clause results (e.g. the chosen column exists in no selected table) the WHERE is `WHERE FALSE`. The search is not run (submit flag unset) when the search type is not 1-5, the string is empty, or no table is selected; only tables that exist in the database are accepted. (corrected in review wave 1: semantics made precise)
Evidence: `libraries/classes/Database/Search.php:102-108` (searchTypes), `117-152` (criteria parsing incl. `criteriaTables` whitelist vs. real tables), `169-262` (getSearchSqls/getWhereClause with LIKE/REGEXP + `CONVERT(col USING utf8)` and `%…%` wildcards for types<4), `247-252` (WHERE FALSE).
Verification: search a database for `a b` with types 1 to 5 and a column restriction; assert the generated SELECT/COUNT/DELETE queries (OR between words for type 1, AND otherwise, `CONVERT(col USING utf8)`), and `WHERE FALSE` when the column exists in no selected table. (added in review wave 2)

### FR-DTB-091 — Table search (select tab)
The system shall build SELECTs from a table-search form (criteria AND-combined; a non-blank custom WHERE overrides all criteria; empty criteria are skipped; values for char/binary/blob/text/set/date/time/year/uuid types and for any LIKE operator are quoted, other types unquoted; BETWEEN uses the first two comma-separated values; an empty element inside IN/NOT IN becomes `IS NULL`) with per-column operators (NULL-safe IS/ISNOT, enum multi-select converted to IN/NOT IN, LIKE %…%, NOT LIKE, REGEXP anchors, IN/NOT IN/BETWEEN lists each value escaped), DISTINCT flag, optional column subset, custom WHERE override, ORDER BY with direction, and geometry-function restrictions.
Evidence: `libraries/classes/Table/Search.php:39-77` (buildSqlQuery incl. distinct, display columns, orderByColumn '--nil--'), `84-130` (customWhereClause + operators loop), `144-254` (getWhereClause per type), `326-355` (enum IN conversion), `267-316` (GIS where clause).

### FR-DTB-092 — Zoom search
The system shall provide a scatter-plot/zoom search as an alternate table search mode: the user picks two criteria columns (X/Y), an optional data label and criteria; the query is the table-search SELECT (`SELECT *`) with ` LIMIT <maxPlotLimit>` appended, where `maxPlotLimit` defaults to `$cfg['maxRowPlotLimit']` (500). The POSTed `maxPlotLimit` is concatenated into the SQL without integer coercion in `zoomSubmitAction` (defect recorded as SEC-DTB-005). Each result row carries a signed `where_clause` (SEC-DTB-003) so points can be edited. Without `zoom_submit` or without a data label the plain search form is displayed. (corrected in review wave 1)
Evidence: controller `libraries/classes/Controllers/Table/ZoomSearchController.php` (dispatched by the table search tab); underlying query generation shared with Table Search (`Table/Search.php:52` `zoom_submit`); `ZoomSearchController.php:144-170, 258-267, 337-370`; `libraries/config.default.php:2968`.

### FR-DTB-093 — Find and replace
The system shall allow find-and-replace in a single column with preview: LIKE `%find%` with a binary collation suffix (`COLLATE <charset>_bin`) grouped and ordered for preview; REPLACE() shown side-by-side; regex mode uses RLIKE with delimiter auto-selection from a set of ten punctuation candidates and generates an `UPDATE … SET col = CASE … END` statement. Execution performed only on explicit "replace".
Evidence: `libraries/classes/Controllers/Table/FindReplaceController.php:155-186` (findAction preview JSON, replaceAction), `199-239` (getReplacePreview), `251-305` (getRegexReplaceRows with delimiter candidates), `316-337` (replace with UPDATE CASE).

### FR-DTB-094 — Multi-table query (SELECT with generated joins)
The system shall provide a multi-table query form allowing specifying SELECT columns across tables and executing the combined SELECT (with LEFT JOIN formation in the QBE engine when related tables exist).
Evidence: `libraries/classes/Database/MultiTableQuery.php:26-108` (class, getFormHtml, displayResults); join construction in QBE: `libraries/classes/Database/Qbe.php:1218-1506+` (main table detection; `// Create LEFT JOINS out of Relations`; `$join .= "\n    LEFT JOIN "`).

### FR-DTB-095 — QBE (Query by example) form and saved searches
The system shall render a criteria-table/columns form for QBE, and shall persist (and offer restoring of) saved QBE searches when the saved-searches feature is enabled.
Evidence: `libraries/classes/Database/Qbe.php:228-312` (setCriteriaTablesAndColumns), `1619` (getSelectionForm); storage `libraries/classes/ConfigStorage/Features/SavedQueryByExampleSearchesFeature.php` (called by Relation::getSavedSearches APIs used by Qbe/Search performer class).

## 9. Operations tab

### FR-DTB-100 — Table maintenance actions
(corrected in review wave 1) The system shall expose table maintenance `CHECK TABLE`, `ANALYZE TABLE`, `CHECKSUM TABLE`, `OPTIMIZE TABLE` and `REPAIR TABLE` for one or many selected tables (`selected_tbl[]`, comma-joined backquoted names, one statement). An empty selection yields "No table selected."; when `$cfg['DisableMultiTableMaintenance']` (default false) is true more than one table yields "Maintenance operations on multiple tables are disabled.". Check additionally reports index problems. Partition maintenance is `ALTER TABLE t {ANALYZE|CHECK|OPTIMIZE|REPAIR|REBUILD|DROP|TRUNCATE} PARTITION p`; DROP and REBUILD return success/failure only, the others return result rows grouped by `Table`.
Evidence: controllers `libraries/classes/Controllers/Table/Maintenance/{Analyze,Check,Checksum,Optimize,Repair}Controller.php` and `Controllers/Table/Partition/{…}.php` (all dispatch maintenance statements); `libraries/classes/Table/Maintenance.php:43-171` (statements); `libraries/classes/Partitioning/Maintenance.php:15-170`; `libraries/config.default.php:2875`; choices list `libraries/classes/Operations.php:547-560` (getPartitionMaintenanceChoices incl. `'TRUNCATE'`).

### FR-DTB-101 — Referential integrity check
The system shall offer a referential-integrity check for internal (config-storage) relations only; nothing is offered without the relation feature. (corrected in review wave 2: concrete behaviour) For each internal relation of the table it builds `SELECT tbl.* FROM tbl LEFT JOIN fdb.ftbl [AS ftbl1 for self references] ON tbl.col = fdb.ftbl.fcol WHERE fdb.ftbl.fcol IS NULL AND tbl.col IS NOT NULL` and exposes it as a link carrying `sql_query` plus its HMAC `sql_signature` (SEC-DTB-001), so the orphan rows are shown by the normal SQL pipeline.
Evidence: `libraries/classes/Operations.php:583-665` (getForeignersForReferentialIntegrityCheck).

### FR-DTB-102 — Row-format choices
The system shall restrict the ROW_FORMAT choices to those supported by the table's storage engine. (corrected in review wave 2: concrete behaviour) Mapping: ARCHIVE {COMPRESSED}; ARIA and MARIA {FIXED, DYNAMIC, PAGE}; MYISAM and PBXT {FIXED, DYNAMIC}; INNODB {COMPACT, REDUNDANT} plus {DYNAMIC, COMPRESSED} when the InnoDB file format is `Barracuda` or empty with file-per-table support. Engines not in the map get no row-format choice.
Evidence: `libraries/classes/Operations.php:489-545` (getPossibleRowFormat).

### FR-DTB-103 — Auto-increment and table options from Operations form
The system shall let the user change AUTO_INCREMENT value and table create options (PACK_KEYS etc.) via ALTER; Aria `transactional`/`page_checksum` and MyISAM `checksum`/`delay_key_write` options gated by engine detection.
Evidence: `libraries/classes/Controllers/Table/OperationsController.php:434-487` (hasAutoIncrement, `hasTransactionalAndPageChecksum = isEngine('ARIA')`, `hasChecksumAndDelayKeyWrite = isEngine(['MYISAM','ARIA'])`), `144` (moveOrCopyTable), `184-186` (rename → adjustPrivilegesRenameOrMoveTable).

### FR-DTB-104 — Move/copy table from Operations tab
The system shall offer move/rename or copy (same-db or cross-db) with all table-copy phase semantics of FR-DTB-044 through the script `moveOrCopyTable`.
Evidence: `libraries/classes/Operations.php:903-970` (moveOrCopyTable returns Message), invoked at `Controllers/Table/OperationsController.php:144`.

### FR-DTB-105 — Table prefix change (db structure)
The system shall rename a batch of tables with prefix add/replace:
Evidence: controllers `libraries/classes/Controllers/Database/Structure/{AddPrefixController,AddPrefixTableController,ChangePrefixFormController,ReplacePrefixController,CopyFormController,CopyTableController,CopyTableWithPrefixController}.php` generating the requested `RENAME`/copy chain (Table::moveCopy).

## 10. Tracking (change tracking of DDL/DML)

### FR-DTB-110 — Version creation from table snapshot
The system shall create tracking versions by snapshotting the current schema: storing a serialized snapshot (`COLUMNS` and `INDEXES`, privileges removed) in `schema_snapshot`, and in `schema_sql` a log-comment line (`# log <Y-m-d H:i:s> <user>`) followed by `DROP TABLE IF EXISTS` (only if `tracking_add_drop_table`, default true, for tables) or `DROP VIEW IF EXISTS` (only if `tracking_add_drop_view`, default true, for views) and the export-plugin CREATE statement; `data_sql` starts as a newline. The tracked statement set defaults to `Servers[i].tracking_default_statements` (all 17 statement kinds). `date_created` = `date_updated` = now. The previous version (`version - 1`) is deactivated. (corrected in review wave 1: conditional drop lines and storage columns)
Evidence: `libraries/classes/Tracker.php:193-282` (createVersion: columns, indexes, `DROP TABLE IF EXISTS …` at 245, `DROP VIEW IF EXISTS …` at 250, `exportSqlPlugin->getTableDef` at 254); `Tracker.php:282` (createVersion deactivates prior version by calling deactivateTracking(version - 1)).

### FR-DTB-111 — Configurable tracking statement set
The system shall track a configurable subset of statements (per-statement flags: ALTER/RENAME/CREATE/DROP TABLE, ALtER/CREATE/DROP VIEW, CREATE/DROP INDEX, INSERT/UPDATE/DELETE/TRUNCATE/REPLACE) written as a comma-based set stored in the `tracking` SET column; the logging hook uses `FIND_IN_SET(identifier, tracking)` to decide whether a statement is logged. The full set of recognised identifiers is: UPDATE, REPLACE, INSERT, DELETE, TRUNCATE, CREATE/ALTER/DROP DATABASE, CREATE/ALTER/RENAME/DROP TABLE, CREATE/DROP INDEX, CREATE/ALTER/DROP VIEW.
Evidence: `libraries/classes/Tracking.php:902-970` (getTrackingSet chaining `'ALTER TABLE,'`, `'insert'`, …), storage via Tracker (dml_versions/ddlog/dmlog referenced by report HTML at `Tracking.php:503-541` `dml_versions`).

### FR-DTB-112 — Tracking state management
The system shall implement isTracked/active/deactivate/activate (flag flips), tracking data edits (changeTrackingData), version deletion, and per-database tracking creation ("tracking set for database" covering existing tables).
Evidence: `libraries/classes/Tracker.php:127-174` (isTracked with per-server cache, escapeString), `422-478` (changeTrackingData), `481-495` (activateTracking/deactivateTracking → changeTracking), `292-325` (deleteTracking), `325+` (createDatabaseVersion).
Evidence (cleanup): `libraries/classes/Controllers/Database/TrackingController.php:80-101` (delete_tracking for one/selected tables).

### FR-DTB-113 — Tracking report & export
The system shall render DDL/DML logs as a tracking report with schema snapshot, DDI/DML statement lists, filtering by time range and users, and exports as SQL dump/SQL execution/file download; report rows may be deleted.
Evidence: `libraries/classes/Tracking.php:226-345` (getHtmlForTrackingReport + elements), `358-501` (export forms), `638-692` (snapshot from Tracker::getTrackedData incl. DROP/CREATE pair), `717-791` (deleteTrackingReportRows/deleteFromTrackingReportLog), `792-870` (exportAsSqlDump/SqlExecution/FileDownload), `1051-1200` (getEntries filter by from/to/user, `$data['dmlog']`).

### FR-DTB-114 — Tracking toggle from table UI
The table Operations page and database tracking page shall provide activation/deactivation of tracking of the current table/version.
Evidence: `libraries/classes/Tracking.php:872-894` (changeTracking), `995-1049` (createTrackingVersion / createTrackingForMultipleTables); `${POST}` flag `submit_create_version` at `Controllers/Database/TrackingController.php:85-94`.

### CPT-DTB-002 — Auto-tracking on create (corrected in review wave 1)
When `Servers[i].tracking_version_auto_create` (default false) is true and no version exists for the object, the system shall automatically create version 1 upon executing CREATE TABLE, CREATE VIEW (view flag set) or CREATE DATABASE (database version). No auto-creation occurs for DROP statements; the setting named `tracking_record_uncreate_drops` in the previous text does not exist in the code. `tracking_add_drop_table/view/database` only control the `DROP ... IF EXISTS` line in the initial log.
Evidence: `libraries/classes/Tracker.php:880-901`; `libraries/config.default.php:565-605` (tracking defaults).

## 11. Designer (relational designer)

### FR-DTB-120 — Designer pages
The system shall allow persistence of designer "pages" (table arrangements) — create new page, save positions of tables to a page, save-as, edit name (rename), delete, load default page for db, and warn on duplicate page names. Page names are checked for uniqueness across all databases (the query has no `db_name` filter), the default page is the one whose description equals the database name (else the lowest `page_nr` of the db), and `deletePage` deletes by page number only. Saving over an existing page (`save_page=same`) deletes all `table_coords` rows of that page and re-inserts one row per table with a non-empty `t_h` (visibility) value; the message is "There already exists a page named "%s" please rename it to something else.". Without the PDF-pages feature all page operations are no-ops (-1/false). (corrected in review wave 1)
Evidence: `libraries/classes/Database/Designer/Common.php:269-556` (getTablePositions, getPageName, deletePage, getDefaultPage, getPageExists warns, getLoadingPage, createNewPage, saveTablePositions); dialogs `libraries/classes/Controllers/Database/DesignerController.php:46-94` (dialog edit/delete/save_as/export/add_table; duplicate page name message at 84-100); UI-level HTML builders `libraries/classes/Database/Designer.php:58-129` (getHtmlForEditOrDeletePages/getHtmlForPageSaveAs), `245-324` (getDatabaseTables / getHtmlForMain).

### FR-DTB-121 — Designer relations
The system shall create relations in the Designer with automatic routing: native FK when both tables' engines support FKs and engines match (require an index on each side, else "Error: Missing index on column(s)."); else internal relation stored in config storage when the relation feature exists. Duplicate error "Error: relationship already exists." if a relation already exists for that FK. ON DELETE/ON UPDATE values come from the request.
Evidence: `libraries/classes/Database/Designer/Common.php:558-694` (addNewRelation: engine check at 566, index checks 581-641, "relationship already exists" at 570-575, FK ALTER at 604-627, internal insertion 655+); removal at `Common.php:695-765` (removeRelation).

### FR-DTB-122 — Designer support inspection
The system shall indicate per-table whether it supports foreign keys (engine-based) and expose display fields and per-db grouping for its canvas.
Evidence: `libraries/classes/Database/Designer/DesignerTable.php:34-89` (supportsForeignkeys returns engine boolean, getDisplayField etc.).
Evidence (display field save): `libraries/classes/Database/Designer/Common.php:519-558` (saveDisplayField).

### FR-DTB-123 — Designer settings persistence
Per-user designer settings shall persist as one JSON object (`settings_data` text) per username in the config-storage `designer_settings` table; `saveSetting(index, value)` merges one key into the stored JSON, or inserts a new row if none exists.
Evidence: `libraries/classes/Database/Designer/Common.php:765-772` (saveSetting(index,value)), feature `libraries/classes/ConfigStorage/Features/DatabaseDesignerSettingsFeature.php:13-21`.

### FR-DTB-124 — Schema export from Designer
The system shall export the current designer page as an ER-schema in supported output formats (PDF/SVG/EPS/DIA engines exist as schema plugins).
Evidence: `libraries/classes/Database/Designer.php:129-184` (getHtmlForSchemaExport uses `$db`,`$page`); format plugins in `libraries/classes/Plugins/Schema/{Dia,Eps,Pdf,Svg}/`.

## 12. DML flows (INSERT / UPDATE / DELETE / REPLACE)

### FR-DTB-130 — Insert form and multi-row insert
The system shall provide an insert form supporting N rows (default `$cfg['InsertRows'] = 2`, extendable via a "continue insertion" form; only columns with a non-empty generated value are included, the field list being taken from the first row), per-row "ignore" checkbox, and functions per column; multiple rows are folded into a single `INSERT INTO … VALUES (…), (…)` statement.
Evidence: `libraries/classes/InsertEdit.php:936-1093` (getContinueInsertionForm), `1300-1314` (buildSqlQuery: `INSERT `[IGNORE]` INTO … implode('), (', valueSets)`), `1163-1195` (params/using key), `1196-1225`; config default `libraries/config.default.php:1376-1378` (`InsertRows = 2`).

### FR-DTB-131 — Update (edit/replace) generation
For edits (where_clause present), the system shall build one `UPDATE tbl SET … WHERE <where>[ LIMIT 1]` statement per edited row (LIMIT 1 omitted when 'clause_is_unique' is set), skipping unchanged/ignored columns; alternative modes `showinsert` and `insertignore` toggle the emitted DML.
Evidence: `libraries/classes/Controllers/Table/ReplaceController.php:362-389` (UPDATE with clause_is_unique LIMIT logic), `375-390`; `libraries/classes/InsertEdit.php:1186-1194` (isInsertIgnore).

### FR-DTB-132 — Row deletion
The system shall delete selected browse rows as one `DELETE FROM tbl WHERE … LIMIT 1;` statement per row, computing a safe unique where-condition per row, then reflow the position (`calculatePosForLastPage`).
Evidence: `libraries/classes/Controllers/Table/DeleteRowsController.php:56-107` (DELETE at 60-69, FKs suspension 57/75, pos at 71-73).

### FR-DTB-133 — Unique condition building for row ops
The system shall derive a unique WHERE clause per row (utilizing PK/unique keys when available, falling back to a composite equality condition) to safely target single rows in edit/delete operations.
Evidence: `libraries/classes/InsertEdit.php:1197-1224` (setSessionForEditNext uses `Util::getUniqueCondition` regenerating next row), `147-283` (getWhereClauseArray flow).
Evidence (row routing): `libraries/classes/InsertEdit.php:1920-1988` (determineInsertOrEdit → getWhereClauseArray).

### FR-DTB-134 — Value handling per column type
(corrected in review wave 1) The system shall encode submitted values according to the column's form type: empty string becomes `''` (or `NULL` for auto-increment columns); `set` values are comma-joined and quoted; `protected` blob/binary columns (per `$cfg['ProtectBinary']`: `blob` default, `all`, `noblob`, `false`) keep their existing value on UPDATE (re-inserted as `0x<hex>` when copying a row) and insert empty otherwise; `hex` values get a `0x` prefix; `bit` values are reduced to `[01]` (other characters become 0) and written as `b'...'`; date/datetime/timestamp values matching `current_timestamp[(0-6)]` are left unquoted; all other values are escaped and quoted; a ticked NULL checkbox with an empty value yields `NULL`; an un-ticked NULL box with an empty value yields `''`; `uuid` columns with an empty/`uuid()` value use `uuid()`. Function wrapping: `PHP_PASSWORD_HASH` uses `password_hash(PASSWORD_DEFAULT)`; `UUID` fetches `SELECT UUID()`; GIS-from-text/WKB functions take a quoted value plus optional SRID; AES_ENCRYPT/AES_DECRYPT (salt supplied) and DES_ENCRYPT/DES_DECRYPT/ENCRYPT (non-empty salt) take the salt as second argument; `NOW` takes a precision when the value is a number 0-6; functions without parameters are emitted as `f()`. An uploaded file's content overrides the typed value. On UPDATE a column is skipped when its value, function, and NULL state are unchanged from the `*_prev` hidden fields.
Evidence: `libraries/classes/InsertEdit.php:1745-1860` (getCurrentValueForDifferentTypes with UPDATE-mode comment at 1795), `1659-1700` (getQueryValuesForInsertAndUpdateInMultipleEdit), `1577-1647` (getCurrentValueAsAnArrayForMultipleEdit for funcs); generation for upload at `Controllers/Table/ReplaceController.php:262-303` (file upload value override; transformation application on values with error accumulation).
Verification: insert rows through the insert form with: empty string into an INT AUTO_INCREMENT (expect NULL), a bit value `1x0` (expect `b'100'`), a hex-function column, `CURRENT_TIMESTAMP(3)` in a datetime and a NULL checkbox with text; compare the generated INSERT (`showinsert`) with the rules. (added in review wave 2)

### FR-DTB-135 — Cell edit with inline/row flows
The system shall support inline editing and "edit next row" navigation after successful edit: after confirmation, a session `edit_next` is set with the next row's unique condition (`SELECT * FROM … WHERE col > val LIMIT 1`).
Evidence: `libraries/classes/InsertEdit.php:1197-1224` (setSessionForEditNext), `1234-1272` (goto options new_insert/same_insert/edit_next).

### FR-DTB-136 — Reported inserts
The system shall report inserted last-insert-id per statement (adjusted upward for multi-row inserts: `first id + totalAffectedRows - 1`, where totalAffectedRows is the running total across statements, so the value is exact only for the first statement; shown as "Inserted row id: %d"; with `submit_type=showinsert` statements are shown, not executed; with `IgnoreMultiSubmitErrors` statements use tryQuery and errors are collected), aggregate affected rows across statements, and forward warnings after each.
Evidence: `libraries/classes/InsertEdit.php:1355-1379` (insertId adjustments, warnings), `1333-1341` (aggregation with per-query tryQuery / affectedRows).

### FR-DTB-137 — Transformations on values
The system shall apply per-column input/output transformations (config storage transformations) to user values and rendered results, with error capture (row skipped on transform failure: `insert_fail`). (clarified in review wave 2) Ownership: the transformation contract, the stored record (`column_info`) and the browse/insert integration are specified in 06-plugins.md (FR-PLG-030 to FR-PLG-035, DATA-PLG-008); this requirement only fixes how the DML flow calls them (`ReplaceController` skips the row and keeps the typed values for redisplay).
Evidence: `libraries/classes/Controllers/Table/ReplaceController.php:270-303` (applyTransformation + `insert_fail`/`row_skipped`), `369-373` (unsaved_values retained for redisplay).

### UI-DTB-010 — Enum/set/relational pickers inside insert/edit
The system shall provide enum value pickers, set value pickers, and foreign-key value pickers (searching by a value / showing display fields) as dialogs for insert/edit/search forms.
Evidence: controllers `libraries/classes/Controllers/Sql/{EnumValuesController,SetValuesController,RelationalValuesController}.php` (invoked by routes for the pickers); foreign dialog implementation `libraries/classes/BrowseForeigners.php:166+` (getHtmlForRelationalFieldSelection).

### FR-DTB-138 — Column-level SQL gen for table change (replace) preview
The system shall support a preview_sql mode for any DML (`ALTER`, FK changes, multi-edit inserts) that builds the SQL but does not execute it.
Evidence: `libraries/classes/Table.php:2407-2419` (dropped FK preview branch); `libraries/classes/Controllers/Table/ReplaceController.php:412` (`empty($query) && ! isset($_POST['preview_sql'])`).

## 13. Limits, position and version-aware rendering

### DEP-DTB-001 — MySQL vs MariaDB/Percona behavioral branches
The system shall branch per server family (`MySQL`/`Percona Server` vs `MariaDB`) and version, at least for: ALTER statement (a) index-rename support (MySQL ≥ 5.7.0 / MariaDB ≥ 10.5.2), (b) integer display width restriction (MySQL ≥ 8.0.18 ⇒ no width on integer types), (c) virtual/generated column support (`VIRTUAL|PERSISTENT|STORED` keyword differences), (d) compressed columns (MariaDB ≥ 10.1 only), (e) `REFERENCES` privilege existence (MariaDB lacks it), (f) UUID type support (MariaDB ≥ 10.7.0).
Evidence: `libraries/classes/Query/Compatibility.php:123-249` (isMySqlOrPerconaDb/isMariaDb, isCompatibleRenameIndex 137-149, isIntegersLengthRestricted 151-159, supportsReferencesPrivilege 161-176, isVirtualColumnsSupported 191-208, isUUIDSupported 210-215, supportsStoredKeywordForVirtualColumns 219-233, supportsCompressedColumns 237-249).

### DEP-DTB-002 — Events on ≥ 5.1 only
The system shall only copy database event definitions when server version ≥ 5.1 (`getVersion() >= 50100`).
Evidence: `libraries/classes/Controllers/Database/OperationsController.php:147-152`.

### DEP-DTB-003 — lower_case_table_names handling
The system shall lowercase new database/table names when `lower_case_table_names = 1` (via `DatabaseInterface::getLowerCaseNames`).
Evidence: `libraries/classes/Controllers/Database/OperationsController.php:92-95`; `libraries/classes/Table.php:1480-1482`; interface `libraries/classes/Dbal/DbalInterface.php:510`.

### INT-DTB-001 — Driver abstraction
All SQL access shall go through a `DbiExtension` implementation ((mysqli) with `realMultiQuery`, `prepare`, `getError`, `affectedRows`, `escapeString`, etc.) wrapped by `DatabaseInterface` (query/tryQuery/tryMultiQuery/fetch* / getVersion / isMariaDB etc.).
Evidence: `libraries/classes/Dbal/DbiExtension.php:24-142` (interface surface), `libraries/classes/Dbal/DbiMysqli.php:41-362` (mysqli implementation with realMultiQuery at 224, prepare at 362), `libraries/classes/Dbal/DbalInterface.php:29-723` (query, tryQuery, tryMultiQuery at 59, getWarnings 413, getProceduresOrFunctions 424, isMySql/isMariaDB/isPercona 703-713).

### DATA-DTB-003 — Config-storage tables used by the subsystems
The following config-storage tables are expected (each optional feature guarded by a feature class): (corrected in review wave 1) `la_bookmark`, `la_history`, `la_savedsearches`, `la_tracking`, `la_designer_settings`, `la_pdf_pages` and `la_table_coords` (designer pages), `la_table_info` (display field, feature flag displaywork), `la_relation` (internal relations, relwork), `la_column_info` (comments/MIME/transformations; record layout in DATA-PLG-008 of 06-plugins.md), `la_central_columns`, `la_table_uiprefs`, `la_navigationhiding`, `la_recent`, `la_favorite` (default names; configurable) — and table/database rename or copy shall update the rows that reference the table/database (best-effort, not atomic).
Evidence: `libraries/classes/ConfigStorage/Features/*.php` (feature classes per table), renames hooks `libraries/classes/Table.php:1321-1323,1553-1554` (Relation::renameTable on move), and `libraries/classes/Operations.php:468-487` (duplicateBookmarks).

### NFR-DTB-001 — Performance: avoid redundant COUNT queries
When user-paginated results exceed max_rows, the system shall avoid re-computing the total when the returned subset already satisfies the cap (`pos + numRows` used instead of COUNT subquery).
Evidence: `libraries/classes/Sql.php:715-719`.

### NFR-DTB-002 — Correctness: show real query on error without LIMIT
Limit negotiation must not be applied to syntactically-wrong queries so the "true query and true error message" is displayed.
Evidence: `libraries/classes/Sql.php:382-389` (comment: assigning LIMIT to a syntactically wrong query is not needed …).

### UI-DTB-020 — Confirmation dialogs
Destructive actions (drop db/tables, empty tables, delete rows) shall require an explicit Yes confirmation (POST `mult_btn` must equal the localized "Yes").
Evidence: `libraries/classes/Controllers/Database/Structure/EmptyTableController.php:71-79` (flash 'No change' if not Yes), `libraries/classes/Controllers/Table/DeleteRowsController.php:56` (`$mult_btn === __('Yes')`; path corrected in review wave 1) (`$mult_btn === __('Yes')`), `DropTableController.php:46-60`.

### CON-DTB-001 — Views: LIMIT not applied + config-storage maintenance
When browsing a view, the row count is unknown if `MaxExactCountViews` = 0 (default) and otherwise capped at that value (see FR-DTB-009), so the system must not present view totals as exact. (corrected in review wave 1)
Evidence: `libraries/config.default.php:2642-2644` (MaxExactCountViews = 0); `libraries/classes/Table.php:790-840`; `Search.php` note inside `Database/Search.php:184-185` (count even for VIEWs with WHERE limiting results).

### CON-DTB-002 — Reserved columns
The system shall warn when creating tables with column names reserved by LegacyAdmin's own config-storage tables ("reserved column names"), as surfaced by `getReservedColumnNames`.
Evidence: `libraries/classes/Table.php:2018-2038` (getReservedColumnNames); runtime value checks in insert/edit via `InsertEdit.php:1858+` (verifyWhetherValueCanBeTruncatedAndAppendExtraData and related checks).

### CON-DTB-003 — Data-only copy semantics
A "data only" table copy must not create the target table (`No table is created when this is a data-only operation`), and for `dataonly|maintainRelations` the config-storage duplication must not run.
Evidence: `libraries/classes/Table.php:1055-1057` (guard `if ($what !== 'dataonly')`), `1329-1333` (`$what === 'dataonly' || isset($maintainRelations)` early return).

## 14. Additions from review wave 1

### FR-DTB-150 — Tracking statement capture hook (added in review wave 1)
After every successful query run through `DatabaseInterface::query/tryQuery` while tracking is active (`Tracker::enable()` at bootstrap), the system shall call `Tracker::handleQuery`. The hook shall do nothing when: the query contains the marker `/*NOTRACK*/` (used for the tracker's own control-user statements); the current database is empty; the tracking feature is not configured; no tracking row with `tracking_active = 1` exists for the database; the statement is not recognised; or no table name could be extracted. If `tracking_version_auto_create` is true and no version exists for the object it shall first create version 1 for CREATE TABLE / CREATE VIEW / CREATE DATABASE. It shall then append the statement (database qualifier removed, prefixed with the `# log <date> <user>` comment) with `CONCAT` to `schema_sql` (DDL) or `data_sql` (DML) of the latest version whose `tracking` set contains the statement identifier (`FIND_IN_SET`) and update `date_updated`. For `RENAME TABLE` the row's `table_name` is changed to the new name.
Evidence: `libraries/classes/DatabaseInterface.php:267-269`; `libraries/classes/Tracker.php:836-960`; `libraries/classes/Common.php:204, 294`.
Verification: enable tracking on a table with `tracking_version_auto_create=true`; run `CREATE TABLE`, `INSERT`, `RENAME TABLE`; assert version 1 exists, DML text appended to `data_sql`, DDL to `schema_sql`, a statement containing `/*NOTRACK*/` is not logged, and statement kinds removed from the `tracking` set are not logged. (added in review wave 2)

### FR-DTB-151 — Tracked statement classification (added in review wave 1)
`Tracker::parseQuery` shall classify the first parsed statement as DDL (CREATE TABLE/VIEW/DATABASE/INDEX, ALTER TABLE/VIEW/DATABASE, DROP TABLE/VIEW/DATABASE/INDEX, RENAME TABLE) or DML (INSERT, UPDATE, DELETE, TRUNCATE, REPLACE) and return identifier, table name (and the new name for renames). A leading `USE db` statement sets the current database (needed for dump imports). `getVersion(db, table, statement)` returns the maximum version (restricted to versions that track the given statement) or -1 when none exists; `isTracked` returns whether the newest version is active and caches the result per request.
Evidence: `libraries/classes/Tracker.php:127-174, 510-552, 700-830`.

### DATA-DTB-004 — Tracking data model (added in review wave 1)
Tracking data shall be stored in table `la_tracking(db_name varchar(64), table_name varchar(64), version int unsigned, date_created datetime, date_updated datetime, schema_snapshot text, schema_sql text, data_sql longtext, tracking SET('UPDATE','REPLACE','INSERT','DELETE','TRUNCATE','CREATE DATABASE','ALTER DATABASE','DROP DATABASE','CREATE TABLE','ALTER TABLE','RENAME TABLE','DROP TABLE','CREATE INDEX','DROP INDEX','CREATE VIEW','ALTER VIEW','DROP VIEW'), tracking_active int(1) default 1)` with primary key `(db_name, table_name, version)`. Versions are positive integers; creating version n deactivates version n-1; only the newest version of an object participates in `isTracked`. Database-level tracking uses the same table with the database name recorded as `table_name` semantics defined by `createDatabaseVersion` (not line-audited).
Evidence: `sql/create_tables.sql:207-224`; `libraries/classes/Tracker.php:193-290, 325-380, 383-500`.

### FR-DTB-152 — Pagination state and defaults (added in review wave 1)
Result pagination shall be driven by per-query session state: `pos` (default 0; taken from request `pos` only when numeric), `max_rows` (request `session_max_rows` if numeric, or the literal `all`, else the remembered value, else `$cfg['MaxRows']` = 25), `repeat_cells` (default `$cfg['RepeatCells']` = 100), `pftext` (`P` partial default, `F` full), `relational_display` (`K` key default from `$cfg['RelationalDisplay']`, or `D` display column), `geoOption` (`GEOM` default; `WKT`, `WKB`), plus flags `display_binary` (default on unless the full-text button was used), `display_blob`, `hide_transformation`. The page number shown is `floor(pos / max_rows) + 1` and the page count `ceil(unlim_num_rows / max_rows)`. The Next button is hidden when the page is the last (`pos + max_rows >= total`) or fewer rows than `max_rows` were returned. When the table is InnoDB and the total exceeds `MaxExactCount`, the End button submits `find_real_end=1` to force an exact count. The navigation row (with "Show all" when allowed by FR-DTB-010) is omitted when `max_rows = all`.
Evidence: `libraries/classes/Display/Results.php:765-895, 940-985, 3464-3590`; `libraries/classes/Sql.php:486-500` (findRealEndOfRows).

### FR-DTB-153 — Column sorting behavior (added in review wave 1)
Clicking a result column header shall add or toggle an ORDER BY term. A column not yet in the ORDER BY gets the direction from `$cfg['Order']` (permitted: ASC, DESC, SMART; default SMART). In SMART mode date, time, datetime and timestamp columns sort DESC first and all others ASC; clicking a sorted column flips its direction; multiple terms accumulate in click order; the existing ORDER BY terms are parsed from the statement. The "remove sort" link carries `discard_remembered_sort=1` (see FR-DTB-007).
Evidence: `libraries/classes/Display/Results.php:1634-1700, 1932`; `libraries/config.default.php:1285-1287`; `libraries/config.values.php:99-103`.

### SEC-DTB-003 — Signed where-clauses for row operations (added in review wave 1; corrected in review wave 2)
Where-clauses passed between pages for single-row edit, field download, search-result edit and zoom-plot edit shall carry an HMAC signature computed with `Core::signSqlQuery`, and the receiving controller shall accept the clause only if `Core::checkSqlQuerySignature` succeeds: `where_clause` + `where_clause_signature` (GET, ChangeController; an invalid signature silently discards the clause), `where_clause` + `where_clause_sign` (GetFieldController, table SearchController, ZoomSearchController). GisVisualizationController applies the same check to `sql_query`/`sql_signature`. (Corrected in review wave 2:) `InsertEdit::getFormParameters` (`InsertEdit.php:120`) accepts a GET `sql_query` only with a valid `sql_signature`, and the transformation wrapper (`Controllers/Transformation/WrapperController.php:101`) treats an invalid or missing `where_clause_sign` as fatal ("There is an issue with your request."), unlike ChangeController/InsertEdit, which silently drop the unsigned value. Row deletion (DeleteRowsController) takes its where-clauses from the POST `selected[]` values without a signature and relies on the session CSRF token.
Evidence: `libraries/classes/Controllers/Table/ChangeController.php:64-68`; `Controllers/Table/GetFieldController.php:66-72`; `Controllers/Table/SearchController.php:215`; `Controllers/Table/ZoomSearchController.php:276, 361-367`; `Controllers/Table/GisVisualizationController.php:62`; `Controllers/Table/DeleteRowsController.php:56-66`; `InsertEdit.php:120`; `Controllers/Transformation/WrapperController.php:101`.
Verification: open the table edit page with a `where_clause` in the URL, once with a valid `where_clause_signature` and once with one character changed; assert the second shows no row to edit (ChangeController) and that GetField/Zoom/Search/Wrapper reject an altered `where_clause_sign`. (added in review wave 2)

### SEC-DTB-004 — Unvalidated SQL fragments (observed behavior, added in review wave 1)
The following inputs are concatenated into SQL with only the server's own privileges as protection, and a rewritten system shall either preserve them knowingly (they are power-user features) or validate them: table-search `customWhereClause` and `order` direction (`Table/Search.php:49-52, 85-86`); zoom-search `maxPlotLimit` (`ZoomSearchController.php:341`, no integer cast; see SEC-DTB-005); QBE per-column criteria text (`Database/Qbe.php:1008-1040`); view `as` SELECT and column list (`Controllers/View/CreateController.php:129-139`); trigger/event/routine bodies (`Database/Triggers.php:413-416`, `Database/Events.php:470-476`). Identifier values in these flows are backquoted and scalar values are escaped with `escapeString`.
Evidence: as cited per fragment.

### SEC-DTB-005 — Zoom-search maxPlotLimit concatenated into SQL (defect, added in review wave 2)
The zoom-search submit action shall treat the POST parameter `maxPlotLimit` as a non-negative integer (default `$cfg['maxRowPlotLimit']` = 500). Observed defect in 5.2.3: `ZoomSearchController::zoomSubmitAction` builds the query as `$sql_query = $this->search->buildSqlQuery(); $sql_query .= ' LIMIT ' . $_POST['maxPlotLimit'];` and runs it with `$this->dbi->query($sql_query . ';')` without any integer coercion, whereas the same controller casts the value with `intval` when it re-displays the form (`:265-266`). Any logged-in user with a valid CSRF token can therefore append arbitrary text after `LIMIT` of the generated `SELECT` on the chosen table (for example `INTO OUTFILE` when the MySQL account has the FILE privilege, `PROCEDURE ANALYSE()` on old servers, or a syntax error that echoes the text). Stacked statements are not possible because `query()` uses the single-statement `realQuery` (not `multi_query`), and the effective privilege is that of the user's own MySQL account, so the severity is low to medium (input-validation/hardening defect, not a privilege escalation). A reimplementation shall validate `maxPlotLimit` as an integer (reject or fall back to the default) and shall bind or cast every LIMIT/OFFSET value.
Evidence: `libraries/classes/Controllers/Table/ZoomSearchController.php:337-345` (concatenation at `:341`), `:265-266` (`intval` in the display path); route `libraries/routes.php:269` (`/table/zoom-search`); `libraries/classes/DatabaseInterface.php:224` (single-statement `realQuery`). Related: SEC-DTB-004, FR-DTB-092.
Verification: log in with a test account, open Table > Search > Zoom search on a table with at least three rows, pick two different criteria columns and submit with `maxPlotLimit` changed in the browser dev tools to `2 PROCEDURE ANALYSE()` (or to `abc`); legacy behaviour: the server error shows the appended text inside the executed query; compliant behaviour: the value is rejected or replaced by 500 and the executed query ends in `LIMIT 500` (check with the general query log). Also submit `maxPlotLimit=2` and assert at most 2 points are returned.

### FR-DTB-154 — Table creation limits and guards (added in review wave 1)
Creating a table shall require a non-empty database name ("The database name is empty!"), an existing database ("'%s' database does not exist."), and a non-existing table ("Table %s already exists!"). The number of column definition rows shall default to 4 when unspecified, equals `num_fields` when positive, equals `orig_num_fields + added_fields` when adding fields, and is capped at 4096 (MySQL maximum). The Add-column flow applies the same cap and defaults to 1 field.
Evidence: `libraries/classes/Controllers/Table/CreateController.php:63-100`; `libraries/classes/CreateAddField.php:436-455`; `libraries/classes/Controllers/Table/AddFieldController.php:83-100`.

### FR-DTB-155 — Navigation tree sizes and pagination (added in review wave 1)
The navigation tree shall load databases in pages of `$cfg['FirstLevelNavigationItems']` (default 100) and the children of a database (tables, views, functions, procedures, events) and of a table (columns, indexes, triggers) in pages of `$cfg['MaxNavigationItems']` (default 50), using `LIMIT pos, n` queries on `INFORMATION_SCHEMA` (or `SHOW` statements when `DisableIS`). Pagination state is carried per path as `pos`, `pos2_name/pos2_value` (container level) and `pos3_name/pos3_value` (item level). With database grouping enabled the first-level page is computed over distinct prefixes (`SUBSTRING_INDEX(SCHEMA_NAME, sep, 1)`) so that a group is never split across pages. A name filter (`searchClause`/`searchClause2`) restricts databases or items with a `LIKE '%…%'` match. `NumRecentTables` and `NumFavoriteTables` (default 10 each, 0 disables) bound the quick-access lists.
Evidence: `libraries/classes/Navigation/NavigationTree.php:134-215, 1372-1420`; `libraries/classes/Navigation/Nodes/Node.php:660-830`; `Nodes/NodeDatabase.php:425-600`; `Nodes/NodeTable.php:152-165`; `libraries/config.default.php:957-966, 1030-1040`.

### FR-DTB-156 — Navigation tree grouping (added in review wave 1)
When `NavigationTreeEnableGrouping` (default true) and `ShowDatabasesNavigationAsTree` (default true) are on, database names shall be grouped by the prefix before the first `NavigationTreeDbSeparator` (default `_`; unlimited depth, 10000). Tables, views and other database children shall be grouped when `NavigationTreeEnableExpansion` (default true) is on, by prefix before `NavigationTreeTableSeparator` (default `__`, may be an array of separators), to `NavigationTreeTableLevel` levels (default 1). A separator at position 0 or at the very end of a name does not create a group; a prefix becomes a group only when at least two siblings share it, and a node whose name equals the prefix is merged into the group. Grouping is skipped when there would be exactly one group containing all siblings except one (the "new" pseudo-node), and a warning is raised for any group with more than 500 members.
Evidence: `libraries/classes/Navigation/NavigationTree.php:200-212, 648-840`; `Navigation/Nodes/NodeDatabaseChildContainer.php:26-30`; `libraries/config.default.php:971-996, 1103-1105`.

### FR-DTB-157 — Navigation filters, ordering and hidden items (added in review wave 1)
A fast-filter box shall be shown on the root node when the number of databases is at least `NavigationTreeDisplayDbFilterMinimum` (default 30) and on a table/view/etc. container when it holds at least `NavigationTreeDisplayItemFilterMinimum` (default 30) items. Siblings shall be sorted case-insensitively, with natural ordering when `$cfg['NaturalOrder']` is true (default), the "new" pseudo-node always first. Users may hide items per object type; hidden items are stored in `la_navigationhiding(username, item_name, item_type, db_name, table_name)`. The default tab opened for a table node is `NavigationTreeDefaultTabTable` (default `structure`).
Evidence: `libraries/classes/Navigation/NavigationTree.php:1294-1335, 1432-1450`; `libraries/config.default.php:1045-1069, 1081-1083, 2651`; `sql/create_tables.sql:276-285`.

### DATA-DTB-005 — Designer page data model (added in review wave 1)
Designer pages shall be stored as `la_pdf_pages(db_name varchar(64), page_nr int unsigned auto_increment PK, page_descr varchar(50))` and table positions as `la_table_coords(db_name, table_name, pdf_page_number, x float unsigned, y float unsigned; PK(db_name, table_name, pdf_page_number))`. Page descriptions are limited to 50 characters by the schema. Per-user settings are in `la_designer_settings(username PK, settings_data text JSON)`.
Evidence: `sql/create_tables.sql:98-106, 178-187, 331-337`; `libraries/classes/Database/Designer/Common.php:269-300, 454-516, 765-800`.

### FR-DTB-158 — Query-by-example form parameters (added in review wave 1)
The QBE form shall start with 3 criteria columns (`criteriaColumnCount` if numeric; plus `criteriaColumnAdd`, floor 0) and `rows` criteria rows (default 0; plus `criteriaRowAdd`; clamped to 0..100), each criteria row posted as `Or<n>[col]`. Each column has a table.column selector (or `*`), optional alias, sort (ASC/DESC) with a sort-order index, a "show" checkbox and a criteria text; columns/rows can be inserted or deleted, and a per-column AND/OR operator and a per-row AND/OR operator combine them. The generated statement is `SELECT <shown columns [AS alias]> FROM <tables> [LEFT JOIN ...] WHERE (col1 crit1) <op> (col2 crit2) ... <rowOp> <Or-row clause> ORDER BY <sorted columns>`; order-by terms for `table.*` columns are skipped; no SELECT clause is produced when no column is marked "show". Criteria text is inserted verbatim (SEC-DTB-004).
Evidence: `libraries/classes/Database/Qbe.php:228-300, 949-1115, 1717-1739`.

### FR-DTB-159 — Saved QBE searches (added in review wave 1)
Saving a QBE search shall store a JSON of `criteriaColumn, criteriaSort, criteriaShow, criteria, criteriaAndOrRow, criteriaAndOrColumn, rows (0..100), TableList, Or0..Orn, criteriaColumnCount` in `la_savedsearches.search_data`. Saving requires a non-empty search name ("Please provide a name for this bookmarked search.") and username and database ("Missing information to save the bookmarked search."); a new search whose (username, db, name) already exists, or renaming onto an existing name, fails with "An entry with this name already exists."; loading a missing search fails with "Error while loading the search.". Without the feature, saved-search controls are not offered.
Evidence: `libraries/classes/SavedSearches.php:122-176, 233-330, 359-400`; `sql/create_tables.sql:293-304`.

### FR-DTB-160 — Foreign-key value pickers (added in review wave 1)
For columns with a relation, the search and edit forms shall render a dropdown of related values when the related table has fewer than `$cfg['ForeignKeyMaxLimit']` (default 100) rows, and a popup browser otherwise; dropdown order is governed by `ForeignKeyDropdownOrder` (`content-id` or `id-content`). The display text uses the related table's display column when `relational_display = D`, else the key.
Evidence: `libraries/classes/Controllers/Table/SearchController.php:392`; `Controllers/Table/ZoomSearchController.php:398, 462`; `libraries/classes/Config/Settings.php:3292-3310`; `libraries/classes/Controllers/Sql/RelationalValuesController.php:45`.

---

## Normalization flows (bonus requirement area)

### FR-DTB-140 — Normalization wizard
The system shall offer a normalization wizard for a table up to 1NF→2NF→3NF: detect partial dependencies and repeated groups, propose new tables (form-based), and apply the resulting CREATE/ALTER scripts; step list configurable by target level (radio normalizeTo 1nf/2nf/3nf).
Evidence: `libraries/classes/Normalization.php:216-985` (getHtmlFor1NFStep1 220, steps 2/3/4 at 272-393, getHtmlFor2NFstep1 402, getHtmlForNewTables2NF 493, createNewTablesFor2NF 528, getHtmlForNewTables3NF 619, createNewTablesFor3NF 689, moveRepeatingGroup 795, getHtmlForNormalizeTable 945-985 normalizeTo radios), dependency detection `findPartialDependencies` 994.

---

## Coverage

| Area | Requirements |
|---|---|
| Browse/query results & LIMIT | FR-DTB-001..012, UI-DTB-001 |
| SQL runner / bookmarks / history | FR-DTB-020..028, SEC-DTB-001/002, CPT-DTB-001 |
| DB create/drop/rename/copy | FR-DTB-030..034 |
| Table create/drop/rename/copy/truncate | FR-DTB-040..049 |
| Alter table / columns / indexes / FKs | FR-DTB-060..066, DATA-DTB-001/002 |
| Views | FR-DTB-070/071 |
| Routines/triggers/events | FR-DTB-080..084 |
| Search (db-wide, table, zoom, find-replace, multi-table, QBE) | FR-DTB-090..095 |
| Operations tab | FR-DTB-100..105 |
| Tracking | FR-DTB-110..114, CPT-DTB-002 |
| Designer | FR-DTB-120..124 |
| DML flows | FR-DTB-130..138, UI-DTB-010 |
| Version branching / dependencies | DEP-DTB-001..003, INT-DTB-001 |
| Persistence / data model | DATA-DTB-001..003, CPT-DTB-001/002 |
| Cross-cutting | NFR-DTB-001/002, UI-DTB-020, CON-DTB-001..003, FR-DTB-140 |
| Review wave 1 additions | FR-DTB-150..160, SEC-DTB-003/004, DATA-DTB-004/005 |
| Review wave 2 additions | SEC-DTB-005 |

Requirement totals per type (corrected in review wave 1; counts of `###` requirement headings) — FR: 93 (82 original + 11 added); NFR: 2; SEC: 5; UI: 3; DATA: 5; CPT: 2; DEP: 3; INT: 1; CON: 3. Grand total: 117 (116 after wave 1, verified in wave 2 by counting `###` headings; SEC-DTB-005 added in wave 2; the original header claimed 44 FR / 63 total, which was a miscount).

## Gaps & open questions

1. **RESOLVED (review wave 2)** — Multi-query splitting: the query box posts to `/import` (`templates/sql/query.twig:1`), where `ImportSql` splits on `sql_delimiter`; the direct `/sql` route never splits (see FR-DTB-021). Remaining design question: whether the rewritten system must keep this indirection (splitting is tied to the import controller, including the 49/50-statement behaviour of FR-IOX-040).
2. **Filename-level export/copy of data-only features.** `Table.php:1349+` mentions mailboxdepend features; verify which config-storage relations are duplicated inline vs. by `duplicateInfo` wrappers when building the copy pipeline.
3. **URL-scope of `sql_signature`** is present only for GET (`SqlController.php:111-115`); decide whether the new system signs all query transports.
4. **Designer + normalization** are implemented as dialog-driven JS-heavy flows; the line-level coverage above captures server-side logic only — client behavior (canvas interactions) is unspecified and needs a UI-level spec.
5. ~~Tracking statement capture mechanism~~ resolved in review wave 1, see FR-DTB-150.
6. **Partition-specific controllers** (`Controllers/Table/Partition/*`) map to maintenance statements but were not line-audited; behavior derived from controller exchange with `Partitioning\Partition`.
7. **Transformation plug-in interface** (input/output transformations on cells) is heavily used in DML flows, but its plugin contract lived outside this subsystem scan (`Plugins/Transformations`) — separate spec needed.
8. **Config default vs. user config**: `libraries/config.default.php` values are referenced (MaxRows 25, InsertRows 2, LimitChars 50, RepeatCells 100, MaxExactCount 50000, MaxExactCountViews 0); `MaxRows` permitted values are {25,50,100,250,500} per CON-CFG-027 in 01-configuration.md; remaining values in `config.values.php` unchecked.
9. **`CentralColumns.min_max_features`** semantics (`Database/CentralColumns.php:483` makeConsistentWithList) were not exhaustively traced.
10. **Bookmark-per-database vs global scope**: `Bookmark::getList()` filters by db/user; verify expected UX for database-less bookmarks (`bkm_database` empty) when porting.
11. (added in review wave 1) **Not covered**: Table Structure controllers (column drop/move, `MoveColumnsController`), `Partitioning/Partition` definition forms, `Transformations`, grid/inline cell editing JS and `GridEditing`/`SaveCellsAtOnce` semantics, `SimulateDmlController`, and the Normalization wizard internals were not line-audited in this wave.
12. (added in review wave 1) No remote SQL validator exists in 5.2.3 (no `SQLValidator` code found); query "validation" is limited to the PHP-SQL-parser errors (see NFR-DTB-002) and server errors.
13. (added in review wave 1) `Tracker::createDatabaseVersion` and database-level tracking rows were not line-audited (see DATA-DTB-004).
14. (added in review wave 2) **Config-storage `column_info` ownership** is split: record layout and transformation semantics in 06-plugins.md (DATA-PLG-008), copy/clear lifecycle in FR-DTB-046/047/070 here. Which Table Structure controllers call `RelationCleanup::column` when a column is dropped was not traced.
