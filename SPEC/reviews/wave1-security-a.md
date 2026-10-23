# Review wave 1 - 05-security-auth.md, first half (sections 1-5 up to the 5.1 heading)

Scope covered: authentication plugin framework, config/http/signon/cookie auth, captcha, sessions, CSRF, 2FA core (TwoFactor.php, not the per-backend 5.1-5.3 subsections, which belong to the second half).

## Spot-checked claims (about 30), result
Confirmed: FR-SAU-001/002 (Plugins.php), INT-003, FR-004 (rule order logic), FR-007, FR-008, FR-009 (realm), SEC-011, FR-012, FR-015, FR-019, SEC-020, FR-021, FR-022, FR-023, SEC-025, FR-026, FR-027, FR-028, FR-029, SEC-031 (conditions), SEC-034, FR-035, FR-036, FR-037, FR-039, SEC-041, FR-042, FR-043, FR-044, FR-046, DATA-047, FR-048, FR-049, FR-051.

## Findings and fixes (corrected in review wave 1)
1. SEC-SAU-024: check is `strlen >= 2000`, not "longer than 2000"; message text added.
2. SEC-SAU-033: CookieSameSite accepted values (Lax/None, everything else -> Strict), path, cache limiter, use_cookies, cookie_httponly added.
3. FR-SAU-032: session cookie name is `__Secure-LegacyAdmin_https` on HTTPS (original `<prefix>LegacyAdmin` inexact).
4. SEC-SAU-040: token is bin2hex of 16 printable ASCII bytes = 32 hex chars; HMAC secret is 16 raw printable ASCII chars (original: "16 ASCII chars each").
5. FR-SAU-045: original claimed "no TESTSUITE bypass"; code has one. Added actual call order (authenticate -> connect -> rememberCredentials -> checkTwoFactor), i.e. credential cookies are issued before 2FA completes; AJAX login-page exit; base plugin check() true.
6. FR-SAU-050: cache lives for the session (not "request cycle"); failed result not cached.
7. FR-SAU-010: password variable chain was only "analogous"; now explicit (PHP_AUTH_PW, REMOTE_PASSWORD, AUTH_PASSWORD), colon>0 rule, sanitisation.
8. FR-SAU-014: HMAC secret/token restored only if signon token is non-empty.
9. FR-SAU-017: dangling reference to non-existent SEC-SAU-032 replaced by SEC-SAU-205; script branch precedence noted.

## New requirements (added in review wave 1)
FR-SAU-200 (idle timeout values and client keep-alive protocol), SEC-SAU-201 (cookie attributes, 30-day default), SEC-SAU-202 (exact failure/captcha messages), FR-SAU-203 (AllowDeny semantics, rule grammar, shortcuts, TrustedProxies, defaults), FR-SAU-204 (HTTP auth realm default/failure page), SEC-SAU-205 (SignonScript trust), SEC-SAU-206 (explicit absence of brute-force lockout; auth logging), SEC-SAU-207 (crypto parameters), SEC-SAU-208 (captcha null-deref defect). Placed in new subsection "5.0a" before 5.1.

## Unresolved / cross-file issues
- Section 5's range is split mid-section with the other agent; I stopped before the 5.1 heading. The other agent already retitled 5.1 ("TOTP", no HOTP) - consistent with code.
- ID range: other agent should not reuse 200-208 of the SAU prefix (my block). No duplicates found at time of review. File has IDs up to *-SAU-090.
- Citation drift (minor, not edited): FR-SAU-035 cites AuthenticationPlugin.php:223-243 (actual ~226-245); SEC-SAU-040 Session.php:225-249 fine.
- FR-SAU-006 says "all failed logins are logged": true only via parent::showFailure; connection failures where showFailure is not reached (e.g. captcha/password-length rejections, which return false from readCredentials) are NOT logged. Left as is; flagged here.
- SEC-SAU-041 vs FR-SAU-008/config auth: for config auth a token mismatch causes readCredentials false -> showLoginForm path; unchanged.
- 01-configuration.md SEC-CFG-061 and 08-deployment-docs.md FR-DEP-055 (says "AES/sodium", cites docs) are consistent in values but DEP-055 mentions AES; code uses only XSalsa20-Poly1305 (SEC-SAU-207). Suggest owner of 08 fix wording. 03-database-table.md HMAC statement (session HMAC secret + blowfish) not verified here (outside scope).
- Possible observation (not a requirement): http auth `old_usr` unencoded in URL (FR-SAU-204).
