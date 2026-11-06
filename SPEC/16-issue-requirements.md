# 16 — Requirements derived from open LegacyAdmin issues

**Status: PROPOSED, not approved.** Subsystem code `ISS`. Result of the review of the 132 priority candidates of `15-open-issues-triage.md` (`OPEN.md` item 21). Each requirement states what DBLoom shall do so that a problem reported for LegacyAdmin does not repeat, or so that a frequently requested capability exists.

## 1. Method and limits

- **Input:** the 132 rows of the register `reviews/wave6-open-issues-triage.tsv` that are GAP-BUG or GAP-FEATURE, not flagged as PHP or build specific, and that have a `confirmed` label or at least 8 comments. The unclear rows were skipped as requested.
- **Review:** each row was judged by the orchestrating model from the register entry (title, labels, comment count, 700 characters of the body and the Haiku verdict). The full issue pages and comments were **not** read. The wording of the requirements is new; it is not copied from the Haiku sentences.
- **Grouping:** issues that describe the same problem are folded into one requirement. Every issue has exactly one disposition in section 4: ACCEPTED (it contributes to a requirement), DEFERRED (to `FUTURE.md` FU-009) or DROPPED (with a reason). The issue columns in section 2 also list the 71 issues of the second review (`17-issue-requirements-batch2.md`) that were merged into these requirements; section 4 covers only the 132 priority candidates. Of 132 issues: 108 accepted into 40 requirements, 9 deferred, 15 dropped.
- **Evidence rule:** the requirements rest on upstream issue reports, not on the legacy source tree. The defects were **not reproduced**. Where an issue refers to a feature that DBLoom may not have (for example a query builder or the designer), the requirement is conditional.
- **Scope:** all requirements are subject to the scope decision (`OPEN.md` item 1).

## 2. Requirements

### Data handling

