# Review wave 1 - 04-io-formats.md and 06-plugins.md

Reviewer scope: `E:\dbloom\SPEC\04-io-formats.md`, `E:\dbloom\SPEC\06-plugins.md`. Evidence base: source under `legacy-release` (source `doc/` ignored). Only these two files were edited.

## 1. Method

About 60 requirements were checked against the code (all of the following were opened): `Plugins.php`, `Plugins/{Plugin,ExportPlugin,ImportPlugin,SchemaPlugin,TransformationsPlugin,IOTransformationsPlugin}.php`, `Transformations.php`, all `Abs/*` transformation plugins and the Input/Output/root concrete classes (class/MIME map), `Export.php`, `Import.php`, `File.php`, `ZipExtension.php`, `Util.php` (`expandUserString`, `getCompressionMimeType`, `setTimeLimit`), `Sanitize::sanitizeFilename`, `Controllers/Export/ExportController.php`, `Controllers/Import/ImportController.php`, `Import/Ajax.php`, `StatusController`, `CheckTimeOutController`, import plugins (Csv, Sql, Ldi, Ods, Xml, Mediawiki, Shp), export plugins (Csv, Excel, Json, Yaml, Phparray, Latex, Ods, Codegen, Xml, Pdf, Sql data path, Texy/Htmlword/Mediawiki escapes), Schema plugins, Gis classes, `WrapperController`, `config.default.php`.

## 2. Findings that were wrong or misleading in the original text (fixed in place, marked "corrected in review wave 1")

