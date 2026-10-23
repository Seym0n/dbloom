# Review wave 1 - 02-server.md

Reviewer scope: `E:\dbloom\SPEC\02-server.md` against legacyadmin 5.2.3 source (code only).
About 40 requirements were spot-checked against source; 19 were found inaccurate or incomplete and corrected.

## 1. Findings and fixes (corrected in review wave 1)

| ID | Problem | Fix |
|---|---|---|
| (header) | Type legend contradicted README (CPT "concept", DEP "dependency", INT "integrity") | Legend aligned with README; note on historically misfiled IDs (NFR-SRV-001..005, UI-SRV-004, CPT-SRV-001, INT-SRV-003..005 are functional) |
| DATA-SRV-001 | `SHOW GLOBAL VARIABLES` is unconditional; cite range too narrow | Clarified, `primary_connection` noted |
| FR-SRV-003 | Max concurrent connections has no per-hour/percentage; formats missing | Precise columns/formats; unguarded Uptime division |
| DATA-SRV-003 | "prefix" map is actually substring (`str_contains`), first match wins | Corrected |
| INT-SRV-002 | Missing: digit-containing names dropped, `x` timestamp, cpu/memory details | Added |
| FR-SRV-012 | Claimed only 4 logging vars settable; code allows any `[a-zA-Z0-9_]+` name | Corrected (4 vars only in the returned set) |
| FR-SRV-013 | Query analyzer executes any statement | Stated |
| FR-SRV-017 | Wrong SQL shape (`SELECT *`), `sort_order` is unvalidated (injection surface) | Corrected + defect flagged |
| FR-SRV-019 | Garbled "ISR"; route/RDS variant/authorization omitted | Corrected |
| SEC-SRV-001 | Listed only 4 of 6 monitor/process AJAX handlers | Extended |
| FR-SRV-022 / CON-SRV-001 | SET path uses double quotes (breaks ANSI_QUOTES); CON claim only true for GET | Corrected |
| SEC-SRV-003 | Missing superuser gate; skip-error/change-primary do not AJAX/redirect; action allowlist | Corrected |
| FR-SRV-027 / DEP-SRV-001 | Skip counter variable switch is MySQL >= 8.4.0, not "legacy-safe"; missing status stmt versions | Corrected |
| SEC-SRV-004 | FALSE: log allowlist only protects URL params; raw `log` is concatenated into `SHOW BINLOG EVENTS IN '...'` | Corrected + defect |
| FR-SRV-029 | `pos` omitted when pos <= MaxRows; default MaxRows 25; POST-only | Added |
| FR-SRV-032 | `DEFAULT <charset> <collation>` wrong: actual ` DEFAULT CHARSET=x COLLATE y`; invalid collation silently ignored | Corrected |
| FR-SRV-033 | `authentication_string` only for MySQL/Percona >= 5.7.6, not MariaDB | Corrected |
| INT-SRV-006 | Warning is for host exactly `localhost` + empty user | Corrected |
| FR-SRV-039 | Branch order and messages wrong/incomplete; unescaped plugin | Rewritten |
| FR-SRV-042 | Evidence path `Controllers/Server/Privileges.php` does not exist | Fixed path, added `drop_users_db`, mode 3 flush, messages |
| FR-SRV-044 | Bulk group assign also needs superuser + CREATE USER | Added |
| NFR-SRV-003 | Garbled text ("per-opposite-surface") | Rewritten (createdb-1/2/3) |
| SEC-SRV-006 | Hash-by-server applies to MySQL 5.7.6-8.0.10 as well; clear-text on MySQL >= 8.0.11 | Corrected |
| SEC-SRV-008 | Wording unclear/inverted | Rewritten |
| FR-SRV-045 | Account locking thresholds are MariaDB >= 10.4.2, others >= 5.7.6 | Corrected |
| FR-SRV-050 | No superuser check; exact error texts | Added |

Spot-checked and found correct: FR-SRV-001/002, DATA-SRV-002/004/005/006, INT-SRV-001/003, FR-SRV-006..011, FR-SRV-014..016, FR-SRV-018, UI-SRV-001/002, FR-SRV-020/021/023, FR-SRV-030/031, INT-SRV-005, NFR-SRV-002, FR-SRV-035/036/040/041/043/046..049, FR-SRV-051..056, DATA-SRV-013, NFR-SRV-005. Their line citations are accurate to within a few lines. No duplicate IDs found. No cross-references to SRV IDs exist in other SPEC files (grep).

## 2. New requirements (added in review wave 1; section 10 of the file)

FR-SRV-057..077, DATA-SRV-014..016, SEC-SRV-009..012, UI-SRV-008, UI-SRV-009, NFR-SRV-007, INT-SRV-008, INT-SRV-009, CPT-SRV-004.

Highlights:
- FR-SRV-057: full route/method/input catalogue of `/server/*` (incl. export/import/sql, FR-SRV-058).
- FR-SRV-062/063, INT-SRV-008, SEC-SRV-010: Advisor engine, rule files (48 generic + 7 pre-8.0.3), expression functions (closes former gap 1).
- UI-SRV-008/009: monitor and process-list refresh rates (2..1200 s, default 5 s), grid defaults.
- DATA-SRV-014/015: alert thresholds and derived-ratio formulas.
- FR-SRV-069..075, SEC-SRV-011: privilege editing rules (REVOKE/GRANT order, REQUIRE/WITH clauses, ALTER USER on MySQL >= 8.0.11, add/copy user flows, password masking).
- FR-SRV-076/077: replication role detection, change-primary flow.
- SEC-SRV-009/012, NFR-SRV-007: meaning of "superuser" and where authorization is (not) enforced, and a defect list.
- CPT-SRV-004: version thresholds table.

## 3. Defects found in the legacy code (to carry into design)

1. Binlog `log` parameter unescaped in SQL (`BinlogController.php:121-126`).
2. Process list `sort_order` unvalidated (`Processes.php:62-66`).
3. `authentication_plugin` unescaped in CREATE/ALTER USER (`Privileges.php:970,3475,3488`).
4. Copy-user column-privilege query compares `Host` to `old_username` (`Privileges.php` ~3211).
5. Status quick-link flush uses GET while controller reads POST (`Data.php:180`, `Status/VariablesController.php:38`) - JS glue unverified.
6. Replication primary credentials kept in session in clear (escaped) text.
7. Monitor log-vars allows any variable name matching `[a-zA-Z0-9_]+`.
8. Query analyzer executes arbitrary SQL.

## 4. Unresolved / cross-file issues

- Whether a router-level authorization middleware exists (Routing.php / Common.php) - belongs to 05-security-auth.md; 02 assumes none.
- `isSuperUser()` semantics ("can read mysql.user") should be mirrored in 05-security-auth.md / 00-overview.md; they may claim a real SUPER check.
- Export/Import/Sql at server level (FR-SRV-058) overlaps 03/04; those owners should confirm ownership and avoid duplicate IDs.
- Advisor is also relevant to 07-frontend (template `server/status/advisor`); not inspected here.
- `Util::formatByteDown/formatNumber` precision semantics, `Charsets` class and `StorageEngine` subclasses (Engines/*) are only touched.
- Not verified: JS-level behaviour of monitor presets, flush quick links, user overview export modal.
- 02-server.md still contains pre-existing mis-typed IDs (see header note); renumbering was prohibited.