| ID | Requirement | Upstream issues |
|---|---|---|
| DATA-ISS-001 | **PROPOSED.** An export shall never silently produce a partial or corrupt file. Every error during an export (a failing query, a server execution-time limit, an unreadable table, a resource limit) shall be reported to the user. By default the export stops with a clear error; the user may choose to skip unreadable tables, and then the skipped tables are listed in a warning shown to the user. Structured formats (XML, JSON) shall stay well-formed in either case. | #16164, #17250, #18028, #20160, #15317 |
| DATA-ISS-002 | **PROPOSED.** Export shall stream its output and shall work for a database with tens of thousands of tables, and for many triggers, without hitting a request time limit, as a background job with progress (UI-ISS-001). Dropping or exporting many objects of one kind shall not need one request per object. | #18027, #18556, #20366, #17597, #18037, #5547 |
| DATA-ISS-003 | **PROPOSED.** Export of a result set shall honour the user's query exactly, including its LIMIT, results of statements that start with WITH, and the selected rows. File-name tokens shall use the real or aliased names, and a multi-database export shall have a defined name. | #17715, #18053, #17858, #18510 |
| DATA-ISS-004 | **PROPOSED.** Export shall round-trip. Character data shall survive in utf8mb4 (including CJK text), expression (functional) index parts and generated-column definitions shall be exported in full, and an export of user accounts shall include the statements that create the account (and not only the grants) so that it can be imported on MySQL 8.4 and MariaDB 10.11. | #17672, #18236, #17996, #14300, #19673, #19679, #19692, #20332, #18997, #19142, #19463 |
| DATA-ISS-005 | **PROPOSED.** Resuming an interrupted import shall continue exactly where it stopped: the offset shall count bytes, not characters, and the session settings (character set, SQL mode, foreign-key checks) shall be applied again on every resumed part. | #19805, #18948, #9887 |
| DATA-ISS-006 | **PROPOSED.** A CSV import shall report problems per column (rejected or over-long column names, a delimiter that merges columns) and shall not report success when part of the file was rejected. | #19414, #19936 |
| DATA-ISS-007 | **PROPOSED.** Copying a table or a database shall handle tables with several key definitions, descending index parts and names that were dropped earlier. It shall verify the copied row counts against the source and report a mismatch; it shall never end silently incomplete. | #16664, #20276, #16961, #19626, #19279 |
| DATA-ISS-008 | **PROPOSED.** Import and export shall support gzip, bzip2, zip, xz and zstd compression, each where the runtime offers it, and shall say which are available. | #16483 |
| DATA-ISS-010 | **PROPOSED.** Editing a row without changing a value shall not change the stored value. Specifically: CR LF sequences are kept, fractional seconds of TIME and DATETIME values are kept, no function (such as now()) is preselected for an existing timestamp, years below 100 are shown correctly, binary values survive, a SET column can be emptied, the enum editor adds no blank members, and an empty-string default is not wrapped in extra quotes. | #19368, #19620, #18677, #17778, #18356, #12277, #16801, #19618, #19669 |
| DATA-ISS-011 | **PROPOSED.** Default values that are expressions (for example unix_timestamp(current_timestamp(6))) shall be sent unquoted for every column type for which the server accepts them. Renaming a generated column shall keep its VIRTUAL or STORED setting. Setting AUTO_INCREMENT on a column that is not a key shall offer to add the key instead of failing. | #14371, #19337, #17838, #13235, #14526 |
| DATA-ISS-012 | **PROPOSED.** Foreign keys: a value picker shall not reset the stored value when no target row matches; suggested constraint names shall be unique within the table; navigation shall work for binary and multi-column keys; the display value of a referenced row shall be available on hover, fetched with one query per page and not one per cell. | #12115, #12682, #14780, #18017, #18728, #13937 |
| DATA-ISS-013 | **PROPOSED.** Binary UUID values shall be shown and edited in canonical form, with the conversion done by the server's own functions. | #16013, #18967 |
| DATA-ISS-014 | **PROPOSED.** Form inputs shall enforce the declared maximum length and type before submit, and a value that cannot be parsed (for example an unknown date expression) shall give a validation message and not an error. | #18117, #15687 |
| DATA-ISS-015 | **PROPOSED.** Key detection shall compare column names case-insensitively. A result set whose base-table keys are known (including a result of a join) shall stay editable, and a failure of DBLoom's own SQL analysis shall never remove row actions (FR-TGT-230). | #15346, #13488, #18337, #17328 |
| DATA-ISS-017 | **PROPOSED.** DBLoom shall read the structure of a table (foreign keys, indexes, generated columns, partitioning) from the server catalog (information_schema) and not by parsing SHOW CREATE TABLE text, so that the SQL mode of the connection (for example ANSI_QUOTES, compare FR-UPD-007) or a definition the parser cannot handle never hides a relation or causes an error or warning when the table is browsed. | #15821 |
| DATA-ISS-016 | **PROPOSED.** Paging shall be correct for large tables: a jump to the last page shall use an exact count or clearly mark an approximate one. The total count shall be skippable for expensive queries. The displayed query time shall include the count query. | #15387, #15285, #13684, #13027, #15291, #20448, #18802 |

### Behaviour

