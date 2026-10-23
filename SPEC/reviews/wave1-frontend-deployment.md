# Review wave 1 — 07-frontend.md and 08-deployment-docs.md

Reviewer scope: JS/templates/themes/i18n (07) and deployment/dependencies/build/tests/licence (08). Source of truth: code only; the project `doc/` folder was not used as evidence.

## 1. Spot-check results (code vs. spec)
Verified OK: FR-UIX-002, 003, 016, 017, 025, 037, 076, 093, 096, NFR-UIX-101; FR-DEP-010 (composer + gate), FR-DEP-044, DEP-090..094, DEP-100..102, FR-DEP-101, FR-DEP-150..152, CPT-DEP-003, DATA-DEP-061/063 (19 tables), SEC-DEP-032.
Found wrong or imprecise (fixed):
- FR-UIX-014/015: noscript warning is gated by `is_warnings_enabled` (off on login page); FR-UIX-015 had a typo and a misleading claim that `is_ajax` is a JS test.
- FR-UIX-033: shortcut description incomplete/inaccurate (full list now FR-UIX-111; plain `s`, `k`, Ctrl+K-in-input behaviour, 2000 ms arming).
- FR-UIX-043/044: breakpoint is `<= 768` (code: `windowWidth > 768` = desktop), not `< 768`.
- FR-UIX-085/NFR-UIX-102/DEP-UIX-084: evidence only from doc/; re-derived from ThemeManager/Theme/package.json. Bootstrap version in code is 5.3.8, not "5.0" (doc claim).
- NFR-UIX-100 garbled text, FR-UIX-089 wrong citation (navigation.js).
- CPT-DEP-001: package.json license is `GPL-2.0`, composer.json `GPL-2.0-only`.
- FR-DEP-002: "kept consistent" had no mechanism; real source is `Version.php`; set-version.sh behaviour documented.
- FR-DEP-055 contradicted SEC-DEP-052 (AES/openssl vs sodium); aligned to Crypto.php.
- SEC-DEP-154: composer.json:30 only excludes /test/ from classmap, not from the package.
- DEV-DEP-157: missing check-release-excludes.sh and upload-release.
- Coverage table in 08: types of 024/025 wrong; "Total: 48" wrong (now 97).
- Wrong line cites fixed: ext-openssl is composer.json:61 (not 59); conflict/suggest/require-dev ranges.

## 2. doc/-only evidence handling
08: 46 markers '(evidence from doc/ — removed/needs re-verification)' were added to requirements whose evidence stays doc-based (install/upgrade/Docker/authentication-mode/documentation-obligation/security-policy/licence-notice items: e.g. FR-DEP-023, 040, 042, 070-072, INT-DEP-058, 080-082, CPT-DEP-120..130, SEC-DEP-140..146, CON-DEP-111/112). Re-derived from code: FR-DEP-010, 011, 020, 021, 033, 043, 044, 050, 051, 052, 055, 056, 104, INT-DEP-014, 025, NFR-DEP-016 (partially), 07: FR-UIX-084/085, NFR-UIX-102, scope line, Gap 5.
Docker items (INT-DEP-080..082) cannot be re-derived: Dockerfile is external to the tree.

## 3. New requirements
07: FR-UIX-107 (AJAX request contract), FR-UIX-108 (AJAX response contract), SEC-UIX-109 (session timeout in UI), FR-UIX-110 (JS disabled), FR-UIX-111 (shortcut list), DEP-UIX-112 (theme structure/validation), FR-UIX-113 (languages, locale fallback, .mo build), UI-UIX-114 (RTL languages ar/fa/he/ur), NFR-UIX-115 (browser features), NFR-UIX-116 (accessibility baseline), NFR-UIX-117 (Twig env/cache).
08: FR-DEP-160 (PHP/extension runtime gate), NFR-DEP-161 (permissions/TempDir), DEP-162 (vendor_config), FR-DEP-163 (build/test commands), FR-DEP-164 (translation pipeline), FR-DEP-165 (release packaging), FR-DEP-166 (test bootstrap), CON-DEP-167 (snapshot completeness).

## 4. Unresolved / cross-file issues
- README defines CPT as "compatibility" but 07/08 use CPT for "concept/documentation"; 08 also uses undefined type DEV and IDs without subsystem (DEP-090..103). Not renumbered per instructions; README or IDs need a decision.
- IDs FR-UIX-030/031 never assigned (gap).
- 07 mixes ID types for same area (CPT-UIX-040, DATA-UIX-041 etc.); README lists "UI/UX" type but files use "UI".
- PHP floor 7.2.5 (composer.json:56, index.php:14) — other SPEC files (00-overview, 01-configuration, 09-diagrams) should be checked for consistency (e.g. "PHP 7.1", "7.2.0"); not verified here.
- Bootstrap version: 07 now says 5.3.8 (package.json); any other file saying "Bootstrap 5.0" or citing doc/require.rst is stale.
- Cookie-encryption description (sodium, secret handling) is repeated in 05-security-auth; verify it agrees with SEC-DEP-052/FR-DEP-055 and with truncation/temp-key semantics (doc-only, unverified).
- CSRF token transport in AJAX (hidden `token` inputs and `CommonParams.token`) not fully traced; belongs with 05.
- Clarify whether Ctrl/Alt-modified s/f/e/h key combos triggering shortcuts is a defect (code ignores modifiers).
- Snapshot has no .eslintrc/.stylelintrc/.htaccess/.github, no compiled assets: reproducibility of lint rules and CSS build output cannot be verified.
- MariaDB minimum version (5.5) and MySQL max versions are doc-only; `MysqlMinVersion` code default is 5.5.0 (internal 50500).
