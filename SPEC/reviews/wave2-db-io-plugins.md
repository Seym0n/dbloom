# Review wave 2 - 03-database-table.md, 04-io-formats.md, 06-plugins.md

Reviewer: independent second reviewer (not the wave-1 author). Source: `legacy-release` (source `doc/` ignored). Only the three owned files were edited. Edits are marked "(corrected in review wave 2)" or "(added in review wave 2)"; no ID was renumbered. Files keep their CRLF line endings.

## 1. Wave-1 edits re-verified against code (about 60 items opened)

Confirmed correct (no change): 03 FR-DTB-002/003/006/025/026/027/041/063/070/083, SEC-DTB-002 (denied only when not allowed AND not superuser), SEC-DTB-001, CPT-DTB-002 / FR-DTB-150 (Tracker.php:880-901), FR-DTB-120 (page names unique across databases, `getPageExists` has no `db_name`), FR-DTB-154 (4096), FR-DTB-155/156/157 (config defaults and the 500-member warning), FR-DTB-158 (3 columns, rows 0..100), config defaults MaxRows {25,50,100,250,500}, MaxExactCount etc. Header count 116 (93 FR, 2 NFR, 4 SEC, 3 UI, 5 DATA, 2 CPT, 3 DEP, 1 INT, 3 CON) matches the `###` headings; no duplicate IDs in any of the three files.
04: NFR-IOX-023 (inverted ping condition, Export.php:175/204), NFR-IOX-027 (arithmetic), NFR-IOX-053/054, SEC-IOX-033 (`sanitizeFilename`), FR-IOX-049 (magic bytes, Util.php:2030-2055), FR-IOX-009/072 (Excel is CSV; no XLSX anywhere in `libraries/classes`), FR-IOX-025 gating, FR-IOX-060 candidate list, FR-IOX-066 (600x450), ExportXml/ExportPdf `isAvailable`.
06: FR-PLG-005, 057 (ImportLdi table-only, SchemaPdf TCPDF-only), FR-PLG-025 (`getOptions` iterates defaults), FR-PLG-027 (18 characters stripped), FR-PLG-029 (root files in both lists), FR-PLG-058 (verified by tracing `fixUpMime`: `text_plain_preappend` restores as `Text_Plain_Preappend`; `Bool2Text`, `Longtoipv4`, JPEG/PNG names round-trip).

### Errors found in wave-1 text and fixed
| Where | Problem | Fix |
|---|---|---|
| 04 FR-IOX-040 | Said statements from the 50th on are executed directly and the first 49 go to the SQL controller. Code (`Import.php` runQuery, "Handle rollback from go_sql") flushes the queued statements and executes them in the import itself once the 50th statement arrives; the SQL controller is used only for imports with at most 49 statements. | Main sentence and correction paragraph rewritten; Gap 15 rewritten. |
| 04 FR-IOX-001 | Main sentence still said all 15 formats are available (the correction paragraph said otherwise). | Main sentence rewritten: 13 always, XML needs a database, PDF needs TCPDF+curl; "CSV for MS Excel" is CSV text, no XLSX. |
| 04 FR-IOX-060 / 061 | Main sentence still said three upload backends and "ImpAHA TIMEOUT marker" although the correction paragraph disproved both. | Rewritten: two selectable backends, `UploadSession` disabled. |
| 04 FR-IOX-068 | Claimed schema export also uses the GIS visualization pipeline; `GisVisualization` is used only by `GisVisualizationController` and `GisDataEditorController`. | Claim removed, route `/table/gis-visualization` named. |
| 04 FR-IOX-043 / 045 | Vague ("auto-detect structure", "single-table contexts", "stream rows"); ODS is parsed fully in memory. | Made concrete and cross-referenced to FR-IOX-090/091/093. |
| 03 SEC-DTB-003 | Incomplete: `InsertEdit.php:120` (GET `sql_query` + `sql_signature`) and the transformation wrapper (`WrapperController.php:101`, fatal on bad `where_clause_sign`) also use the signature. | Added. |
| 03 FR-DTB-021 / Gap 1 | Open question "does the query box post to /import?" | Resolved (section 3). |
| 06 DATA-PLG-002 | Text said four legacy root classes but the list showed three; Gap 6 repeated three. | `Text_Plain_Substring` added to both. |
| 06 NFR-PLG-001 | Garbled regex `^([^.].*_.*_.*\.php$`. | Real patterns from `Transformations.php:138-177`. |
| 06 FR-PLG-028 | "items are trimmed" is wrong: unquoted items keep their whitespace (`'option1 , option2 '` -> `'option1 '`, `' option2 '`, per `TransformationsTest`); an unterminated quote also cuts off the last character. | Corrected. |
| 06 FR-PLG-032 | Said `Transformations::clear()` is the cascade; there are two mechanisms (`RelationCleanup` and `clear`), and `clear()` interpolates db/table/column unescaped into the DELETE. | Rewritten with callers and the observation. |
| 06 DATA-PLG-003 / 004 | Listed XML/PDF export and `UploadSession` as bundled without caveat. | Availability/disabled notes added. |