| ID | Requirement | Upstream issues |
|---|---|---|
| FR-ISS-001 | **PROPOSED.** The Ignore option of the insert form shall be applied to the generated statement. If a query builder is kept, it shall include the sort order the user chose. | #16144, #17841 |
| FR-ISS-002 | **PROPOSED.** Browsing shall work for users who have only column-level SELECT (by selecting only permitted columns). The privilege editor shall handle table-level and column-level privileges, including MariaDB-specific ones. Probes that need a privilege (such as replication status) shall run only when the user holds it, so as not to fill the server error log with denials. | #14279, #14615, #17454, #15203, #20067, #16861, #17452, #19253 |
| FR-ISS-003 | **PROPOSED.** When several servers are configured, one unreachable server shall make only that server fail; the application and the other servers stay usable. | #17963 |
| FR-ISS-004 | **PROPOSED.** The setting that hides databases shall work the same in the navigation, the lists and the database selectors. | #16506, #13012, #13449 |
| FR-ISS-005 | **PROPOSED.** The navigation filter shall apply to all names, not only the visible page. The filter and the expansion state shall be kept when the user opens a table, changes tab or refreshes, and folding and unfolding shall work while a filter is active. | #16084, #20271, #17605, #17505, #20254, #20556, #16358, #16788 |
| FR-ISS-006 | **PROPOSED.** Every navigation action shall be a real link (it opens in a new tab), and links shall carry their server, database and table context, including links created from the result of a server-level query and names with non-ASCII characters (encoded exactly once). Uploads and other requests shall keep the server identifier. | #15413, #17296, #20059, #18108, #19949, #15920 |
| FR-ISS-007 | **PROPOSED.** Refreshing after a search shall keep the search criteria. Display options (full text, BLOB contents, character limits) and result-grid column widths shall be remembered per table or query. The default search operator for string columns shall be configurable, with an index-friendly choice available. | #19614, #17914, #14507, #19556, #19882, #20186 |
| FR-ISS-008 | **PROPOSED.** Sorting by a column shall work for any column name, including names that contain dots or other special characters. | #19155, #20509 |
| FR-ISS-009 | **PROPOSED.** The create-user form shall support authentication plugins that take no password (for example auth_socket). Generated passwords shall meet the password policy of the target server or the policy the administrator configured. | #14719, #15491, #17273 |
| FR-ISS-010 | **PROPOSED.** The table and column editors shall offer the compression options of the server (MariaDB page compression and column compression). | #14956 |
| FR-ISS-011 | **PROPOSED.** When creating a view fails (conflicting name, no database selected) the user shall get a readable message with the reason. | #18055, #18103 |
| FR-ISS-012 | **PROPOSED.** A failed request shall never leave the interface in a loading state. It shall show the error and allow a retry. | #20096, #20236, #20362, #15900 |
| FR-ISS-013 | **PROPOSED.** The routine editor shall accept every parameter and return type the server accepts, including MariaDB ROW types, and shall not refuse to save a routine because it does not recognise a type. | #18968, #19295 |
| FR-ISS-014 | **PROPOSED.** Statements submitted together in the SQL editor shall run in one session in order, so that a SET statement (for example of foreign-key checks) applies to the statements after it. | #18226, #12870, #15143, #17479 |

### User interface

| ID | Requirement | Upstream issues |
|---|---|---|
| UI-ISS-001 | **PROPOSED.** Long-running operations (export, import including statement execution, database copy) shall show progress, overall and per table where known. When they end, they shall show what happened and a link back to the page they started from or to the next step. | #6311, #12401, #12237, #12586, #12117, #19761 |
| UI-ISS-002 | **PROPOSED.** SQL autocomplete shall be switchable off by the user (including live syntax checking). It shall handle names with special characters and dots, load schema metadata lazily so that it works on schemas with thousands of tables without repeated failing requests, work on touch devices, and show a popup wide enough for names and types. | #11659, #16314, #18521, #19872, #18133, #18119, #17409, #15449 |
| UI-ISS-003 | **PROPOSED.** The interface shall be accessible: dialogs manage focus (no hidden element keeps focus), the keyboard can jump to a table by name, and the Backspace key never navigates away from a page with unsaved input. | #19793, #13958, #14159, #12559, #15020, #19017 |
| UI-ISS-004 | **PROPOSED.** The navigation shall offer favourites for databases as well as tables, an option to list tables and views in one branch, and grouping of names by a prefix separator in which a click on the prefix lists its members. | #14940, #15242, #15777, #17947, #17618 |
| UI-ISS-005 | **PROPOSED.** Comments of databases, tables and columns shall be shown next to the names in the navigation and the lists. | #6179, #19360 |
| UI-ISS-006 | **PROPOSED.** Layouts shall work on small screens: text in result cells wraps to the column width, timestamp columns do not wrap awkwardly, and side menus stay reachable when the window is resized. The SQL preview shall wrap long queries. | #15189, #18865, #20158, #14733, #15125, #15890, #18761, #19021, #19577, #13959 |
| UI-ISS-007 | **PROPOSED.** Controls shall be offered only where they apply and shall always be reachable: no rename for the PRIMARY key, no page-settings icon on tabs without page settings, no empty extra header columns in a LIMIT query result, and the menu of further column actions (for example making a column the primary key) opens on every screen size. | #17878, #18162, #18079, #17412, #19999, #16408, #19576 |

### Security

