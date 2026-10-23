# Review wave 2 - 05-security-auth.md

## 1. Verification of wave-1 edits
- ID uniqueness: no duplicates (script-checked). Ranges 001-090, 200-208 (first author), 300-318 (second author); no overlap. New IDs 319-324 (this wave).
- Section order OK: 5.0a precedes 5.1; 5.2/5.3 follow. Defect fixed: section "11." used `###` while all other numbered sections use `##` (corrected).
- Formatting defect fixed: FR-SAU-007 had an unclosed backtick (`password']`).
- Semantic duplicates between the two halves: SEC-SAU-302 = FR-SAU-203 (AllowDeny); SEC-SAU-312 = SEC-SAU-201 + 033 (cookie attributes). Contents agree; kept (no renumbering), note added at top of section 11.
- DEP-SAU-084 base text still said short secrets "disable recall", contradicting its own wave-1 correction; fixed.
- Code re-verified: SEC-SAU-024 (`>= 2000`), 071 (17-host list), 303 (/8 mask = 0x7F000000), 039 logout POST+token, 041 (non-POST returns early), 313 (route logic). All correct.
- Count claims: none inconsistent; wave-1 note "IDs up to 090" correct.
- Still-open drift (not edited): FR-SAU-035 line cite.

## 2. Added (added in review wave 2), section 12
- SEC-SAU-319 binlog raw `log` concatenation (BinlogController.php:121-126; allow-list only affects URL params). Verified.
- SEC-SAU-320 ZoomSearch `maxPlotLimit` raw in LIMIT (ZoomSearchController.php:341; line 265 casts, 341 does not). Verified.
- SEC-SAU-321 no router-level authorization; authentication uniform in Common::run except isMinimumCommon entry points and `/import-status` (Common.php:91). Verified.
- SEC-SAU-322 isSuperUser() = `SELECT 1 FROM mysql.user LIMIT 1` has rows, session-cached (DatabaseInterface.php:1746). Verified. 00-overview/02 owners should mirror it.
- SEC-SAU-323 process-list `sort_order` unvalidated (Processes.php:62-66; column is backquoted, direction is not). Verified.
- SEC-SAU-324 CSRF checked only for POST (new; Common.php:477).
- 12.1 threat model table (auth, session, CSRF, XSS, SQLi, LFI, open redirect, upload, 2FA) with mitigations and gaps.
- "Verification:" lines added to 16 requirements: 020, 024, 033, 034, 040, 041, 045, 049, 059, 070, 071, 302, 303, 304, 305, 310.

## 3. Cross-file notes
- 02-server: SEC-SRV-004 / FR-SRV-017 should reference SEC-SAU-319/323; 02's assumption "no router authorization" is confirmed by SEC-SAU-321.
- 03-database-table: SEC-DTB-004 should reference SEC-SAU-320.
- 08-deployment: FR-DEP-055 "AES" wording still wrong (code uses only XSalsa20-Poly1305).
- Unverified: vendor library behaviour (Google2FA step, WebauthnLibServer signature check).