## 2. Duplicates and overlaps resolved (IDs kept)
Ownership rule: 06 owns the plugin framework, 04 owns per-format behaviour and pipeline, 03 owns the events that copy or delete `column_info` rows.
- 04 FR-IOX-003 -> "see FR-PLG-001, INT-PLG-002, SEC-PLG-001" (keeps only the "Bad type!" rule).
- 04 FR-IOX-004 -> "see CPT-PLG-004, DATA-PLG-007, FR-PLG-021..023".
- 04 FR-IOX-069 -> "see CPT-PLG-003/004, DATA-PLG-007" (summary kept).
- 04 FR-IOX-070 -> "see FR-PLG-019/020".
- 06 SEC-PLG-002 -> "see FR-IOX-048"; 06 SEC-PLG-003 -> "see FR-PLG-014"; 06 DEP-PLG-001 -> "see FR-PLG-005 / FR-PLG-057"; 06 INT-PLG-003 -> pointer to FR-IOX-038/039 (which stay as owner of the import format whitelist).
- 04 FR-IOX-001 / 082 point to FR-PLG-057 for the availability matrix.
- column_info overlap 03/06: DATA-PLG-008 and FR-PLG-030..035 are the owner of the record and transformation semantics; 03 FR-DTB-046, FR-DTB-137 and DATA-DTB-003 now say so and keep only the lifecycle (copy on table copy, copy to view columns FR-DTB-070, delete on ALTER/DROP). FR-PLG-032 now names the delete call sites. New 03 Gap 14 records which Table Structure controllers call `RelationCleanup::column` as untraced.

## 3. Specific verifications
- Query box -> `/import`: VERIFIED. `templates/sql/query.twig:1` has `<form method="post" action="{{ url('/import') }}" ... id="sqlqueryform">` with `sql_query` textarea and `sql_delimiter` input (`:111-112`). `ImportController.php:149-173` sets `import_text`, `import_type='query'`, `format='sql'`, `$_SESSION['sql_from_query_box']`, after optional bind-parameter substitution (`parameterized`, `parameters[]`). `ImportSql::doImport` (`:102-135`) splits with `BufferedQuery` and `sql_delimiter`. The `/sql` route itself never splits. Recorded as FR-DTB-021 (rewritten), new FR-IOX-101, 03 Gap 1 (resolved) and 04 Gap 17. Also added FR-IOX-100 (`/import/simulate-dml`, the "Simulate query" button), which wave 1 had listed as unspecified.
- ZoomSearchController maxPlotLimit: VERIFIED at `ZoomSearchController.php:341` (`$sql_query .= ' LIMIT ' . $_POST['maxPlotLimit'];` then `$this->dbi->query($sql_query . ';')`, no cast; the display path at `:265-266` does use `intval`). Single-statement `realQuery` (no stacked queries). Recorded as new SEC-DTB-005 (with severity assessment and test) and referenced from FR-DTB-092 and SEC-DTB-004. Route is `/table/zoom-search` (`routes.php:269`).
- "XML/PDF export always available": was misleading in 04 FR-IOX-001 main text (fixed); 06 FR-PLG-005/057 already correct, DATA-PLG-003 caveat added. Code: `ExportXml::isAvailable()` = database selected; `ExportPdf::isAvailable()` = TCPDF and curl; `SchemaPdf` = TCPDF.
- "Excel means XLSX": no such claim in 03 or 06; 04 already said CSV (FR-IOX-009, Gap 3); made explicit in FR-IOX-001 and new Gap 18. `grep -ri xlsx libraries/classes` finds nothing.
- "Session upload progress works": 04 FR-IOX-060 main sentence still claimed it (fixed); 06 DEP-PLG-003 was already right; DATA-PLG-004 corrected. `Import/Ajax.php:41-46` has `//"session",` commented out.

## 4. Verification lines and concretisation
`Verification:` lines added to the 15 most important requirements per file: 03 (FR-DTB-001, 003, 006, 021, 022, 025, 027, 041, 044, 063, 090, 134, 150, SEC-DTB-001, 002, 003, plus new 005), 04 (FR-IOX-001, INT-IOX-002, FR-IOX-009, 025, NFR-IOX-027, SEC-IOX-033, FR-IOX-037, 040, 041, 042, 049, NFR-IOX-054, FR-IOX-056, 060, 088, 084, plus new 100, 101), 06 (FR-PLG-001, 003, 004, 014, 025, 028, 029, 035, 038, 052, 056, 057, 058, SEC-PLG-005, 006). Vague items made concrete: 03 FR-DTB-011, 012, 064, 101, 102; 04 FR-IOX-043, 045, 068; 06 NFR-PLG-001, DATA-PLG-001, FR-PLG-032. Test steps were derived from the code; none was executed.

## 5. Counts after wave 2
03: 117 requirement headings (93 FR, 2 NFR, 5 SEC, 3 UI, 5 DATA, 2 CPT, 3 DEP, 1 INT, 3 CON); header text updated. 04: two IDs added (FR-IOX-100, FR-IOX-101) in new section 12.6, gaps 17 and 18 added. 06: no new IDs; ledger unchanged.

## 6. Cross-file items (not edited, for other owners)
1. `00-overview.md`, `09-diagrams.md`, `08-deployment-docs.md`, `07-frontend.md`: any statement that SQL typed in the query box goes to `/sql` is wrong (it goes to `/import`); any statement that XML/PDF export is always offered, that "Excel" is XLSX, or that the session upload-progress handler works should be checked against the corrections above.
2. `05-security-auth.md`: add SEC-DTB-005 (maxPlotLimit) to the observed-defect list; `Transformations::clear()` builds a DELETE with unescaped identifiers (06 FR-PLG-032); `SET NAMES '<charset_of_file>'` and LDI terminator interpolation (04 SEC-IOX-096).
3. `01-configuration.md`: FR-CFG-074 duplicates FR-DTB-027 (history cap); MaxRows list confirmed against `config.values.php:92-98`.
4. Not verified by me: `ImportShp` behaviour without the zip extension (06 DATA-PLG-004), line numbers cited with `~`, and the behaviour descriptions of the per-transformation requirements FR-PLG-037..051 beyond the ones listed in section 1 (spot checks only).