| ID | Requirement | Upstream issues |
|---|---|---|
| SEC-ISS-001 | **PROPOSED.** Logout shall end all authentication state, including a sign-on cookie. Two DBLoom instances on the same host with different ports shall not share a session cookie: the cookie keeps the name `__Host-dbloom-session` on the default public port (443 or none in the public origin) and is named `__Host-dbloom-session-<port>` on any other public port, the port taken from `DBLOOM_PUBLIC_ORIGIN` (without it, from the request `Host`). File names shown by the import page shall be output-encoded (regression test for SEC-TGT-112). In account mode a failed TLS connection to a target shall say why, as a fixed reason category (untrusted certificate authority, host name mismatch, expired, not yet valid, handshake failed) without driver text, host or probing detail; in direct mode the failure stays the one uniform message (SEC-TGT-018). **Owner-instructed assistant decision (2026-11-06).** | #17457, #16459, #15541, #16069 |

### Non-functional

| ID | Requirement | Upstream issues |
|---|---|---|
| NFR-ISS-001 | **PROPOSED.** Static assets shall have content-hashed names so that a CDN or reverse proxy in front of a self-hosted DBLoom can cache them. | #19557, #15993 |
| NFR-ISS-002 | **PROPOSED.** Charts shall use queries and memory that are bounded for large tables (aggregation or sampling), and the space usage shown for a table shall never be negative. | #18564, #18771, #17425, #14215 |

## 3. Reading guide

- A requirement marked **PROPOSED** has no owner decision yet.
- Each requirement describes what DBLoom shall do; the subject is DBLoom unless the sentence names another.

## 4. Disposition of every priority candidate

