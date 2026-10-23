# Review wave 1 - 05-security-auth.md, second half (sections 5.1 to end of section 10, plus Gaps typo)

## Verified (spot-checked against code, all correct unless listed below)
SEC-SAU-069/070/073/074/075/076 (Common.php, Core.php, ImportController), FR-SAU-058 (60000 ms timeout, 32-byte challenge, cross-platform, discouraged, attestation none), FR-SAU-060, FR-SAU-061 (session blob unset), FR-SAU-065, INT-SAU-081, FR-SAU-066/067 (Crypto.php), NFR-SAU-085, CON-SAU-087, Gap 6 "no HSTS" (grep-verified: no Strict-Transport-Security anywhere), Gap 2 (no hotlink backend).

## Findings and fixes (all marked "corrected in review wave 1")
1. Heading 5.1 said TOTP/HOTP: only TOTP (Google2FA verifyKey) exists. FR-SAU-054 made precise: window +-8 steps, input `2fa_code`.
2. FR-SAU-059: omitted credential-id allow check; origin compares host only (from client-controlled Host header); CustomServer performs NO signature verification or sign-count check. Documented as observed behaviour/risk.
3. FR-SAU-063: "unless one is stored" was wrong for setup(); a new 32-byte id is always generated.
4. FR-SAU-064: claim "without revealing internals" was false: raw exception messages (webmozart Assert text) are shown. Corrected.
5. FR-SAU-066: added key-length handling, nonce/MAC sizes, and that the feature is off by default (`URLQueryEncryption=false`).
6. SEC-SAU-071: allow-list enumerated (17 hosts, exact match); regex trailing-newline note.
7. FR-SAU-072: referenced non-existent `Core::getLinkTarget`; real function `Core::linkURL` (strips everything except `url`).
8. SEC-SAU-077/078: exact header values and full CSP directive strings; absence of frame-ancestors/base-uri/form-action noted.
9. DEP-SAU-079: "Horde-style" unfounded; direct `header()` calls exist (headerJSON, noCacheHeader, downloadHeader).
10. DEP-SAU-084: wrong that short secrets disable recall; recall is disabled only when the secret is empty; >32 bytes truncated.
11. FR-SAU-089: precise TrustedProxies semantics (exact IP key, first header element, FILTER_VALIDATE_IP).
12. INT-SAU-080: factory selection order corrected. DATA-SAU-083: literal session key names (with spaces) noted.
13. CPT-SAU-090: truncated sentence/stray `;` fixed; actual check `PHP_VERSION_ID < 70205`.
14. Gap 6 typo "CSP.spoken" fixed.

## New requirements (added in review wave 1), section "11. Additional requirements"
SEC-SAU-300 (URL query encryption `eq` wire format/list of params/failure behaviour), 301 (Sanitize::sanitizeMessage BBCode/link rules), 302 (IP allow/deny semantics, AllowRoot, AllowNoPassword), 303 (IPv4 CIDR mask defect: top bit ignored), 304 (Core::securePath), 305 (upload security: is_uploaded_file, symlink rejection), 306 (U2F challenge not single-use), 307 (download headers/sanitizeFilename), 308 (escapeJsString), 309 (safeUnserialize whitelist), 310 (SQL query HMAC), 311 (backquote), 312 (cookie attributes), 313 (routing 404/405), 314 (outbound TLS verification), 315 (error reporting), 316 (sendHeaderLocation), 317 (removeRequestVars), NFR-SAU-318 (CSPRNG usage).
Note: the task example prefix "SEC-HTTP-300" was not used; the file's existing subsystem code SAU was kept (IDs start at 300 within each type prefix, no renumbering).

## Unresolved / cross-file issues
- Scope split: "second half" was taken to start at 5.1 (line ~371 originally). FR-SAU-049..053 (first half) not touched.
- Defects recorded as spec facts but needing a product decision: SEC-SAU-303 (CIDR top-bit bug), CustomServer lacking signature verification (FR-SAU-059), U2F challenge reuse (306), ineffective error-report time window (315).
- vendor/ is not in the tree, so Google2FA step length (30 s assumed) and WebauthnLibServer signature validation are unverifiable.
- HMAC_secret users (Gap 10) now partly covered by SEC-SAU-310; Core::checkSqlQuerySignature callers not enumerated.
- Gap 8 (captcha only for cookie logins) and CSRF/session items belong to the first half and were not re-verified.
- 04-io-formats SEC-IOX-033 overlaps with SEC-SAU-307 (filename sanitization); consistent, no conflict found.
- No contradictions with 01/08 files on AllowDeny found; 01-configuration.md was not exhaustively checked for CSPAllow/TrustedProxies defaults.
