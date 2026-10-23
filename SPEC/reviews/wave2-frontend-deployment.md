# Review wave 2 - 07-frontend.md and 08-deployment-docs.md

Evidence rule: code only (no doc/). Source: legacy-release tree (no vendor/, .github, lint config, compiled assets).

## 1. The 46 doc/-marked requirements in 08

Re-derived from code (marker removed, text corrected): FR-DEP-011, 012, 030, 033, 040, 042, 060; CPT-DEP-024; INT-DEP-058 (rewritten per auth plugin); SEC-DEP-031 (rewritten: not verifiable in code, only include guards + operator duty), 041 (gpg/sha in create-release.sh:731-748, key IDs dropped), 046 (see below), 140, 141, 142, 143, 144, 145, 146; CON-DEP-054, 111, 112; INT-DEP-047 (now OS detection), 065 (ZeroConf), 080 (reverse-proxy hooks only); FR-DEP-070, 071, 072; DATA-DEP-064 (now control connection); FR-DEP-023 (now localised auth-plugin descriptions, Server/Plugins.php); DEP-DEP-096; CPT-DEP-105, 120 (documentation links), 121 (scope from routes.php), 122, 123, 127, 128, 131.
Retired (ID kept, text says retired, no evidence): CPT-DEP-073, 124, 125, 126, 129, 130, INT-DEP-081, INT-DEP-082. Reason: only doc/ evidence, no code counterpart (Docker image/env vars are in an external repo; grep for PMA_HOST etc. outside doc/ finds nothing).
Also removed doc/ residue in gaps 1, 2, 3, 9, 10 and SEC-DEP-154, DATA-DEP-062/066, FR-DEP-002, DEP-162.

Documentation-related requirements now describe code: `Html\MySQLDocumentation::getDocumentationLink` (local doc/html fallback else docs.legacyadmin.net), `Core::linkURL`, `UrlRedirector` allow-list, `Util::getMySQLDocuURL/getDocuURL`, ChangeLog FAQ link rewriting, `/license` and `/changelog` routes (new 07 FR-UIX-118).

## 2. Wave-1 errors found by independent verification (fixed)
- Cookie encryption evidence: wave 1 cited `Crypto/Crypto.php` for SEC-DEP-052/FR-DEP-055. That class implements URL-query encryption (`URLQueryEncryptionSecretKey`). Cookie encryption is `AuthenticationCookie::cookieEncrypt/Decrypt` (sodium secretbox, base64 nonce+cipher); key = `blowfish_secret` if exactly 32 bytes, truncated if longer, else per-session `encryption_key`. 05-security-auth.md already states this correctly.
- PHP gate message: real output is `<p>PHP 7.2.5+ is required.</p><p>Currently installed version is: X</p>` (FR-DEP-010, 160); also present in url.php.
- FR-DEP-160: `mbstring.func_overload` fatal only if mbstring is loaded; hash is probed via `hash_hmac`.
- Bootstrap pin is `package.json:19` (7/8 cited :20 = codemirror). Fixed in FR-DEP-033, NFR-UIX-102. 09-diagrams.md already cites :19.
- LanguageManager built-in table has 95 entries (not 96) - FR-UIX-113.
- SEC-DEP-046: `SETUP_CONFIG_FILE`/`SETUP_DIR_WRITABLE` do not exist anywhere in 5.2.3 code or vendor_config.php (doc-only claim, removed). Debian pma-* tools dropped.
- CPT-DEP-105: jQuery ships only `MIT-LICENSE.txt` (not MIT|GPL); only jquery and codemirror have licence files in js/vendor.
- FR-UIX-111: added that shortcuts_handler.js is not loaded when `DisableShortcutKeys` is true (Header.php:358) and that Ctrl+K outside inputs falls through to the `k` branch and toggles the console twice (possible defect, open decision).
- 07 Gap 2 claimed webpack; build is Babel + Sass via yarn.
- FR-DEP-072: only `upgrade_column_info_4_3_0+.sql` and `create_tables.sql` are used by code (Relation.php:365-395, 1510-1535); the other two upgrade scripts are never referenced.
- Verified OK without change: FR-UIX-107..110, 112, 114, 115, 117; FR-DEP-161..166 (spot-checked: Config.php permission check, getTempDir 0770, vendor_config keys, create-release.sh kits/signing); DATA-DEP-061 (19 tables).

## 3. ID hygiene
Mapping old -> new (08): DEP-090 -> DEP-DEP-090; DEP-091 -> DEP-DEP-091; DEP-092 -> DEP-DEP-092; DEP-093 -> DEP-DEP-093; DEP-094 -> DEP-DEP-094; DEP-096 -> DEP-DEP-096; DEP-100 -> DEP-DEP-100; DEP-102 -> DEP-DEP-102; DEP-103 -> DEP-DEP-103; DEP-162 -> DEP-DEP-162; DEV-DEP-156 -> NFR-DEP-156; DEV-DEP-157 -> FR-DEP-157. (DEP-095/101/104 were already FR-DEP.) The note is in the header of 08.
Cross-references from other files: none. A grep of 00-06 and 09 and README for these IDs (and DEP-162, DEV-DEP) found no hits.
07: FR-UIX-030/031 formally retired as explicit entries. `UI` documented as the README `UI/UX` type. CPT in 07/08 remains semantically mixed with README (compatibility); kept for ID stability, noted in legends. Open decision for README owner: either add "CPT = also product concept/doc" or retype later.
Consistency checks: PHP minimum `^7.2.5 || ^8.0` consistent across composer.json:56, index.php:14, and 00/01/05/09 specs. Bootstrap 5.3.8 consistent (09-diagrams.md:14 ok). Sodium cookie description now consistent with 05-security-auth.md (lines 159-176, 487-492).

## 4. Verification lines
15 each: 08 - FR-DEP-002, 010, 011, 020, 021, 044, SEC-DEP-052, FR-DEP-055, DATA-DEP-061, FR-DEP-063, DEP-DEP-090, FR-DEP-101, 104, 160, NFR-DEP-161. 07 - FR-UIX-016, 017, 019, 023, 037, 076, 085, SEC-UIX-093, FR-UIX-096, 107, 108, SEC-UIX-109, FR-UIX-111, 113, UI-UIX-114.

## 5. For other file owners / open items
- 05-security-auth: confirm CSRF token description (Session::generateToken 16 random chars + HMAC_secret; regenerated in Session::secure at login; hash_equals in Common::checkTokenRequestParam) - added as SEC-DEP-146 here.
- 01-configuration: `SETUP_CONFIG_FILE` does not exist; ensure no spec cites it. ZeroConf semantics (INT-DEP-065) overlap with config specs.
- Unverifiable in this snapshot: eslint/stylelint rules, CI workflows, .htaccess, compiled assets, vendor licences, Docker image.
- MariaDB minimum version is not distinguished in code (only `MysqlMinVersion` 5.5.0).
- Not independently re-verified in depth: FR-DEP-152/153 file counts (289/22 test files), DEP-DEP-102 version pins beyond package.json lines 12-39, 07 FR-UIX-114 rest of list.