| Issue | Title | Disposition | Target or reason |
|---|---|---|---|
| #6022 | Checkboxes to import data | DEFERRED | Select tables before importing a dump (FUTURE.md FU-009). |
| #6179 | Comments for databases, tables, columns | ACCEPTED | UI-ISS-005 |
| #6267 | Filling random test data in database | DEFERRED | Generate random test data (FUTURE.md FU-009). |
| #6311 | Export progress bar | ACCEPTED | UI-ISS-001 |
| #6317 | Facilitate drag and drop of columns between tables | DEFERRED | Drag a column to another table (FUTURE.md FU-009). |
| #11659 | Feature request: totally turn off autocomplete and sql syntax check | ACCEPTED | UI-ISS-002 |
| #11983 | Feature-Request: Pop-Out SQL Window | DEFERRED | Pop-out SQL window (FUTURE.md FU-009). |
| #12115 | Avoid removing invalid value for relations | ACCEPTED | DATA-ISS-012 |
| #12167 | Action column position | DROPPED | Cosmetic position of an action column of the legacy UI. |
| #12237 | Improve notification after drag and drop import | ACCEPTED | UI-ISS-001 |
| #12277 | Visual enum editor adds extra (blank) values | ACCEPTED | DATA-ISS-010 |
| #12326 | structure window improvement | DROPPED | Default open or closed sections of the legacy structure page. |
| #12340 | Request method to specify columns displayed in selected Designer tables | DEFERRED | Choose the columns shown in the designer (FUTURE.md FU-009). |
| #12401 | Import progress bar | ACCEPTED | UI-ISS-001 |
| #12586 | no way to return from the export page | ACCEPTED | UI-ISS-001 |
| #12682 | Foreign key editor can not add correct default name for new foreign key if anoth | ACCEPTED | DATA-ISS-012 |
| #13082 | Visual Editor for creating Relations and Views | DEFERRED | Visual editor for relations and views (FUTURE.md FU-009). |
| #13235 | Edit an exiting row and setting auto increment should prompt to add index | ACCEPTED | DATA-ISS-011 |
| #13488 | Cannot inline edit when a join is used in 4.7.2, works fine in 4.2.5 | ACCEPTED | DATA-ISS-015 |
| #13684 | Lower than expected query time | ACCEPTED | DATA-ISS-016 |
| #13849 | No copy/paste UI to click in query editor | DROPPED | A context menu with copy and paste is provided by the browser. |
| #13958 | [shortcuts] add a shortcut to jump to table using keyboard | ACCEPTED | UI-ISS-003 |
| #14159 | Remove Backspace functionality | ACCEPTED | UI-ISS-003 |
| #14279 | browse table links fail when user has column specific privileges | ACCEPTED | FR-ISS-002 |
| #14371 | Support expressions (functions) for field defaults (table definition), ALTER, IN | ACCEPTED | DATA-ISS-011 |
| #14507 | Feature: Save width of columns | ACCEPTED | FR-ISS-007 |
| #14615 | I can't create (edit) privilege of table and column level | ACCEPTED | FR-ISS-002 |
| #14719 | Create user form should support auth_socket by disabling password input | ACCEPTED | FR-ISS-009 |
| #14733 | Improve Preview window | ACCEPTED | UI-ISS-006 |
| #14780 | Binary relation link | ACCEPTED | DATA-ISS-012 |
| #14940 | Ability to favorite databases similar to tables | ACCEPTED | UI-ISS-004 |
| #14956 | Implement Page/Column Compression options | ACCEPTED | FR-ISS-010 |
| #15189 | text not wrapping according to column size | ACCEPTED | UI-ISS-006 |
| #15242 | Allow for tables and views in same branch in navigation tree view | ACCEPTED | UI-ISS-004 |
| #15285 | Disable SQL_CALC_FOUND_ROWS | ACCEPTED | DATA-ISS-016 |
| #15346 | Case sensitive: does not contain a unique column | ACCEPTED | DATA-ISS-015 |
| #15387 | browse doesn't show all records | ACCEPTED | DATA-ISS-016 |
| #15413 | Open the Modify Row button to a new tab | ACCEPTED | FR-ISS-006 |
| #15467 | Confirm on insert new record | DEFERRED | Confirm before inserting on Enter; a preference to decide with the UI scope (FUTURE.md FU-009). |
| #15491 | Generate password complexity setting | ACCEPTED | FR-ISS-009 |
| #15541 | restrict some types of uploads | ACCEPTED | SEC-ISS-001 |
| #15687 | Javascript error using timepicker | ACCEPTED | DATA-ISS-014 |
| #15777 | Table grouping doesn't work | ACCEPTED | UI-ISS-004 |
| #15821 | ANSI_QUOTES - Mysql 8: Relations (foreign key constraints) not shown | ACCEPTED | DATA-ISS-017 |
| #16013 | Be more friendly with binary uuid | ACCEPTED | DATA-ISS-013 |
| #16069 | Setting ssl_ca results in OpenSSL error. | ACCEPTED | SEC-ISS-001 |
| #16084 | Filters are applied after pagination in list of tables within database | ACCEPTED | FR-ISS-005 |
| #16144 | Ignore ignored on insert | ACCEPTED | FR-ISS-001 |
| #16164 | Exporting rows does not show that an error has occurred in a subquery | ACCEPTED | DATA-ISS-001 |
| #16314 | SQL query editor completion: Special characters in column names not supported | ACCEPTED | UI-ISS-002 |
| #16459 | Session problem on two servers on one IP and two ports | ACCEPTED | SEC-ISS-001 |
| #16483 | Support newer compressions like xz or zstd | ACCEPTED | DATA-ISS-008 |
| #16506 | hide_db seems to not work | ACCEPTED | FR-ISS-004 |
| #16664 | Errors copying database: multiple primary keys | ACCEPTED | DATA-ISS-007 |
| #16801 | Quotes appear when field type is TEXT and I use default 'as defined' | ACCEPTED | DATA-ISS-010 |
| #16961 | Table copy operation is incomplete for larger data sets | ACCEPTED | DATA-ISS-007 |
| #17154 | Show hidden navigation tree items no vertical scroll | DROPPED | Legacy unhide dialog scroll bug; generic UI-ISS-006 and UI-ISS-003 apply. |
| #17250 | Incomplete exports without error or warning when `max_execution_time` is set | ACCEPTED | DATA-ISS-001 |
| #17296 | Links to tables have missing database | ACCEPTED | FR-ISS-006 |
| #17403 | Back button from another theme | DROPPED | Theme of an earlier session; DBLoom keeps the theme in the user preference. |
| #17409 | CodeMirror hint box should be wider | ACCEPTED | UI-ISS-002 |
| #17412 | Unable to make primary key in structure section (more button) | ACCEPTED | UI-ISS-007 |
| #17454 | Access denied to "SHOW MASTER STATUS" | ACCEPTED | FR-ISS-002 |
| #17457 | SignonSession cookie not removed on logOut | ACCEPTED | SEC-ISS-001 |
| #17505 | Unable to un fold the tree | ACCEPTED | FR-ISS-005 |
| #17567 | No QR code appearing in settings | DROPPED | Locale-dependent number in a legacy QR SVG; DBLoom shall not build SVG attributes from localised numbers (implementation detail). |
| #17605 | Left nav refreshes after accessing a table | ACCEPTED | FR-ISS-005 |
| #17672 | Japanese characters are garbled when exported in SQL format. | ACCEPTED | DATA-ISS-004 |
| #17715 | Export query result ignores query LIMIT | ACCEPTED | DATA-ISS-003 |
| #17778 | Years are seen wrong by date picker | ACCEPTED | DATA-ISS-010 |
| #17838 | Virtuality is all messed up when chancing the column afterwards. | ACCEPTED | DATA-ISS-011 |
| #17841 | Query builder does not include sort order | ACCEPTED | FR-ISS-001 |
| #17858 | @DATABASE@ is empty when exporting? | ACCEPTED | DATA-ISS-003 |
| #17878 | A PRIMARY key should not be possible to rename | ACCEPTED | UI-ISS-007 |
| #17914 | Settings for "Full texts", "show BLOB contents" etc. get reset at every change o | ACCEPTED | FR-ISS-007 |
| #17947 | Click on table prefix doesn't work anymore | ACCEPTED | UI-ISS-004 |
| #17963 | Sql connection errors | ACCEPTED | FR-ISS-003 |
| #17996 | Exporting user accounts does not contain `CREATE USER` | ACCEPTED | DATA-ISS-004 |
| #18003 | Escape key hides the Create view dialog, it cannot be accessed | DROPPED | Legacy Escape-key handling; generic UI-ISS-003 applies. |
| #18017 | value of foreign key to show onhover | ACCEPTED | DATA-ISS-012 |
| #18027 | Fatal error when exporting a database with many tables | ACCEPTED | DATA-ISS-002 |
| #18028 | Error while exporting a database with tables that cannot be read | ACCEPTED | DATA-ISS-001 |
| #18053 | 'Export' option doesn't appear when querying data using with | ACCEPTED | DATA-ISS-003 |
| #18055 | HTTP 400 Bad Request | ACCEPTED | FR-ISS-011 |
| #18079 | Extra columns when running a LIMIT query | ACCEPTED | UI-ISS-007 |
| #18095 | Initialization fails if `mkdir()` is disabled. | DROPPED | PHP temporary directory failure. |
| #18103 | No error messages when creating a view with a conflicting name | ACCEPTED | FR-ISS-011 |
| #18108 | Database and table name encoding doesn't work in Designer | ACCEPTED | FR-ISS-006 |
| #18117 | Max length is ignored for input values | ACCEPTED | DATA-ISS-014 |
| #18119 | autocomplete doesn't come out on mobile | ACCEPTED | UI-ISS-002 |
| #18130 | Order by DESC as default on first click on column  | DROPPED | Default sort direction is a cosmetic preference. |
| #18133 | Improve loading time for autocompletion | ACCEPTED | UI-ISS-002 |
| #18162 | Navigation panel settings icon issues | ACCEPTED | UI-ISS-007 |
| #18226 | Manually doing "SET FOREIGN_KEY_CHECKS=OFF" in the SQL tab | ACCEPTED | FR-ISS-014 |
| #18236 | Functional Index In Exports | ACCEPTED | DATA-ISS-004 |
| #18313 | Issue when reordering routine parameters  | DROPPED | Legacy parameter drag layout bug. |
| #18337 | Row actions are missing when using multiple REPLACE | ACCEPTED | DATA-ISS-015 |
| #18338 | Query and result is no longer visible after row Copy | DROPPED | Legacy 6.0-dev regression after row copy. |
| #18356 | Impossible to unselect SET value | ACCEPTED | DATA-ISS-010 |
| #18510 | Exported filename does not use renamed aliases | ACCEPTED | DATA-ISS-003 |
| #18521 | Wrong Autosuggestion when Column Name ends with a Dot (.) | ACCEPTED | UI-ISS-002 |
| #18556 | Improve multiple triggers export/drop | ACCEPTED | DATA-ISS-002 |
| #18564 | Display chart is not working on big tables | ACCEPTED | NFR-ISS-002 |
| #18637 | Check "Retain query box" by default | DROPPED | Default of one checkbox of the legacy SQL page. |
| #18671 | Scrollbar is missing if profiling was previously enabled | DROPPED | Legacy profiling scrollbar bug. |
| #18677 | Row edit has now() preselected on timestamp columns | ACCEPTED | DATA-ISS-010 |
| #18728 | Slow browse page load with multi-column foreign key | ACCEPTED | DATA-ISS-012 |
| #18771 | Space usage information seems wrong | ACCEPTED | NFR-ISS-002 |
| #18865 | `text-nowrap` for timestamps columns | ACCEPTED | UI-ISS-006 |
| #18948 | #1231 - Variable 'character_set_client' can't be set to the value of 'NULL' | ACCEPTED | DATA-ISS-005 |
| #18968 | Function/Procedure editor NOT supporting ROW data type in parameter list for Mar | ACCEPTED | FR-ISS-013 |
| #19069 | Status variables documentation links to dev.mysql.com are invalid | DEFERRED | Deep links from status variables to the right manual anchor (FUTURE.md FU-009). |
| #19155 | Column sorting does not work when names contain dots | ACCEPTED | FR-ISS-008 |
| #19268 | Uncaught Error: cannot call methods on draggable prior to initialization; attemp | DROPPED | Legacy GIS editor JavaScript error. |
| #19337 | Single quotes around unix_timestamp(current_timestamp(6)) | ACCEPTED | DATA-ISS-011 |
| #19368 | \r\n is replaced with \n when clicking on a value | ACCEPTED | DATA-ISS-010 |
| #19414 | Import CSV shows success and failure as a result | ACCEPTED | DATA-ISS-006 |
| #19556 | Move default search operator for varchar columns into configurable options | ACCEPTED | FR-ISS-007 |
| #19557 | use CDN to provide static files | ACCEPTED | NFR-ISS-001 |
| #19614 | Search, then Refresh -> loses search clauses | ACCEPTED | FR-ISS-007 |
| #19620 | Random millisecond value wen editing time in the webinterface | ACCEPTED | DATA-ISS-010 |
| #19793 | [Bug]: Blocked aria-hidden on an element because its descendant retained focus | ACCEPTED | UI-ISS-003 |
| #19805 | [Bug]: Continuing the upload dump after 'timeout_passed' causes errors due to a  | ACCEPTED | DATA-ISS-005 |
| #19872 | [Bug]: Autocomplete is not getting any response and return code 200 with network | ACCEPTED | UI-ISS-002 |
| #19962 | [Feat]: Import/Export Excel (Office Open XML) Files | DEFERRED | Excel (XLSX) import and export (FUTURE.md FU-009). |
| #20059 | [6.0] File import goes to login | ACCEPTED | FR-ISS-006 |
| #20096 | [Bug]: Stuck on Loading... on error | ACCEPTED | FR-ISS-012 |
| #20158 | [Bug]: Designer side menu is not responsive | ACCEPTED | UI-ISS-006 |
| #20160 | [Bug]: ErrorException: Error reading structure for table test.test: #1932 - Tabl | ACCEPTED | DATA-ISS-001 |
| #20256 | [Bug]: Active last-level tab not remembered on refresh | DROPPED | Legacy preferences sub-tab memory; DBLoom keeps the last tab as a user preference. |
| #20271 | [Bug]: Filtered list of tables reduces on selecting tab | ACCEPTED | FR-ISS-005 |
| #20276 | [Bug]: mysql8 copy table with DESC index | ACCEPTED | DATA-ISS-007 |

## 5. Open points

- The owner shall confirm or reject the requirements; none is approved.
- The remaining 347 GAP rows of the register, and the rows flagged as PHP or build specific, were not reviewed.
- The unclear rows (44) were skipped by decision.
- Requirements about the designer, the query builder or the SQL page depend on which legacy screens DBLoom keeps (`OPEN.md` items 1 and 7).
