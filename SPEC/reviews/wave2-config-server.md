# Review wave 2 - 01-configuration.md and 02-server.md

Reviewer: independent re-verification against legacyadmin 5.2.3 code (doc/ ignored). Edited only 01-configuration.md and 02-server.md.

## 1. Verification of wave-1 edits

### 01-configuration.md
- Re-checked against code: Config constructor/loadDefaults/load merge (`Config.php:111-123, 310-321, 392-400`), `config.values.php` `_validators`/`_userValidators` (whole block, matches FR-CFG-041), `Setup/Index.php` version-check outcomes (matches FR-CFG-056), `ServerConfigChecks` login-cookie checks (SEC-CFG-061), `VersionInformation` 6 h cache (FR-CFG-101), `config.default.php` 3124 lines and `SettingsTest::testConfigDefaultFile` (CON-CFG-106). No factual error found.
- Structure: 106 requirement IDs (001..106), unique, gap-free, order intact; no truncation.
- One correction: DATA-CFG-094 named a sub-settings class `SQLQuery`; the class is `Settings\SqlQueryBox` (config key stays `SQLQuery`). Sub-settings file list and constructor lines added (corrected in review wave 2).

### 02-server.md (author had not re-read it)
- File complete and well-formed: 138 IDs (FR 77, DATA 16, SEC 12, UI 9, INT 9, NFR 7, CPT 4, DEP 3, CON 1), all unique and contiguous per type; section order 1-9, 10.1-10.8, Coverage, Gaps intact; CRLF line endings preserved; route table in FR-SRV-057 intact; no accidental truncation.
- Spot re-checks (all correct): isSuperUser/isGrantUser, Advisor rule counts (48 generic + 7 pre-8.0.3, threshold `>= 80003`), binlog/process-list/copy-user/authentication-plugin/monitor/analyzer/replication-session defects.

## 2. Cross-file items resolved

| Item | Result |
|---|---|
| Defect 5, status flush links GET vs POST | **Refuted - not a defect.** Links are rendered with `data-post="flush=TABLES&..."` (`templates/server/status/variables/index.twig:57`); generic handler `AJAX.requestHandler` (`js/src/ajax.js:228-345`) uses `getPostData()` (`js/src/functions.js:4717-4725`) and sends `$.post(url, params)` when `data-post` is set (`ajax.js:301-308, 335-343`). So `flush` reaches `VariablesController.php:38` as POST. Without JS / with ctrl-shift-meta click / `target`, the plain GET link is sent and the flush is silently ignored. SEC-SRV-012 (g) corrected; FR-SRV-005 annotated. |
| Defects 1-4, 6-8 | Re-verified and confirmed with current line numbers (see Gaps #11 of 02). |
| `config.default.php` as default source | Added CON-CFG-107 (01): authoritative source is `Settings` + `Settings/*` sub-classes + `config.values.php`; mapping of every directive cited by 00/03/04/05/06/07/08 to its setter line; verification recipe. Other files' line cites into `config.default.php` remain valid values (mirror test) but should cite CON-CFG-107 / the setter; owners of those files should adjust (see 3). |
| `isSuperUser()` = "can read mysql.user" | SEC-SRV-009 confirmed against `DatabaseInterface.php:1746-1766`; 05-security-auth.md already carries SEC-SAU-322 with the same definition; cross-reference added in SEC-SRV-009. 00-overview.md was not re-checked for a "real SUPER" claim (grep for `isSuperUser`/`superuser` in 00 found nothing). |
| Server-level export/import/SQL pages (FR-SRV-058) | Ownership confirmed: SQL runner = 03 FR-DTB-020..028; export scopes = 04 FR-IOX-015 and sections 1-3; import = 04 sections 5-7. No SRV duplicates. Cross-reference text added to FR-SRV-058. |
| Router-level authorization (wave-1 unresolved) | None exists (`Routing.php` only dispatches); cross-referenced to SEC-SAU-321; Gap 2 updated. |

## 3. Problems in other files (not edited)
- 00-overview.md:25, 35; 03 (lines 25, 37, 45, 58, 279, 297, 344, 373, 448, 478, 494, 498, 502, 562); 04 (57, 64, 109, 213, 304-362); 05 (639, 838, 934, 962, 1012, 1040); 06 (50-205); 07 (138, 186); 08 (77, 127-147) cite `config.default.php` lines as the default source; suggest citing `Settings` setter lines per CON-CFG-107 (lines in the mirror still match, so values are not wrong).
- 04-io-formats.md line 304-362 style "defaults config.default.php" for `Export/*`/`Import/*`: real source `Settings/Export.php:478`, `Settings/Import.php:118`.
- 00-overview.md NFR-CC-007 duplicates FR-CFG-013/095 (carried over from wave 1; cross-reference suggested).

## 4. Acceptance criteria added (Verification lines, "added in review wave 2")
- 01: FR-CFG-001, 005, 009, 011, 021, 036, 041, 044, 046, 053, 101; CON-CFG-020; SEC-CFG-058, 065; CPT-CFG-071 (15) plus verification in new CON-CFG-107.
- 02: FR-SRV-003, 008, 017, 019, 021, 029, 030, 031, 032, 039, 042, 070; SEC-SRV-003, 004, 009 (15).
- Remaining vague items observed but left (low value / need UI): UI-SRV-001/003 (display formats), NFR-SRV-006 (localization "everywhere"), FR-SRV-004 (replication tables on status page), DATA-CFG-090..094 (bulk default lists; testable by the CON-CFG-107 recipe `new Settings([])`).

## 5. Other edits
- 01 Gaps #2 updated; Gaps #12 (wave-2 verification result) added.
- 02 Gaps #2 and #10 annotated; Gaps #11 (wave-2 verification result, defect re-check) added.
- No IDs renumbered.
