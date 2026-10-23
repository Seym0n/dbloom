# Review wave 1 — 03-database-table.md

Reviewer scope: Database/Table/SQL subsystem spec. Evidence verified against `legacy-release/libraries/classes` (source `doc/` ignored). About 30 requirements were spot-checked.

## Findings and fixes (corrected items)

| ID | Problem | Fix |
|---|---|---|
| CPT-DTB-002 | Cited a config key `tracking_record_uncreate_drops` that does not exist; claimed auto-versioning on DROP. Real mechanism is `tracking_version_auto_create` (CREATE TABLE/VIEW/DATABASE only). | Rewritten, cites Tracker.php:880-901. |
| FR-DTB-006 | Presented clamping as general browse behaviour; it is only called after row delete / table empty, and uses an exact count. | Rewritten with formulas and callers. |
| FR-DTB-025 | "replace" flag described as a special bookmark type; in fact it deletes same-label bookmarks of the user/db first. `bkm_all_users` handling differs between the two code paths. | Rewritten. |
| FR-DTB-026 | Placeholder syntax given as `%[VARIABLEn]%`; real syntax `[VARIABLEn]` (plus `[VARIABLE]`), comment-stripping, empty value semantics missing. | Rewritten. |
| FR-DTB-021 | Claimed plain runner splits statements on `sql_delimiter`; delimiter is used only by rollback pre-check and SimulateDml; `/sql` runs one `tryQuery`. | Rewritten, open question kept (gap 1). |
| FR-DTB-071 | Mixed views with event backup/restore; no view backup exists. | Rewritten. |
| FR-DTB-070 | CHECK OPTION modes (CASCADED/LOCAL), OR REPLACE, ALTER, whitelisting omitted; algorithm "Temptable" is `TEMPTABLE`. | Rewritten. |
| SEC-DTB-002 | Text said "unless both allowed AND superuser"; code denies only when not allowed AND not superuser. | Fixed. |
| FR-DTB-007 | Omitted `RememberSorting` flag, exact SELECT-* conditions, session vs `table_uiprefs` storage. | Tightened. |
| FR-DTB-002 | Omitted default-bookmark lookup and `TablePrimaryKeyOrder`. | Added. |
| FR-DTB-027 | Omitted 1000-char skip, `QueryHistoryDB`, getHistory returning false without feature. | Added. |
| FR-DTB-110/111 | Drop lines are conditional on config flags; storage columns missing. | Added. |
| FR-DTB-100 | Partition controllers also include DROP/REBUILD/TRUNCATE; `DisableMultiTableMaintenance` missing. | Added. |
| FR-DTB-063 | Error message quotes; extra validation errors and `preview_sql`. | Added. |
| DATA-DTB-003 | Used wrong/informal table names (displaywork, relwork, `*)`). | Replaced by real `la_*` names. |
| UI-DTB-020 | Cited non-existent path `libraries/classes/DeleteRowsController.php`. | Corrected path. |
| FR-DTB-134 | Vague "type-specific" encoding. | Replaced by concrete per-type rules. |
| Header counts | "FR: 44 ... Grand total 63" was wrong (82 FR headings originally). | Recounted: 116 total after additions. |
| Citation drift | SqlController bookmark lines, DesignerController duplicate-name line, Search.php WHERE FALSE line, Sql.php count lines. | Adjusted to verified ranges. |

Also tightened: FR-DTB-003, 004, 005, 008, 009, 010, 020, 022, 023, 024, 041, 065, 082, 083, 084, 090, 091, 092, 120, 121, 123, 130, 136, CON-DTB-001, DATA-DTB-002, CPT-DTB-001.

## New requirements (added in review wave 1)

FR-DTB-150 tracking capture hook; FR-DTB-151 tracked-statement classification; DATA-DTB-004 tracking data model; FR-DTB-152 pagination state/defaults; FR-DTB-153 column sorting (Order=SMART); SEC-DTB-003 signed where-clauses; SEC-DTB-004 unvalidated SQL fragments; FR-DTB-154 table creation limits (4096 cols, default 4); FR-DTB-155 navigation sizes/pagination; FR-DTB-156 navigation grouping; FR-DTB-157 navigation filters/sort/hidden items; DATA-DTB-005 designer page data model; FR-DTB-158 QBE parameters (3 cols, rows 0..100); FR-DTB-159 saved QBE searches; FR-DTB-160 foreign-key value pickers.

## Unresolved / cross-file issues

1. Gap 1 (does the query box post multi-statement text to `/import`?) is still unverified; belongs with 04-io-formats.md / 07-frontend.md. Also `SimulateDmlController` and Import rollback (ImportController:819-823) should be specified in 04.
2. MaxRows permitted values {25,50,100,250,500} are in 01-configuration (CON-CFG-027); 03 now refers to it. Please confirm the number matches `config.values.php`.
3. 01-configuration FR-CFG-074 duplicates FR-DTB-027 (history cap); keep cross-referenced, no conflict found.
4. Security observations for 05-security-auth: ZoomSearchController.php:341 concatenates `$_POST['maxPlotLimit']` into SQL without integer cast; table-search `order` direction and `customWhereClause` are raw (Table/Search.php:49-52, 85-86); Qbe criteria raw. See SEC-DTB-004.
5. Designer quirks to confirm as intentional: page names unique globally (not per db), `deletePage` ignores db (Designer/Common.php:328-345, 389-410).
6. `MaxTableList` / `MaxDbList` config keys appear in this code base only in config descriptors; their runtime use was not located (templates not searched); not specified here.
7. 09-diagrams.md ER/state diagrams should reflect la_tracking, la_pdf_pages/table_coords and navigationhiding schemas (DATA-DTB-004/005).
8. Not audited (listed in gaps 11-13): Table Structure controllers, Partition definition forms, Transformations plugin contract, grid editing, createDatabaseVersion.