| ID | Finding | Fix |
|---|---|---|
| FR-IOX-001 | Claimed all 15 formats are always available; XML needs a selected DB, PDF needs TCPDF + curl. No ext/MIME table. | Added availability and full extension/MIME table. |
| INT-IOX-002 | Listed `exportStructure` as mandatory and said any `false` aborts the phase; actually `exportDBCreate` is abstract, `exportStructure` optional, header/footer failures are swallowed (`ExportException` caught and ignored). | Rewrote failure semantics. |
| FR-IOX-006 | Force-file is also set for Word, ODS, ODT, PDF (not only YAML). | Listed all five. |
| CPT-IOX-014 | CodeGen called a "stub"; it has two real handlers (NHibernate C# / XML). | Documented handlers, identifier rules, error text. |
| NFR-IOX-023 | `X-pmaPing` every 30 s; the condition `$time_start >= $timeNow + 30` is inverted and never true. | Documented defect. |
| NFR-IOX-027 | 1.5 MB reserve is 1,500,000 bytes and only subtracted if limit > 1,500,000; divisor 8 (comment says 1/3); default `MemoryLimit='-1'` makes the 2 MB fallback the normal case. | Exact arithmetic added. |
| SEC-IOX-033 | "dots removed" - actually every char outside `[A-Za-z0-9_-]` replaced by `_` (first pass), then extension appended; second pass keeps dots. | Corrected. |
| FR-IOX-040 | "first <=50 shown": really first 49 statements deferred to the SQL controller, one-statement look-behind buffer, query-text suppression thresholds (50000 chars / 50 stmts / 1000 length), CR->LF, `sql_delimiter`, `SET SQL_MODE`. | Corrected/extended. |
| FR-IOX-041 | `csv_replace` described as an action; it is `ON DUPLICATE KEY UPDATE`. Garbled citation ("skip 64:654"). | Corrected, citations repaired. |
| FR-IOX-042 | Claimed date detection; code has only NONE/VARCHAR/INT/DECIMAL/BIGINT. | Corrected with type-widening rules and DDL shape. |
| FR-IOX-044 | `libxml_disable_entity_loader()` only for PHP < 8. | Corrected. |
| FR-IOX-049 / Gap 5 | Compression detection basis unknown; it is magic bytes (`1F8B`, `BZh`, `PK\3\4`); ZIP imports only first entry (ODS -> `content.xml`; SHP pattern). | Corrected; Gap 5 resolved. |
| FR-IOX-050 | BOM stripped only on first chunk, only without charset conversion, never for pasted text. | Corrected. |
| FR-IOX-051 | Per-chunk conversion can split multibyte chars; unvalidated `SET NAMES` interpolation. | Risk note added. |
| NFR-IOX-053 | `-1` -> 10 MiB only as literal string; effective read_limit with defaults 1,310,720; max chunk 262,144. | Exact values added. |
| NFR-IOX-054 | Deadline arithmetic (`ExecTimeLimit` 300 -> stop after 294 s), edge case max_execution_time <= 5, `getNextChunk` returns `false` on timeout. | Added. |
| FR-IOX-060 | Three upload backends: `session` handler is commented out; only `progress` and `noplugin` are candidates; chosen per request. | Corrected. |
| FR-IOX-061 | "ImpAHA TIMEOUT marker" has no basis in code; the route has a message-polling mode and a JSON status mode. | Corrected. |
| INT-IOX-063 | `getShape` is not in the abstract base; only Point/MultiPoint/MultiLineString/MultiPolygon implement it. | Corrected. |
| FR-IOX-064 | Wrapper function depends on server version (`ASTEXT` < 5.6, axis-order option for MySQL >= 8.0.1). | Added. |
| Coverage note | "all 12 Gis classes" - directory has 10 files. | Corrected. |
| Gaps 5, 7, 8 | Resolved (see FR-IOX-049, FR-IOX-084, FR-IOX-085). | Marked RESOLVED. |
| 06 header | Path prefix `bindings/legacyadmin5/` does not exist. | Replaced by source-root-relative statement. |
| FR-PLG-021 | "no options" flag is computed from the last main group only. | Corrected. |
| FR-PLG-023 | `DocPropertyItem` is not skipped; its branch echoes the class name. | Corrected. |
| FR-PLG-025 | `getOptions` keeps only keys of the defaults array (extra passed options are dropped). | Corrected. |
| FR-PLG-027/029 | `Transformations` methods are instance methods; root-level transformation files are listed as both output and input transformations; stored name format. | Corrected/clarified. |
| SEC-PLG-003 | Examples `sql_include_indexes` (does not exist) and `csv_replace` (import-only, not in the export allow-list) were wrong. | Corrected. |
| FR-PLG-014 | Allow-list does not contain `pdf_report_title`, `xml_export_struc`, `csv_replace`; import uses a prefix-based promotion. | Detailed. |
| INT-PLG-004 | "format normalized to sql under skip/partial retry": actually forced for query box, `sql_file`, and bookmark runs. | Corrected. |
| DATA-PLG-002 | Four (not three) legacy root classes (`Text_Plain_Substring` missing); concrete-to-abstract mapping added. | Corrected. |
| DATA-PLG-005 | Schema helper directories are `Schema/{Dia,Eps,Pdf,Svg}/`, not `SchemaPdf/`. | Corrected. |
| DEP-PLG-003 | Upload backend chosen per request, not install time. | Corrected. |
| Total count | "56 requirements" vs actual 67 (36+5+2+6+4+6+2+3+3). | Corrected; ledger rows extended. |

Clarifications (no factual error, marked "clarified"): FR-IOX-012, FR-IOX-056, CPT-PLG-001, FR-PLG-001 (note that `getPlugin` ignores `isAvailable`), FR-PLG-003, FR-PLG-016, FR-PLG-020, FR-PLG-027/028/034/035/036, SEC-PLG-005/006, DATA-PLG-004.

## 3. New requirements (added in review wave 1)

04-io-formats.md (section 12): FR-IOX-071 (CSV export), 072 (Excel), 073 (SQL data values), DATA-IOX-074 (SQL defaults), FR-IOX-075 (JSON), 076 (XML), 077 (YAML), 078 (PHP array), 079 (LaTeX), 080 (ODS), 081 (Word/Texy/MediaWiki/ODT), 082 (PDF), DATA-IOX-083 (general export defaults), FR-IOX-084 (maxsize), 085 (ZIP entry naming), 086 (filename template), 087 (server/db iteration and legacy coupling), 088 (CSV import parse/validation), DATA-IOX-089 (import defaults), FR-IOX-090 (MediaWiki import), 091 (ODS import), 092 (LDI), NFR-IOX-093 (whole-file buffering), NFR-IOX-094 (upload limits), FR-IOX-095 (upload errors), SEC-IOX-096 (injection-prone interpolations), FR-IOX-097 (schema export), 098 (GIS editor), 099 (GIS visualization). Added gaps 13-16.

06-plugins.md (section 6.10): FR-PLG-037 to 058 (per-transformation input/output/option contracts, concrete class/MIME table, wrapper route, availability matrix, name case round trip), SEC-PLG-007, 008, DATA-PLG-007 (property API), 008 (persistence record), INT-PLG-005, 006, CPT-PLG-006, UI-PLG-003, NFR-PLG-004. Added gaps 11-13.

## 4. Duplicates / overlaps between 04 and 06 (not removed; IDs must not be renumbered)

- Import local-file sanitization: FR-IOX-048 vs SEC-PLG-002; whitelist/factory: FR-IOX-038/039 vs INT-PLG-003 and SEC-PLG-001.
- PDF/curl availability: FR-PLG-005 vs DEP-PLG-001 (identical evidence); FR-IOX-082 now cross-refers.
- Default-format selection: FR-IOX-070 vs FR-PLG-019/020; property model: FR-IOX-004/069 vs CPT-PLG-003/004 and FR-PLG-021..024.
- Export POST allow-list: FR-PLG-014 vs SEC-PLG-003 (same code, two requirements).
- Recommendation: keep 06 as owner of the plugin framework and 04 as owner of per-format behaviour; treat the pairs above as one requirement when building a traceability matrix.

## 5. Unresolved / cross-file issues (not edited, outside scope)

1. `00-overview.md`, `09-diagrams.md`, `08-deployment-docs.md`: please check any statements that (a) XML/PDF export is always available, (b) "Excel" export means XLSX (it is CSV), (c) the upload-progress "session" backend is supported, (d) filenames keep dots.
2. `05-security-auth.md`: Plugin family "Authentication" is described in 06 only at contract level (SEC-PLG-006); auth_type valid values are config/cookie/http/signon. Verify consistency of naming there.
3. `01-configuration.md` should list the defaults used here (`ExecTimeLimit` 300, `MemoryLimit` '-1', `UploadDir`/`SaveDir` empty, `ZipDump`/`GZipDump`/`BZipDump`/`CompressOnFly` true, `DefaultTransformations`, `Export`/`Import`/`Schema` blocks) - not verified there.
4. `03-database-table.md`: transformation persistence (`column_info`, Table structure save) overlaps with DATA-PLG-008 / FR-PLG-031.
5. Code defects reported as requirements-to-avoid (see NFR-IOX-023, SEC-IOX-096, FR-PLG-058, UI-PLG-003); they were read from the code, not executed.
6. Not covered in depth (still open): `Export/Helpers/Pdf` layout details, `ExportSql` structure (DDL) generation rules (only data path and options documented), `SimulateDml`, Schema plugin drawing internals, TwoFactor plugins (belongs to 05).
