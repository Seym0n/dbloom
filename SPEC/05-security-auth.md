# 05 — Security / Authentication subsystem

Derived from LegacyAdmin 5.2.3 source at
`legacy-release`. All `path:line`
citations are relative to that root. Scope inspected:

- `libraries/classes/Plugins/AuthenticationPlugin.php` and `Plugins/Auth/*`
  (config, cookie, http, signon plugins)
- `libraries/classes/Session.php` (CSRF token generation, session setup)
- `libraries/classes/Common.php` (front-controller auth flow, token validation)
- `libraries/classes/TwoFactor.php`, `Plugins/TwoFactor/*` (incl. WebAuthn),
  `Controllers/Preferences/TwoFactorController.php`
- `libraries/classes/WebAuthn/*` (PSR `Server` interface, `WebauthnLibServer`,
  `CustomServer`, `CBORDecoder`/`DataStream`, `WebAuthnException`)
- `libraries/classes/Crypto/Crypto.php`, `libraries/classes/Http/*`
- `libraries/classes/Config.php` (cookies), `Header.php` (headers), `Core.php`,
  `UrlRedirector.php`, `url.php`, `LogoutController.php`, `IpAllowDeny.php`,
  `UserPreferences.php` (2FA persistence), `Plugins::getAuthPlugin`

> Note: the task brief mentioned `Controllers\Security.php`; no such controller
> exists in this codebase. The two factor management controller is
> `libraries/classes/Controllers/Preferences/TwoFactorController.php`
> (see route registration `libraries/routes.php:141`). "Hotlink"-style
> accounting was not found; see Gaps.

## 1. Authentication plugin framework

- **FR-SAU-001** — The system shall support four configurable authentication
  plugin types per MySQL server: `config`, `cookie`, `http`, and `signon`,
  selected by `$cfg['Server']['auth_type']`, and shall instantiate the matching
  `LegacyAdmin\Plugins\Auth\Authentication<type>` class.
  Evidence: `libraries/classes/Plugins.php:598-616` (dynamic class name from
  lowercased `auth_type`, `$cfg['Server']['auth_type']` values documented in
  `libraries/classes/Config/Settings/Server.php`).
- **FR-SAU-002** — If a configured authentication type has no corresponding
  plugin class the system shall abort with a fatal error message
  ("Invalid authentication method set in configuration: …").
  Evidence: `libraries/classes/Plugins.php:605-610`.
- **INT-SAU-003** — Every authentication plugin shall implement the abstract
  contract: `showLoginForm()`, `readCredentials()`, `storeCredentials()`,
  `rememberCredentials()`, `showFailure()`, `logOut()`, and inherit the common
  `authenticate()` pipeline which calls `readCredentials` → (on failure,
  `Session::secure()` + `showLoginForm`) → `storeCredentials()` →
  `checkRules()` → clear user cache.
  Evidence: `libraries/classes/Plugins/AuthenticationPlugin.php:69-89`,
  `250-267`.
- **FR-SAU-004** — After authentication, the system shall enforce
  configuration-defined restrictions: `AllowDeny` ordering rules
  (`allow,deny` / `deny,allow` / `explicit`), `AllowRoot` disallowing the
  `root` user, and `AllowNoPassword` disallowing empty-password logins, with
  distinct failure codes (`allow-denied`, `root-denied`, `empty-denied`).
  Evidence: `libraries/classes/Plugins/AuthenticationPlugin.php:272-322`;
  IP matching in `libraries/classes/IpAllowDeny.php:217-260`.
- **FR-SAU-005** — The system shall produce user-friendly error messages for
  the failure codes, including the inactivity timeout message that quotes
  `$cfg['LoginCookieValidity']`, and shall escape any underlying DBI error
  text with `htmlspecialchars()`.
  Evidence: `libraries/classes/Plugins/AuthenticationPlugin.php:175-206`.
- **FR-SAU-006** — All failed-login attempts (username plus failure code) shall
  be recorded through the logging subsystem via `showFailure()`.
  Evidence: `libraries/classes/Plugins/AuthenticationPlugin.php:103-106`.

### 1.1 config auth plugin

- **FR-SAU-007** — For `auth_type='config'`, credentials shall be taken
  verbatim from `$cfg['Server']['user']` / `$cfg['Server']['password']` (formatting corrected in review wave 2: unclosed
  backtick); the
  plugin shall read no per-request credentials, and shall deny the connection
  (return false) when a POST token mismatch occurred
  (`$GLOBALS['token_provided'] && $GLOBALS['token_mismatch']`).
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationConfig.php:57-67`.
- **FR-SAU-008** — On connection failure with config auth the system shall
  display a minimal embedded page inviting the operator to check
  host/username/password in the configuration and offering "Retry to connect"
  plus a server selector when several servers are configured.
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationConfig.php:74-168`.

### 1.2 http auth plugin

- **FR-SAU-009** — For `auth_type='http'` the system shall issue an HTTP
  `401` response with `WWW-Authenticate: Basic realm="..."`, deriving the
  realm from `auth_http_realm` or the server host/verbose name, stripping all
  non-US-ASCII characters from the realm string.
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationHttp.php:57-76`.
- **FR-SAU-010** — HTTP-auth credentials shall be read from a documented
  fallback chain of environment variables (`PHP_AUTH_USER`, `REMOTE_USER`,
  `REDIRECT_REMOTE_USER`, `AUTH_USER`, `HTTP_AUTHORIZATION`, `Authorization`
  for user; analogous variables for password), with support for
  `Basic <base64>` decoding where a colon disambiguates user and password.
  (corrected in review wave 1: the password chain is, in order, `PHP_AUTH_PW`,
  `REMOTE_PASSWORD`, `AUTH_PASSWORD`; a null password is normalised to `''`;
  the decoded `Basic` split requires a colon at position > 0, otherwise user
  and password remain unchanged; the username is passed through
  `Core::sanitizeMySQLUser`. Evidence: `AuthenticationHttp.php:138-180`.)
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationHttp.php:109-177`.
- **SEC-SAU-011** — The system shall remove `PHP_AUTH_PW` from
  `$GLOBALS` and `$_SERVER` immediately after reading it so the password never
  appears in `phpinfo()` output.
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationHttp.php:159-160`.
- **FR-SAU-012** — After logout the HTTP plugin shall require a different
  username than the logged-out one: it compares the `old_usr` request
  parameter to the (re-)supplied username using timing-safe `hash_equals()`
  and clears the username on equality, and the login form URL shall carry
  `old_usr` to force this behavior.
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationHttp.php:182-189`,
  `215-218`.

### 1.3 signon auth plugin

- **FR-SAU-013** — For `auth_type='signon'` the system shall fetch user,
  password, host, port, extra config update, and a reusable CSRF token from a
  separately-named signon PHP session
  (`SignonSession` keys `PMA_single_signon_user`, `PMA_single_signon_password`,
  `PMA_single_signon_host`, `PMA_single_signon_port`,
  `PMA_single_signon_cfgupdate`, `PMA_single_signon_token`), by ending the
  current session, switching session name/ID/cookie params to the signon
  session, importing the values, and restarting the LegacyAdmin session.
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationSignon.php:122-259`.
- **FR-SAU-014** — The signon plugin shall preserve a per-session HMAC secret
  (`PMA_single_signon_HMAC_secret`), generating a new 16-byte random secret via
  `Util::generateRandom(16)` when absent, and restore it together with the
  carried-over CSRF token (corrected in review wave 1: both are restored into
  `$_SESSION[' PMA_token ']` / `[' HMAC_secret ']` only when the signon session
  supplied a non-empty `PMA_single_signon_token`; otherwise the LegacyAdmin
  session keeps its own token).
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationSignon.php:198-241`;
  secret generation `libraries/classes/Util.php:2455-2472`.
- **FR-SAU-015** — Signon session cookie parameters shall default to safe
  values when not configured (lifetime 0 = session cookie, path `/`, empty
  domain, `secure`/`httponly` false) and any `samesite` value outside
  `['Lax','Strict']` shall be dropped.
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationSignon.php:62-117`.
- **FR-SAU-016** — Signon shall remember which `SignonURL` was last used
  (`LAST_SIGNON_URL`) and refuse to reuse credentials from a different signon
  application until re-authorization; credentials missing from the signon
  session shall clear the marker and re-redirect to the signon URL.
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationSignon.php:124-128`,
  `250-258`.
- **FR-SAU-017** — When a `SignonScript` is configured, the system shall verify
  the script file exists and `include` it, expecting the script to define
  `get_login_credentials()`; a missing script produces a fatal error. (Legacy
  behavior; treated as a deliberate extensibility hook, see SEC-SAU-205.)
  (corrected in review wave 1: dangling reference to non-existent SEC-SAU-032
  replaced by SEC-SAU-205. The script branch takes precedence over the
  signon-session branch: when `SignonScript` is non-empty the session is not
  read at all. Evidence: `AuthenticationSignon.php:146-157`.)
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationSignon.php:146-156`.
- **FR-SAU-018** — Signon authentication failures shall be echoed back into
  the signon session as `PMA_single_signon_error_message` and the user shall
  be redirected to the signon application.
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationSignon.php:266-291`.

## 2. Cookie authentication

- **FR-SAU-019** — The cookie plugin shall store two encrypted, per-server
  cookies: `pmaUser-<server>` (username, lifetime one month) and
  `pmaAuth-<server>` (JSON payload `{password, server?}`, lifetime
  `$cfg['LoginCookieStore']` seconds, or session-length when 0/unset); the
  username cookie shall only offer recall/autocomplete when
  `LoginCookieRecall` is enabled and `blowfish_secret` is non-empty.
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationCookie.php:102-112`,
  `452-463`, `517-552`.
- **SEC-SAU-020** — Cookie payloads shall be encrypted and authenticated with
  XSalsa20-Poly1305 (`sodium_crypto_secretbox` / `..._open`) using a random
  nonce per record; a failed authentication/decryption (including
  `Throwable`) shall render the cookie invalid (decrypt → `null`) and thereby
  force re-authentication.
  Verification: flip one byte of `pmaAuth-1` and reload; the login form must
  appear.
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationCookie.php:625-653`,
  `334-347`, `386-398`.
- **FR-SAU-021** — The username-cookie encryption key shall be
  `$cfg['blowfish_secret']` when it is exactly 32 bytes (or truncated to the
  first 32 bytes if longer), otherwise the per-session generated key; the
  password-cookie key shall always be the per-session generated key so that
  password cookies cannot be reused across sessions.
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationCookie.php:588-623`.
- **FR-SAU-022** — The per-session encryption key shall be a random
  32-byte (`SODIUM_CRYPTO_SECRETBOX_KEYBYTES`) value stored in
  `$_SESSION['encryption_key']` and reused while the session lasts.
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationCookie.php:611-623`.
- **FR-SAU-023** — The password cookie payload shall be
  base64(nonce ‖ ciphertext) where the encrypted content is JSON
  `{"password": ...}` plus (when `AllowArbitraryServer` is on) the chosen
  `server` hostname; decryption, strict JSON decoding and presence of a
  `password` key are required before the credentials are trusted, and the
  `from_cookie` marker shall be set for cookie-sourced logins.
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationCookie.php:292-329`,
  `400-411`, `535-552`, `625-634`.
- **SEC-SAU-024** — POSTed login passwords of 2000 characters or more
  (`strlen($password) >= 2000`, i.e. the maximum accepted length is 1999
  bytes) shall be rejected with the message "Your password is too long. To
  prevent denial-of-service attacks, LegacyAdmin restricts passwords to less
  than 2000 characters." before any further processing (corrected in review
  wave 1: original text said "longer than 2000"; the check is `>=`).
  The limit applies to the cookie-form POST only, not to http/signon/config.
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationCookie.php:295-301`.
  Verification: POST a 1999-char and a 2000-char password; only the latter
  yields the "too long" message and no DBI connect attempt (verified in code:
  `AuthenticationCookie.php:296`).
- **SEC-SAU-025** — Usernames shall be sanitized by truncating at the first
  NUL byte (`Core::sanitizeMySQLUser`), and optional arbitrary server names
  by stripping repeated `p:` long-connect prefixes (`Core::sanitizeMySQLHost`);
  when `ArbitraryServerRegexp` is set the host (possibly stripped of a ` port`
  suffix) must match it or login is refused.
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationCookie.php:293`,
  `305-323`; `libraries/classes/Core.php:842-873`.
- **FR-SAU-026** — On any authentication failure the current password cookie
  for the selected server shall be deleted and a no-cache response
  (`Cache-Control: no-store, no-cache, must-revalidate`, `Pragma: no-cache`)
  shall be sent together with the login form.
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationCookie.php:565-583`.
- **FR-SAU-027** — On logout with cookie auth, all `pmaAuth-<server>`
  cookies shall be deleted (for every configured server when
  `LoginCookieDeleteAll` is true), each removal retried once if the cookie is
  still set; the shared behavior then clears credentials, destroys the
  LegacyAdmin session and redirects (or switches instead to a still-authenticated
  server and marks `partial_logout`).
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationCookie.php:668-691`;
  `libraries/classes/Plugins/AuthenticationPlugin.php:111-156`.
- **FR-SAU-028** — When `AllowArbitraryServer` is enabled the login form shall
  offer a server input, the submitted server name may contain
  `'host port'` syntax, and the effective server host/port shall override
  `$cfg['Server']` for the session.
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationCookie.php:150-201`
  (form params `is_arbitrary_server_allowed`, `default_server`), `421-447`,
  `505-510`.
- **FR-SAU-029** — Password changes through LegacyAdmin shall refresh the
  password cookie via the plugin callback `handlePasswordChange()` (invoked
  from `UserPassword`) and the password cookie shall not be rewritten on
  requests flagged `change_pw`.
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationCookie.php:452-463`,
  `655-663`; `libraries/classes/UserPassword.php:127`.
- **UI-SAU-030** — The cookie login form shall include: server selector when
  multiple servers exist, (optional) language selector, reCAPTCHA support
  (checkbox or invisible mode per `CaptchaMethod`), maintained $_form_params
  for `db`/`table`, and the current `session_id()` as a hidden
  `set_session` field; the form shall be rendered as a modal whenever the
  session expired mid-request.
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationCookie.php:115-201`
  and `89-100` for the modal/session-expiry parameters.

### 2.1 reCAPTCHA

- **SEC-SAU-031** — When all five captcha settings are configured
  (`CaptchaApi`, `CaptchaRequestParam`, `CaptchaResponseParam`,
  `CaptchaLoginPrivateKey`, `CaptchaLoginPublicKey`), every fresh (non-cookie)
  cookie login shall verify the submitted captcha response against the
  configured site using the ReCaptcha library over cURL (fallback: `fopen`
  POST, then socket POST), honoring an overridden `CaptchaSiteVerifyURL`, and
  reject the login with a distinct error when the response is missing,
  invalid, or the service reports failure.
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationCookie.php:187-196`,
  `238-290`; CSP carve-out `libraries/classes/Header.php:582-590`.

## 3. Session management

- **FR-SAU-032** — The system shall bootstrap PHP sessions itself
  (disabling/auto-aborting `session.auto_start` behavior), name the session
  cookie `LegacyAdmin` (over HTTPS the effective cookie name is
  `__Secure-LegacyAdmin_https`, via `Config::getCookieName`; corrected in review
  wave 1, original "`<prefix>LegacyAdmin`" was inexact), restore the requested session ID from that
  cookie, and validate that `session_start()` produced no new errors,
  deleting the cookie and aborting with a diagnostic fatal error otherwise.
  Evidence: `libraries/classes/Session.php:124-212`.
- **SEC-SAU-033** — Session cookies shall be `HttpOnly`, `SameSite` per
  `CookieSameSite` (default `Strict`; only `Lax`, `None` or `Strict` are
  possible, any other configured value falls back to `Strict`
  — `Config/Settings.php:2267-2274`), secure-flagged when HTTPS is detected
  (`Config::isHttps`: PmaAbsoluteUri scheme, HTTPS, X-Forwarded-Proto, etc.),
  lifetime 0 (browser session), path = `Config::getRootPath()`, empty domain;
  `session.use_cookies=true`, `session.use_only_cookies=1`,
  `session.use_strict_mode=1`, `session.cookie_httponly=1`,
  `use_trans_sid=0` and `session_cache_limiter('private')` shall be enforced;
  an optional `SessionSavePath` shall be applied with `session.save_handler=files`
  (corrected in review wave 1: added accepted values, path, cache limiter).
  Evidence: `libraries/classes/Session.php:142-186`.
  Verification: inspect `Set-Cookie` on login over HTTPS: `HttpOnly`, `Secure`,
  `SameSite=Strict`, name `__Secure-LegacyAdmin_https`.
- **SEC-SAU-034** — The system shall mitigate session fixation by calling
  `Session::secure()` (regenerating the session ID with
  `session_regenerate_id(true)`, clearing session data and regenerating the
  CSRF token) before showing a login form and upon every fresh credential
  submission.
  Evidence: `libraries/classes/Session.php:64-74`;
  `libraries/classes/Plugins/AuthenticationPlugin.php:254-259`;
  `libraries/classes/Plugins/Auth/AuthenticationCookie.php:325-326`.
  Verification: capture the `LegacyAdmin` cookie before and after a successful
  login; the session ID must differ and a request with the old ID must be
  unauthenticated.
- **FR-SAU-035** — Per-request activity times shall be tracked
  per-window (row of the page) in `$_SESSION['browser_access_time']` keyed by
  the request GUID (`access_time` clamped to the `[0, LoginCookieValidity+1]`
  range to prevent validity-extension attacks).
  Evidence: `libraries/classes/Plugins/AuthenticationPlugin.php:223-243`.
- **FR-SAU-036** — A user whose last recorded access time is older than
  `LoginCookieValidity` on all windows shall be treated as inactive: stale
  entries purged, privilege/session cache keys removed (`is_create_db_priv`,
  `is_reload_priv`, `db_to_create`, `dbs_where_create_table_allowed`,
  `dbs_to_test`, `db_priv`, `col_priv`, `table_priv`, `proc_priv`) and the
  user logged out with failure code `no-activity`.
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationCookie.php:351-383`.
- **FR-SAU-037** — The effective `LoginCookieValidity` may be overridden from
  the per-user preferences cache and applied to the active cfg before
  authentication.
  Evidence: `libraries/classes/Config.php:1358-1378`.
- **INT-SAU-038** — Requests for utility entry points (`url.php`) shall run a
  reduced front-controller (`$isMinimumCommon`) that skips the full
  connect/authenticate pipeline but still boots configuration, sessions and
  user preferences.
  Evidence: `url.php:36-40`; `libraries/classes/Common.php:201-207`.
- **FR-SAU-039** — Logout shall be a POST-only action gated by the CSRF token;
  GET or token-mismatched logout attempts shall be ignored (redirect back to
  the default route) instead of logging out.
  Evidence: `libraries/classes/Controllers/LogoutController.php:11-22`.

## 4. CSRF token

- **SEC-SAU-040** — The system shall maintain a per-session CSRF token
  `$_SESSION[' PMA_token ']` (space-padded key name to avoid collision) and an
  accompanying `$_SESSION[' HMAC_secret ']`. Corrected in review wave 1: the
  token is `bin2hex` of 16 random printable ASCII bytes (0x21-0x7e), i.e. a
  32-character hex string (`Util::generateRandom(16, true)`); the HMAC secret
  is 16 raw printable ASCII characters (`generateRandom(16)`). Both are
  regenerated on
  `Session::secure()`; failure to generate the token is a fatal error.
  Evidence: `libraries/classes/Session.php:43-57`, `225-249`;
  `libraries/classes/Util.php:2455-2472`.
  Verification: the token embedded in any form is 32 hex chars and changes
  after logout/login; two sessions never share a token.
- **SEC-SAU-041** — CSRF validation shall apply to POST requests only: the
  POSTed `token` shall be compared with the session token using
  `hash_equals()`; on mismatch (or missing token), every request variable
  except the `ajax_request` allowance shall be removed
  (`Sanitize::removeRequestVars($allowList)`), and ajax POSTs with a token
  mismatch shall be aborted early with an "Error: Token mismatch" message.
  Evidence: `libraries/classes/Common.php:236-243`, `468-512`, `269-282`.
  (added in review wave 2) Scope limit, verified at `Common.php:477-479`: for
  any non-POST method `checkTokenRequestParam` returns immediately with
  `$token_mismatch = true` and NO request variables are removed, so GET
  requests are never token-checked (see SEC-SAU-324).
  Verification: POST a state-changing request with a wrong token and confirm
  the action is not executed and only `ajax_request` survives in `$_REQUEST`.
- **FR-SAU-042** — When a login happens after session expiry the system shall
  explicitly return the new CSRF token (`new_token` JSON) for the login modal
  and after a successful re-login, so forms can update hidden token fields;
  the response JSON flags `session_timedout` (`logged_in`) accordingly.
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationCookie.php:70-100`,
  `470-487`.
- **FR-SAU-043** — Standard-generated internal links shall automatically
  include the current CSRF token via `Url::getCommon()` unless suppressed
  (`is_token=false`).
  Evidence: `libraries/classes/Url.php:126-134`.
- **FR-SAU-044** — A failed session-cookie setup (`set_session` mismatch)
  shall surface a specific user-facing warning about HTTP access to LegacyAdmin.
  Evidence: `libraries/classes/Common.php:496-504`.

## 5. Two-factor authentication (2FA)

- **FR-SAU-045** — After primary authentication (per server connection) the
  system shall run the two-factor gate for the authenticated user
  (`$auth_plugin->checkTwoFactor()`); while pending it shall render the
  `login/twofactor` template (with header/footer/notification
  "You have enabled two factor authentication, please confirm your login.")
  and stop; the flow exits (`exit` unless the `TESTSUITE` constant is defined)
  until `TwoFactor::check()` succeeds. Corrected in review wave 1: the original
  said "no TESTSUITE bypass", but `checkTwoFactor()` returns/skips `exit` under
  `TESTSUITE`; for AJAX "login pages" (`$response->loginPage()`) it exits
  silently without rendering. Order in `Common::run`: `authenticate()` →
  `connectToDatabaseServer()` → `rememberCredentials()` → `checkTwoFactor()`
  → `Logging::logUser` (so the username/password cookies are already issued
  before the second factor is confirmed). Users without a configured backend
  use the base `TwoFactorPlugin`, whose `check()` returns true.
  Evidence: `libraries/classes/Common.php:222-246`;
  `libraries/classes/Plugins/AuthenticationPlugin.php:328-359`.
  Verification: with a TOTP user, after the password step only the
  `login/twofactor` template is rendered until a valid `2fa_code` is posted.
- **FR-SAU-046** — Two-factor configuration shall be read from the user
  preferences store (`config_data['2fa']`) with shape
  `{backend: string, settings: array}`, and the availability of persistence
  ('db' vs 'session') determines writability of 2FA settings.
  Evidence: `libraries/classes/TwoFactor.php:78-102`.
- **DATA-SAU-047** — 2FA configuration shall be persisted per username in the
  LegacyAdmin configuration storage table (`userConfig`, e.g. `la_userconfig`)
  as JSON `config_data` with a `timevalue` timestamp keyed by `username`;
  when relation parameters (pmadb) are missing, storage silently falls back to
  the PHP session (`$_SESSION['userconfig']`).
  Evidence: `libraries/classes/UserPreferences.php:76-117` (load),
  `126-200` (save), `254-268` (`persistOption('2fa', …)`);
  `libraries/classes/TwoFactor.php:261-264`.
- **FR-SAU-048** — Available 2FA backends shall be feature-detected:
  `application` (TOTP only, corrected in review wave 3; no HOTP) only when `pragmarx/google2fa-qrcode`,
  `bacon/bacon-qr-code` and (`XMLWriter` or `imagick`) exist; `WebAuthn`
  always available; legacy `key` (FIDO U2F) when `code-lts/u2f-php-server`
  exists; `simple` only under `DBG.simple2fa`.
  Evidence: `libraries/classes/TwoFactor.php:129-183`.
- **FR-SAU-049** — A configured but unavailable backend shall degrade to the
  `Invalid` pseudo-backend whose `check()` always fails, blocking login rather
  than weakening it.
  Evidence: `libraries/classes/TwoFactor.php:193-216`;
  `libraries/classes/Plugins/TwoFactor/Invalid.php:15-39`.
  Verification: set `2fa.backend` to an unavailable backend (e.g. `key`
  without the U2F library); login must stay blocked on the 2FA page.
- **FR-SAU-050** — Once a backend check succeeds the result shall be cached
  for the remainder of the session in `$_SESSION['two_factor_check']` (a failed
  result is falsy and is re-evaluated on the next call; the cache is discarded
  by `Session::secure()`) (corrected in review wave 1: original said "in a
  request cycle"); the check may be
  forced (`skipSession`, used when re-verifying before deactivation).
  Evidence: `libraries/classes/TwoFactor.php:223-234`;
  `libraries/classes/Controllers/Preferences/TwoFactorController.php:43-52`.
- **FR-SAU-051** — Enrolment (`configure(name)`) shall validate the chosen
  backend against the available list, run the backend's `configure()` (which
  may require a successful live second-factor check) and persist via
  `TwoFactor::save()`; choosing `''` disables 2FA. Removal through the
  preferences page requires passing the current second factor first
  (`2fa_remove` + `check(true)` → confirm screen).
  Evidence: `libraries/classes/TwoFactor.php:274-298`;
  `libraries/classes/Controllers/Preferences/TwoFactorController.php:41-65`.
- **FR-SAU-052** — Enrolment/change flows that persist settings shall first
  render a `preferences/two_factor/configure` setup screen; saving errors
  (returning `Message`) shall be echoed to the user.
  Evidence: `libraries/classes/Controllers/Preferences/TwoFactorController.php:54-65`;
  `libraries/classes/TwoFactor.php:292-298`.
- **UI-SAU-053** — The 2FA confirmation screen shall show backend errors
  followed by the backend render, with a submit button only when the backend
  declares `$showSubmit`; the `Invalid` and some hardware flows hide it.
  Evidence: `libraries/classes/TwoFactor.php:115-122`, `241-254`;
  `libraries/classes/Plugins/TwoFactor/Invalid.php:20-22`.

### 5.0a Review wave 1 additions (sections 1-5)

- **FR-SAU-200** — (added in review wave 1) Inactivity handling: `LoginCookieValidity` defaults to 1440 s
  (values < 1 revert to 1440), `LoginCookieStore` defaults to 0 (session
  cookie; values < 1 -> 0), `LoginCookieRecall` defaults to true. The browser
  client posts `check_timeout=1` with `guid` and `access_time` (idle seconds)
  first after `min(LoginCookieValidity, session_gc_maxlifetime) - 5` seconds and then
  every `remaining - 1` s (max 2^31-1 ms); an expired session yields a
  `success=false` JSON with the login modal HTML and a `new_token`; a normal
  page request with `session_expired=1` shows "Your session has expired.
  Please log in again.".
  Evidence: `Config/Settings.php:2279-2320`; `js/src/functions.js:935-1010`;
  `Plugins/Auth/AuthenticationCookie.php:75-100,131-135`.
- **SEC-SAU-201** — (added in review wave 1) Cookie attributes: all
  LegacyAdmin-set cookies (`pmaUser-<n>`, `pmaAuth-<n>`, `pma_lang`, theme)
  shall be named `__Secure-<name>_https` on HTTPS and `<name>` otherwise, be
  `HttpOnly` by default, carry `Secure` iff HTTPS, `SameSite` = `CookieSameSite`
  (Strict default), `path` = root path, empty domain; default validity is
  2592000 s (30 days) unless a validity is passed (`0` = session cookie);
  setting an empty value removes an existing cookie. `pmaUser-<n>` uses
  the 30-day default, `pmaAuth-<n>` uses `LoginCookieStore`.
  Evidence: `Config.php:912-1010`; `AuthenticationCookie.php:517-552`.
- **SEC-SAU-202** — (added in review wave 1) Failure-code messages
  (`getErrorMessage`): `empty-denied` -> "Login without a password is
  forbidden by configuration (see AllowNoPassword)"; `root-denied` and
  `allow-denied` -> "Access denied!" (identical, deliberately not revealing
  the rule); `no-activity` -> "You have been automatically logged out due to
  inactivity of %s seconds. Once you log in again, ..." with
  `intval(LoginCookieValidity)`; otherwise the escaped DBI error, else
  "#<errno> Cannot log in to the MySQL server", else "Cannot log in to the
  MySQL server". Captcha errors: "Missing reCAPTCHA verification, maybe it
  has been blocked by adblock?", "Failed to connect to the reCAPTCHA
  service!" (when `invalid-json`), "Entered captcha is wrong, try again!";
  disallowed arbitrary server: "You are not allowed to log in to this MySQL
  server!". Evidence: `AuthenticationPlugin.php:175-206`;
  `AuthenticationCookie.php:247-286,316`.
- **FR-SAU-203** — (added in review wave 1) AllowDeny semantics: `order` is
  one of `allow,deny`, `deny,allow`, `explicit`; any other value (default
  `''`) means no IP check is performed. `allow,deny`: default forbidden, an
  allow match permits, a deny match then forbids. `deny,allow`: default
  permitted, a deny match forbids, an allow match then permits. `explicit`:
  permitted only if an allow rule matches and no deny rule matches. A rule is
  the string `<allow|deny> <user|%> [from] <ip-spec>`; the username compares
  with `hash_equals`; ip-spec may be an address, CIDR or mask form (IPv4 and
  IPv6), or shortcuts `all`=0.0.0.0/0, `localhost`=127.0.0.1/8,
  `localnetA/B/C` (= SERVER_ADDR/8, /16, /24). Client IP is `REMOTE_ADDR`
  unless it is a key of `TrustedProxies`, in which case the first element
  of the named header must pass `FILTER_VALIDATE_IP`; if no IP can be
  determined, no rule matches (so `allow,deny` forbids). Defaults:
  `AllowRoot=true`, `AllowNoPassword=false`. A rejected check calls
  `showFailure(code)`, which for cookie auth re-displays the login form.
  Evidence: `AuthenticationPlugin.php:272-322`; `IpAllowDeny.php:217-310`;
  `Core.php:806-840`; `Config/Settings/Server.php:1263-1310`.
- **FR-SAU-204** — (added in review wave 1) HTTP auth defaults: realm is
  `auth_http_realm` or `"LegacyAdmin " . (verbose or host)`; characters outside
  0x20-0x7e are removed; the failure page has title "Access denied!" and the
  error "Wrong username/password. Access denied."; if a DBI error exists and
  its errno != 1045 it is shown as a fatal error instead of re-challenging.
  Evidence: `AuthenticationHttp.php:57-104,197-208`. Observation:
  `getLoginFormURL()` appends `$this->user` unencoded to `old_usr`
  (`AuthenticationHttp.php:217`).
- **SEC-SAU-205** — (added in review wave 1) `SignonScript` is executed with
  `include` and `get_login_credentials($user)` must return `[user, password]`;
  only `file_exists` is verified, so the script path is trusted configuration
  and shall never be user-controllable. Signon `showLoginForm()` clears
  `LAST_SIGNON_URL` and redirects to `SignonURL`, or aborts with
  "You must set SignonURL!" when empty. Evidence:
  `AuthenticationSignon.php:36-55,146-156`.
- **SEC-SAU-206** — (added in review wave 1) No brute-force protection: the
  codebase contains no failed-login counter, lockout, delay or rate limit;
  the only login-abuse countermeasures are the optional reCAPTCHA (SEC-SAU-031),
  the 2000-character password cap (SEC-SAU-024), IP AllowDeny (FR-SAU-203)
  and failed-login logging (FR-SAU-006). `Logging::logUser` sets Apache notes
  (`userID`, `userStatus`) and logs to syslog (`LOG_AUTHPRIV`/`LOG_WARNING`),
  PHP error_log, or a file per `AuthLog`; successes are only logged if
  `AuthLogSuccess` is true. Evidence: `Logging.php:75-100`; a search of
  `libraries/classes` for lockout/throttle logic found nothing. A
  "N failed attempts -> lockout" requirement is out of scope of the product.
- **SEC-SAU-207** — (added in review wave 1) Cookie-auth crypto parameters:
  cipher XSalsa20-Poly1305 (`sodium_crypto_secretbox`), key 32 bytes
  (`SODIUM_CRYPTO_SECRETBOX_KEYBYTES`), nonce 24 random bytes per record
  (`random_bytes`), cookie value = base64(nonce ‖ ciphertext). A
  `blowfish_secret` shorter than 32 bytes is silently not used (session key
  instead; the remembered username then cannot be decrypted in a new
  session); the name "blowfish" is historical. An encryption failure yields
  an empty string (which removes/omits the cookie). Evidence:
  `AuthenticationCookie.php:588-653`; `Config.php:929-932`.
- **SEC-SAU-208** — (added in review wave 1) Known defect: in the captcha
  branch `$resp == null || ! $resp->isSuccess()` is followed by
  `$resp->getErrorCodes()`; a null response would raise an error instead of
  the "Entered captcha is wrong" message. Recorded as observed 5.2.3
  behaviour, not as a requirement to preserve.
  Evidence: `AuthenticationCookie.php:279-282`.

### 5.1 TOTP (`application` backend) (heading corrected in review wave 1: only time-based OTP via `Google2FA::verifyKey` is implemented; no HOTP/counter mode exists)

- **FR-SAU-054** — OTP enrollment shall generate a secret once and keep it in
  `$_SESSION['2fa_application_key']` until a live code verifies
  (`verifyKey(secret, 2fa_code)`); on success the secret is committed to the
  2FA config, the session copy is cleared, and the setup screen shall render
  an inline QR code (`getQRCodeInline` for app id "LegacyAdmin (host)") with
  imagick fallback handling.
  Evidence: `libraries/classes/Plugins/TwoFactor/Application.php:38-126`
  (`configure` 112-126, `setup` 89-103, `check` 62-72,
  `setWindow(8)` tolerance 42).
  (corrected in review wave 1) The verification window is `setWindow(8)`,
  i.e. the code is accepted if it matches any time step within +-8 steps of
  the current one (about +-4 minutes with the library's default 30 s step; the
  library is not vendored in this tree so the step length is not verifiable
  here). The submitted code is read from `$_POST['2fa_code']`; if absent the
  check fails with `provided=false` (no error shown). The secret is generated
  by `Google2FA::generateSecretKey()` (library default length). During
  enrolment the secret is also echoed as text next to the QR code
  (`application_configure` template param `secret`).

### 5.2 Legacy FIDO U2F (`key` backend, vendor interface usage)

- **FR-SAU-055** — U2F register/authenticate requests shall be built by
  `U2FServer::makeRegistration/makeAuthentication` and stored in the session
  (`registrationRequest` / `authenticationRequest`); submitted JSON responses
  shall be validated with `U2FServer::register/authenticate`; successful
  authentication updates the stored registration counter and persists it.
  (added in review wave 1) U2F failures (`U2FException`) surface their raw
  message; non-object JSON responses fail silently. Unlike WebAuthn,
  `$_SESSION['authenticationRequest']` / `['registrationRequest']` are NOT
  unset after use (`Key.php:79-140`, `157`), so the request is reusable
  within the session (see SEC-SAU-306).
  Evidence: `libraries/classes/Plugins/TwoFactor/Key.php:79-199`;
  backend availability gating `libraries/classes/TwoFactor.php:146-148`.
- **UI-SAU-056** — U2F screens shall load `u2f-api-polyfill.js` + `u2f.js`
  and indicate HTTPS availability (U2F requires HTTPS).
  Evidence: `libraries/classes/Plugins/TwoFactor/Key.php:110-138` (`is_https`
  template param).

### 5.3 WebAuthn (2nd-generation provider)

- **INT-SAU-057** — WebAuthn operations shall be performed behind the
  `LegacyAdmin\WebAuthn\Server` interface (`getCredentialCreationOptions`,
  `getCredentialRequestOptions`, `parseAndValidateAssertionResponse`,
  `parseAndValidateAttestationResponse`); the implementation shall be chosen
  as the vendor `Webauthn\Server`-based `WebauthnLibServer` when the library
  is installed and the bundled `CustomServer` otherwise, and the plugin shall
  provide an injection point `setServer()` for tests.
  Evidence: `libraries/classes/WebAuthn/Server.php:16-78`;
  `libraries/classes/Plugins/TwoFactor/WebAuthn.php:62-70`.
- **FR-SAU-058** — WebAuthn authenticator selection shall request
  `cross-platform` authenticators with `userVerification: 'discouraged'`,
  attestation `none`, 60-second timeout, and a 32-byte random challenge
  (base64, url-safe no-padding migration for vendor interop).
  Evidence: `libraries/classes/WebAuthn/CustomServer.php:38-74`, `188-205`;
  `libraries/classes/WebAuthn/WebauthnLibServer.php:46-53`, `91-94`, `186-190`.
- **FR-SAU-059** — (corrected in review wave 3: this entry and its Evidence
  describe the bundled `CustomServer` variant ONLY; the library variant is in
  FR-SAU-210, the selection rule in INT-SAU-057/FR-SAU-210; see CF-004)
  `CustomServer` assertion responses shall be validated against: type
  `webauthn.get`, challenge equality (timing-safe `hash_equals` after
  base64 decoding), client-data `origin` host equal to the request host,
  `rpIdHash` = SHA-256 of the RP ID (= request host), and the user-present
  flag.
  Evidence: `libraries/classes/WebAuthn/CustomServer.php:76-110`.
  (corrected in review wave 1) Additional observed behaviour of the bundled
  `CustomServer`: (a) when the allowed-credential list is non-empty the
  assertion `rawId` must be in it (`isCredentialIdAllowed`); (b) the origin
  check compares only the URI *host* (scheme/port are not compared) against
  the host derived from the request's `Host` header (`HTTP_HOST`, see
  INT-SAU-081), which is client-supplied; (c) no assertion signature
  verification and no sign-count comparison is performed in this class
  (lines 76-110 contain none), i.e. possession proof relies on the
  challenge/credential-id/rpIdHash/UP-flag checks only. Whether the vendor
  `WebauthnLibServer` path verifies signatures is delegated to the library
  (not in this tree). A failed `Assert::*` raises an exception whose message
  is shown to the user (see FR-SAU-064).
  Verification: unit-test `CustomServer::parseAndValidateAssertionResponse`
  with a wrong challenge, wrong rpIdHash, cleared UP flag and a credential id
  outside the allow-list (each must throw); a tampered signature is NOT
  rejected by this class (known gap).
  (corrected in review wave 3) Statements (b) and (c) above are properties of
  `CustomServer` only and must not be read as properties of WebAuthn in
  general; with `web-auth/webauthn-lib` installed the checks are delegated to
  `loadAndCheckAssertionResponse` (FR-SAU-210).
- **FR-SAU-060** — Attestation (registration) responses shall additionally be
  validated for type `webauthn.create`, `fmt === 'none'` with empty
  `attStmt`, presence of attested credential data, and the counter/AAGUID/
  credentialId/credentialPublicKey shall be extracted and stored base64-encoded
  under the user's 2FA settings; the `userHandle` becomes the stored user ID.
  Evidence: `libraries/classes/WebAuthn/CustomServer.php:112-186`;
  `libraries/classes/Plugins/TwoFactor/WebAuthn.php:225-238`.
- **FR-SAU-061** — Each WebAuthn challenge/options blob shall be single-use:
  generated options are stored in
  `$_SESSION['WebAuthnCredential{Request,Creation}Options']` and removed when
  the response is processed; a missing session blob invalidates the attempt.
  Evidence: `libraries/classes/Plugins/TwoFactor/WebAuthn.php:83-105`, `136-158`.
- **FR-SAU-062** — Allowed-credential enumeration shall derive from the stored
  credentials (skipping malformed entries) and, with the vendor library, a
  `PublicKeyCredentialSourceRepository` adapter shall read/write those stored
  credentials (injecting `EmptyTrustPath` when `trustPath` is absent).
  Evidence: `libraries/classes/Plugins/TwoFactor/WebAuthn.php:198-218`;
  `libraries/classes/WebAuthn/WebauthnLibServer.php:203-277`.
- **FR-SAU-063** — WebAuthn login and enrolment screens shall load
  `webauthn.js` and embed the encoded request/creation options JSON; enrolment
  generates a fresh 32-byte user handle per new credential set
  (`random_bytes(32)` base64-encoded) unless one is stored.
  (corrected in review wave 1) `setup()` generates a new random 32-byte user
  id on every call (no "unless stored" branch there); the stored
  `settings.userHandle` is only used by `render()` (login) and is overwritten
  by `saveCredential()` with the handle from the last successful
  registration. Credentials are keyed by standard-base64 credential id in
  `settings.credentials`.
  Evidence: `libraries/classes/Plugins/TwoFactor/WebAuthn.php:72-143`,
  `240-245`; enrolment user id `132` (`random_bytes(32)`).
- **FR-SAU-064** — Every WebAuthn failure (decode, assert, vendor exception)
  shall be surfaced as the plugin's error message
  ("Two-factor authentication failed: %s") - (corrected in review wave 1) the
  `%s` is the raw `Throwable::getMessage()` (e.g. webmozart `Assert` messages
  such as "Expected a value identical to ..."), so internal validation detail
  IS disclosed to the user; stack traces are not. When the backend was not
  `provided` (no response submitted) no message is shown; when `provided` but
  message empty the generic "Two-factor authentication failed." is shown.
  Evidence: `libraries/classes/Plugins/TwoFactor/WebAuthn.php:107-127`, `160-176`;
  `libraries/classes/Plugins/TwoFactorPlugin.php:63-83`;
  dedicated `WebAuthnException` `libraries/classes/WebAuthn/WebAuthnException.php:9-11`.
- **FR-SAU-065** — The relying-party identifier for WebAuthn shall be the
  request host (`$request->getUri()->getHost()`), and the RP display name
  shall be `"LegacyAdmin (<host>)"` — also used as OTP app id.
  Evidence: `libraries/classes/WebAuthn/WebauthnLibServer.php:43`, `135`, `165`;
  app id fallback logic `libraries/classes/Plugins/TwoFactorPlugin.php:150-182`
  (uses `PmaAbsoluteUri` parse or `HTTP_HOST`).

## 6. Crypto (URL query encryption)

- **FR-SAU-066** — A dedicated crypto service shall encrypt/decrypt URL query
  strings with `sodium_crypto_secretbox` using a key resolved as
  `$config['URLQueryEncryptionSecretKey']` (must be exactly 32 bytes), falling
  back to a per-session generated key persisted in
  `$_SESSION['URLQueryEncryptionSecretKey']`.
  Evidence: `libraries/classes/Crypto/Crypto.php:19-67`.
  (corrected in review wave 1) Precise behaviour: key = 32 raw bytes
  (`SODIUM_CRYPTO_SECRETBOX_KEYBYTES`, length measured in 8-bit); a configured
  or session key of any other length is ignored and a fresh
  `random_bytes(32)` key is generated and stored in the session. Output =
  24-byte random nonce (`random_bytes`) || secretbox ciphertext (16-byte MAC).
  The feature is OFF by default (`$cfg['URLQueryEncryption'] = false`,
  `libraries/config.default.php:853`) and only active when enabled
  (`Url.php:256`); see SEC-SAU-300.
- **SEC-SAU-067** — Decryption failures of encrypted query parameters shall
  yield `null` (and the caller must treat that as invalid input), never throw.
  Evidence: `libraries/classes/Crypto/Crypto.php:50-66`.

## 7. Request handling hardening (LFI / open-redirect / path)

- **SEC-SAU-068** — The system shall stop direct execution of support PHP
  files via per-file guards (`if (! defined('LEGACYADMIN')) { exit... }` in
  `libraries/vendor_config.php`, `libraries/routes.php`,
  `libraries/constants.php`, `libraries/config.values.php`, setup include);
  entry points (`url.php`, `index.php`) define `ROOT_PATH` and `LEGACYADMIN`
  themselves before loading shared libraries.
  Evidence: `libraries/vendor_config.php:12-14`, `libraries/routes.php:40-42`,
  `libraries/constants.php:5-7`, `libraries/config.values.php:9-11`,
  `setup/lib/common.inc.php:13-15`; entry `url.php:8-22`.
- **SEC-SAU-069** — `PATH_INFO` shall be stripped from `PHP_SELF`
  (`Common::cleanupPathInfo()` resolves and re-normalizes the path, removing
  `..` segments and HTML-encoding the result) to prevent path-inflection
  attacks against the front-controller.
  Evidence: `libraries/classes/Common.php:381-430`.
- **SEC-SAU-070** — Page/`goto`/`back` parameters shall be validated by
  `Core::checkPageValidity()` against an allow-list (default `['index.php']`),
  matching the raw value, the pre-`?` substring, or the urldecoded form; the
  `$include` mode forbids query strings and non-exact matches, and invalid
  values are unset (and `goto`/`back` cookies removed).
  Evidence: `libraries/classes/Core.php:282-317`;
  `libraries/classes/Common.php:432-466`.
  Verification: request `?goto=../../etc/passwd` and `?goto=http://evil/` on a
  POST with valid token; the parameter must be unset.
- **SEC-SAU-071** — Outbound redirects from the dedicated `url.php` endpoint
  shall only accept URLs that are: `https://`-prefixed (regex
  `/^https:\/\/[^\n\r]*$/`), on an allow-listed domain
  (`Core::isAllowedDomain()`: blocks user/pass/port components; allow-list of
  LegacyAdmin/mysql.com/mariadb.org/php.net/github.com/percona/www.cve.org
  domains plus current `SERVER_NAME`); otherwise redirect to `./`.
  (corrected in review wave 1) The allow-list is an exact-match (no
  wildcard/subdomain) list of hosts: current `$_SERVER['SERVER_NAME']`,
  `wiki.legacyadmin.net`, `www.legacyadmin.net`, `legacyadmin.net`,
  `demo.legacyadmin.net`, `docs.legacyadmin.net`, `dev.mysql.com`,
  `bugs.mysql.com`, `mariadb.org`, `mariadb.com`, `php.net`, `www.php.net`,
  `github.com`, `www.github.com`, `www.percona.com`, `www.cve.org`,
  `mysqldatabaseadministration.blogspot.com`. A URL without host, or with
  non-empty `user`, `pass` or `port`, is rejected. Rejected/missing/non-scalar
  `url` => `Location: ./` and exit. The HTTP headers of the normal header layer
  (CSP etc.) are sent first. Note: the regex has no `D` modifier, so `$` also
  matches before one final `\n`; a URL with a single trailing newline would
  therefore pass the regex (it is still JS-escaped by `escapeJsString`, which
  maps `\n` to `\\n`, and no `Location:` header is built from it).
  Evidence: `url.php:40-42`, `libraries/classes/UrlRedirector.php:33-58`;
  `libraries/classes/Core.php:659-715`.
  (re-verified in review wave 2: the 17-entry host list, including
  `SERVER_NAME`, matches `Core.php:659-715`.)
  Verification: `url.php?url=https://evil.example/`, `http://php.net/`,
  `https://php.net:8080/` and `https://user@php.net/` all yield `Location: ./`;
  `https://php.net/` renders the JS redirect page.
- **FR-SAU-072** — External link generation shall route through `url.php`
  (`Core::linkURL()`; "getLinkTarget" does not exist - corrected in review
  wave 1) so tokens in the Referer header are not leaked
  to third-party sites; the redirect is performed with JavaScript precisely so
  the browser changes Referer, and the target URL is JS-escaped while not echoed.
  `linkURL()` only rewrites URLs matching `^https?://` (others are returned
  unchanged) and strips every query parameter except `url` (so `token`, `server`,
  etc. are dropped); the result is `./url.php?url=<urlencoded>` (or
  `../url.php?...` on setup pages). `Sanitize::checkLink()` additionally
  restricts BBCode `[a@...]` links to prefixes `https://`,
  `./url.php?url=https%3a%2f%2f`, `./doc/html/`, `./index.php?` (plus `http://`,
  `mailto:`, `ftp://` only when the caller opts in; setup adds `?page=form&`,
  `?page=servers&`) - see SEC-SAU-301.
  Evidence: `libraries/classes/UrlRedirector.php:12-58` (comments + template);
  `libraries/classes/Core.php:640-651`.
- **FR-SAU-073** — Uploaded SQL file execution (`import_type=queryfile`) shall
  go exclusively through `sql_file` (normally a PHP-uploaded file reference)
  which is reset (`unset`) after being copied into `$import_file`, and the
  `format` parameter shall be restricted to a hard allow-list
  (`['csv','ldi','mediawiki','ods','shp','sql','xml']`) with fatal error
  "Incorrect format parameter" otherwise.
  Evidence: `libraries/classes/Controllers/Import/ImportController.php:200-210`,
  `244-248`.
- **FR-SAU-074** — The system shall display an assumed-upload-limit message
  when a request arrives without any parameters, treating it as an exceeded
  upload limit, and record import messages in
  `$_SESSION['Import_message']`.
  Evidence: `libraries/classes/Controllers/Import/ImportController.php:212-232`.
- **SEC-SAU-075** — The local-infile import (`ldi`) plugin support shall be
  gated per-request: `PMA_ENABLE_LDI` is defined only for route `/import`
  with POST `format=ldi`, restricting `LOAD DATA LOCAL INFILE` enablement to
  the import path.
  Evidence: `libraries/classes/Common.php:228-234`.

## 8. Security headers

- **SEC-SAU-076** — Unless third-party framing is explicitly configured, the
  system shall send anti-clickjacking headers: `X-Frame-Options: DENY` by
  default, `SAMEORIGIN` when `AllowThirdPartyFraming === 'sameorigin'`, and
  none when it is `true` (explicit opt-out).
  Evidence: `libraries/classes/Header.php:486-495`.
- **SEC-SAU-077** — The system shall send `Referrer-Policy: same-origin`,
  `X-XSS-Protection: 1; mode=block`, `X-Content-Type-Options: nosniff`,
  `X-Permitted-Cross-Domain-Policies: none`, `X-Robots-Tag: noindex,
  nofollow`, and no-store cache headers on HTML responses.
  (corrected in review wave 1) Exact values: `Referrer-Policy: same-origin`;
  `X-Robots-Tag: noindex, nofollow`; `Content-Type: text/html; charset=utf-8`
  (omitted when `IS_TRANSFORMATION_WRAPPER` is defined); cache headers from
  `Core::getNoCacheHeaders()`: `Expires` and `Last-Modified` = current GMT
  RFC1123 date, `Cache-Control: no-store, no-cache, must-revalidate,
  pre-check=0, post-check=0, max-age=0`, `Pragma: no-cache`
  (`Core.php:442-462`). No `Strict-Transport-Security` header is emitted
  anywhere in `libraries/` (grep-verified); HTTPS enforcement is delegated to
  the web server. `X-XSS-Protection` is a legacy header (ignored by modern
  browsers).
  Evidence: `libraries/classes/Header.php:497-530`; no-cache set in
  `libraries/classes/Core.php` (`getNoCacheHeaders`) and
  `libraries/classes/Plugins/Auth/AuthenticationCookie.php:578-580`.
- **SEC-SAU-078** — The system shall emit a `Content-Security-Policy` (plus
  legacy `X-Content-Security-Policy` / `X-WebKit-CSP` variants) with
  `default-src 'self'`, `object-src 'none'`, inline/eval script allowance,
  `img-src 'self' data:` plus OpenStreetMap tile server and, when a captcha is
  configured, the `CaptchaCsp` origin; `$cfg['CSPAllow']` may append extra
  origins.
  Evidence: `libraries/classes/Header.php:574-633`.
  (corrected in review wave 1) Exact `Content-Security-Policy` directives (with
  `$C` = ` <CaptchaCsp> ` and `$A` = `$cfg['CSPAllow']`, default `''`):
  `default-src 'self' $C$A; script-src 'self' 'unsafe-inline' 'unsafe-eval'
  $C$A; style-src 'self' 'unsafe-inline' $C$A; img-src 'self' data: $A
  *.tile.openstreetmap.org $C; object-src 'none';`. `$C` is included only when
  ALL of `CaptchaLoginPrivateKey`, `CaptchaLoginPublicKey`, `CaptchaApi`,
  `CaptchaRequestParam`, `CaptchaResponseParam` are non-empty. The legacy
  `X-Content-Security-Policy` uses `options inline-script eval-script; referrer
  no-referrer` and `X-WebKit-CSP` uses `referrer no-referrer` plus the same
  source lists. No `frame-ancestors`, `base-uri`, `form-action` or
  `connect-src` directive is set (connect falls back to `default-src`).
  `CSPAllow` is interpolated unvalidated (operator-supplied value).
- **DEP-SAU-079** — "Horde"-style header dispatch: all page headers shall be
  emitted through the response/header layer
  (`Header::sendHttpHeaders()` → `header()` per entry, incl. charset and
  `IS_TRANSFORMATION_WRAPPER` suppression for downloadable payloads) rather
  than scattered inline `header()` calls.
  (corrected in review wave 1) "Horde-style" has no basis in the code and the
  "rather than" claim is only partly true: `Core::headerJSON()`
  (`application/json; charset=UTF-8` + no-cache + `nosniff`),
  `Core::noCacheHeader()` and `Core::downloadHeader()` call PHP `header()`
  directly, and `Core::sendHeaderLocation()` goes through
  `ResponseRenderer::header()`; all are skipped when `TESTSUITE` is defined
  (`Core.php:400-440`, `510-535`).
  Evidence: `libraries/classes/Header.php:470-538`; plugin usage of
  `$response->header()` e.g.
  `libraries/classes/Plugins/Auth/AuthenticationCookie.php:578-580`,
  `libraries/classes/Plugins/Auth/AuthenticationHttp.php:75-76`.

## 9. HTTP/PSR-7 interface

- **INT-SAU-080** — The application shall expose PSR-7 compatible request
  objects built from globals (dedicated `ServerRequest` decorator wrapping
  one of Nyholm/Guzzle/Laminas/Slim implementations selected by class
  detection; (corrected in review wave 1) `createFromGlobals()` prefers Slim's
  `createFromGlobals`, then Laminas `fromGlobals`, else the in-tree factory
  built on Nyholm/Guzzle/Laminas/Slim PSR-17 factories in that order)
  with `$_POST` mapped to parsed body only for
  `application/x-www-form-urlencoded` and `multipart/form-data` requests.
  Evidence: `libraries/classes/Http/Factory/ServerRequestFactory.php:52-102`,
  `115-143`; wrapper `libraries/classes/Http/ServerRequest.php:15-23`.
- **INT-SAU-081** — URI reconstruction shall derive scheme from `HTTPS`,
  host from `HTTP_HOST` (fallback `SERVER_NAME`), port from `SERVER_PORT`
  (with IPv6 bracket handling), path/query from `REQUEST_URI`, and embed
  `PHP_AUTH_USER`/`PHP_AUTH_PW` as URI user-info for WebAuthn host resolution.
  Evidence: `libraries/classes/Http/Factory/ServerRequestFactory.php:152-207`.
- **FR-SAU-082** — WebAuthn flows shall consume the PSR-7 request (via
  `$GLOBALS['request']`) for both parsed body parameters
  (`webauthn_request_response`, `webauthn_creation_response`) and the
  origin/RP host used in validation.
  Evidence: `libraries/classes/Plugins/TwoFactor/WebAuthn.php:74-81`, `95-99`,
  `131-134`, `148-152`;
  `libraries/classes/WebAuthn/WebauthnLibServer.php:134-150`.

## 10. Data & deployment

- **DATA-SAU-083** — (note, review wave 1: the token and HMAC secret are stored
  under the literal session keys `' PMA_token '` (32 hex chars from 16 random
  ASCII bytes) and `' HMAC_secret '` (16 printable ASCII bytes), both with
  leading and trailing spaces; `Session.php:43-57`, `Util::generateRandom`
  `Util.php:2455-2472`) Session-based secrets shall be confined to the session
  (CSRF token + HMAC secret, `encryption_key`, `URLQueryEncryptionSecretKey`,
  `2fa_application_key`, `WebAuthnCredential*Options`,
  `two_factor_check`, `browser_access_time`, `userconfig` fallback,
  U2F `authenticationRequest`/`registrationRequest`); none shall be written to
  cookies in plaintext.
  Evidence: cross-references of the keys shown above
  (`libraries/classes/Session.php:43-57`,
  `libraries/classes/Plugins/Auth/AuthenticationCookie.php:611-623`,
  `libraries/classes/Crypto/Crypto.php:30-38`,
  `libraries/classes/Plugins/TwoFactor/Application.php:114-124`,
  `libraries/classes/Plugins/TwoFactor/WebAuthn.php:83`, `136`,
  `libraries/classes/Plugins/TwoFactor/Key.php:131`, `157`).
- **DEP-SAU-084** — Deployments shall set `blowfish_secret` to a
  32-byte-compatible value so username-recall cookies are stable across
  sessions; absent or short secrets shall force the weaker session-scoped key
  (documented trade-off, not an error). (corrected in review wave 2: the
  original "and disable recall" is true only for an EMPTY secret, as the wave-1
  correction below states.)
  (corrected in review wave 1) Precise rule (`AuthenticationCookie::getEncryptionSecret`):
  `blowfish_secret` of exactly 32 bytes is used as-is; longer than 32 bytes is
  truncated to its first 32 bytes; non-string or shorter than 32 bytes falls
  back to a per-session secret. The login form's recall (prefilled
  user/server, autocomplete) is disabled only when `blowfish_secret` is EMPTY
  (`AuthenticationCookie.php:102-112`); a non-empty but too-short secret keeps
  recall enabled yet encrypts with the session key, so recalled values do not
  survive a new session. The default is `''` (`config.default.php:109`).
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationCookie.php:102-112`,
  `588-606`; sample guidance in `config.sample.inc.php`.
- **NFR-SAU-085** — Authentication failure paths must not disclose internals:
  DBI error text is HTML-escaped (`getErrorMessage`), session-open errors are
  path-masked via regex replacement before display, and injected PHP errors on
  the login page are gathered post-hoc from the error handler.
  Evidence: `libraries/classes/Plugins/AuthenticationPlugin.php:195-205`;
  `libraries/classes/Session.php:81-115`;
  `libraries/classes/Plugins/Auth/AuthenticationCookie.php:158-160`.
- **NFR-SAU-086** — All results of response-driven flows (login page vs.
  modal, 2FA page, failures) shall be testable side-effect free for the
  test-suite (`TESTSUITE` defined ⇒ no `exit`, no `session_*` destructive
  calls), which is a hard structural requirement of every auth path.
  Evidence: pervasive `if (! defined('TESTSUITE')) { exit; }` guards e.g.
  `libraries/classes/Plugins/Auth/AuthenticationCookie.php:77-82`, `203-205`;
  `libraries/classes/Plugins/AuthenticationPlugin.php:142-145`, `339-358`.
- **CON-SAU-087** — LegacyAdmin shall continue supporting PHP versions below
  7.3 in cookie/session code path branches (`PHP_VERSION_ID < 70300` same-site
  workarounds), as present in both `Session::setUp` and `Config::setCookie`.
  Evidence: `libraries/classes/Session.php:145-180`;
  `libraries/classes/Config.php:888-979`.
- **FR-SAU-088** — The language preference of a user shall be persisted into
  the `pma_lang` cookie and the theme into the theme cookie during the
  front-controller run (both subject to the secure `setCookie` path).
  Evidence: `libraries/classes/Common.php:214-216`;
  `libraries/classes/Config.php:912-984`.
- **FR-SAU-089** — The remote IP shall be resolved for captcha verification /
  rule evaluation through `Core::getIp()`, honoring `TrustedProxies` with the
  configured forwarded header and validating the parsed client IP.
  (corrected in review wave 1) Precise rules: returns `false` when
  `REMOTE_ADDR` is empty; `$cfg['TrustedProxies']` (default `[]`) maps a proxy
  IP (exact key match, no CIDR) to the name of the header to read (e.g.
  `HTTP_X_FORWARDED_FOR`); only the first comma-separated element is used and
  must pass `filter_var(FILTER_VALIDATE_IP)`, else `false` is returned (not
  the direct IP). `IpAllowDeny` treats a false/empty IP as "no rule matches"
  (see SEC-SAU-302 for the resulting order-dependent effect).
  Evidence: `libraries/classes/Core.php:806-840`;
  `libraries/classes/Plugins/Auth/AuthenticationCookie.php:273-276`.
- **CPT-SAU-090** — Initialization shall refuse to run on PHP < 7.2.5 with an
  explanatory page (`url.php:14-16` etc.) and warn about missing required
  session support (`Session::setUp` via `Core::warnMissingExtension`).
  Evidence: `url.php:14-16`; `libraries/classes/Session.php:126-140`.
  (corrected in review wave 1) Version check is `PHP_VERSION_ID < 70205`
  (`url.php:14-16`); `composer.json` requires `^7.2.5 || ^8.0`.

## 11. Additional requirements (added in review wave 1, second half; heading level corrected in review wave 2)

> Review wave 2 note: SEC-SAU-302 restates FR-SAU-203 (AllowDeny) and
> SEC-SAU-312 restates SEC-SAU-201/033 (cookie attributes). They are consistent
> with each other (re-verified against code) and are intentionally kept to avoid
> renumbering; FR-SAU-203 / SEC-SAU-201 are the primary statements.

- **SEC-SAU-300** — (added in review wave 1) When `$cfg['URLQueryEncryption']`
  is true, `Url::buildHttpQuery()` shall move the following parameters out of
  the query string into a single `eq` parameter: `db, table, field, sql_query,
  sql_signature, where_clause, goto, back, message_to_show, username, hostname,
  dbname, tablename, checkprivsdb, checkprivstable`. The `eq` value is
  `base64(nonce||secretbox(json_encode(params)))` with `+/` replaced by `-_`
  (padding retained). On each request `Core::populateRequestWithEncryptedQueryParams()`
  shall read `eq` from the POST body (preferred) or the query string, remove it,
  decrypt it, `json_decode` it and merge the keys into `$_GET`/`$_POST` and
  `$_REQUEST`. If decryption fails (SEC-SAU-067) the `eq` parameter is dropped
  silently and the request continues WITHOUT those parameters (no error page).
  Evidence: `libraries/classes/Url.php:249-310`;
  `libraries/classes/Core.php:1005-1065`; `libraries/classes/Common.php:126`.
- **SEC-SAU-301** — (added in review wave 1) `Sanitize::sanitizeMessage()` shall,
  unless `$safe`, replace `<` and `>` by `&lt;`/`&gt;` before interpreting a
  fixed BBCode set (`[em] [strong] [code] [kbd] [br] [sup]`, `[/a]`, `[/doc]`,
  `[conferr]`, `[dochelpicon]`, `[a@url@target]`, `[doc@anchor@section]`) so
  that only the whitelisted tags can become markup. For `[a@url@target]`:
  `url` must pass `checkLink()` (SEC prefixes in FR-SAU-072), and `target`
  must match `[a-z_]+` (case-insensitive) else the text is left unchanged;
  `target="_blank"` also gets `rel="noopener noreferrer"`; `http(s)` URLs are
  routed via `Core::linkURL()`. The pattern excludes `"`, `]` and `@` from the
  URL so attribute breakout is impossible. `$escape=true` additionally applies
  `htmlspecialchars`. `[doc@...]` anchors accept only `[a-zA-Z0-9_-]`.
  Evidence: `libraries/classes/Sanitize.php:44-89`, `103-130`, `179-243`.
- **SEC-SAU-302** — (added in review wave 1) IP allow/deny evaluation
  (`AuthenticationPlugin::checkRules`, run during authentication) shall apply
  per-server `AllowDeny['order']` (`''` default = disabled) with rules
  `"allow|deny <user|%> [from] <addr>"` from `AllowDeny['rules']`:
  - `order = 'allow,deny'`: default forbidden; allowed if an allow rule
    matches; then forbidden again if a deny rule matches.
  - `order = 'deny,allow'`: default allowed; forbidden if a deny rule matches;
    then allowed again if an allow rule matches.
  - `order = 'explicit'`: allowed only if an allow rule matches AND no deny
    rule matches.
  - Any other non-empty order value => no restriction applied.
  A forbidden client gets `showFailure('allow-denied')`. Address forms:
  shortcuts `all`=`0.0.0.0/0`, `localhost`=`127.0.0.1/8`, `localnetA/B/C` =
  `SERVER_ADDR` with /8, /16, /24; IPv4 `a.b.c.d/n` CIDR, IPv4 per-octet range
  `[x-y]`, exact IPv4; IPv6 exact, CIDR, or `[a-b]` range (case-insensitive,
  compared via `inet_pton` hex). The username match is exact (`hash_equals`)
  unless the rule user is `%`. Remote address comes from `Core::getIp()`
  (FR-SAU-089); if unknown, neither allow nor deny matches (so `deny,allow`
  mode admits, `allow,deny`/`explicit` rejects). Also in `checkRules`:
  `AllowRoot=false` (default `true`) => `root-denied` for user `root`;
  `AllowNoPassword=false` (default) with empty password => `empty-denied`.
  Verification: table-driven test over the three orders x {match allow, match
  deny, both, neither, unknown IP}.
  Evidence: `libraries/classes/Plugins/AuthenticationPlugin.php:272-322`;
  `libraries/classes/IpAllowDeny.php:38-312`; defaults
  `libraries/config.default.php:531-554`.
- **SEC-SAU-303** — (added in review wave 1; defect observed) The IPv4 CIDR
  matcher builds its netmask from bits 30..0 only (`for $i < 31`, `2 ** (30-$i)`),
  never including bit 31, so the top bit of the address is ignored: rule
  `allow % 10.0.0.0/8` also matches `138.x.x.x`. Verified by evaluation of the
  loop (mask `0x7F000000` for /8). The legacy behaviour is therefore
  over-permissive for allow rules and over-restrictive for deny rules. Any
  re-implementation must decide whether to preserve or fix it. Also the
  range form assumes 4 dotted octets and performs no format validation.
  Evidence: `libraries/classes/IpAllowDeny.php:67-106`.
  (re-verified in review wave 2: for /8 the loop adds 2^30..2^24 only, mask
  `0x7F000000`.)
  Verification: `ipv4MaskTest('10.0.0.0/8','138.1.2.3')` returns true.
- **SEC-SAU-304** — (added in review wave 1) File inclusion paths derived from
  user input shall pass `Core::securePath()` which replaces every run of dots
  (`\.\.*` => single `.`) so `..` sequences cannot occur; applied to import
  `format`, export `what`/export type, local import filename (`UploadDir`),
  `goto_include` in table replace, transformation plugin file names and
  `%u` user substitution in `UploadDir`. Evidence: `Core.php:74-78`;
  `Controllers/Import/ImportController.php:261,457`;
  `Controllers/Export/ExportController.php:228`; `Export.php:1337`;
  `Controllers/Table/ReplaceController.php:457,573,668`; `File.php:419`;
  `Util.php:1257`.
  Verification: `Core::securePath('../../a..b')` must contain no `..`
  sequence (each dot run collapses to one `.`).
- **SEC-SAU-305** — (added in review wave 1) File-upload / server-side import
  security: (a) an uploaded import file is accepted only when
  `is_uploaded_file()` is true (`File::setUploadedFile`, error "File was not an
  uploaded file."), otherwise `$import_file='none'`; (b) a file chosen from the
  server `UploadDir` is `securePath`d, resolved under `Util::userDir()`, and
  rejected if it is a symbolic link (`$import_file='none'`;
  `File::setLocalSelectedFile` => "File is a symbolic link"); (c) the file must
  be readable ("File could not be read!"); (d) `UploadDir` defaults to `''` (disabled,
  `config.default.php:2805`) and is only used when non-empty and a string.
  Evidence: `libraries/classes/File.php:201-237`, `408-440`;
  `libraries/classes/Controllers/Import/ImportController.php:446-475`.
  Verification: set `UploadDir`, place a symlink in it and select it; import
  must fail with "File is a symbolic link".
- **SEC-SAU-306** — (added in review wave 1) The U2F `key` backend keeps
  `authenticationRequest`/`registrationRequest` in the session after use
  (not single-use, unlike WebAuthn FR-SAU-061); a re-implementation shall
  make challenges single-use. Evidence: `Plugins/TwoFactor/Key.php:79-160`.
- **SEC-SAU-307** — (added in review wave 1) Download responses shall be built
  by `Core::getDownloadHeaders()`: filename passed through
  `Sanitize::sanitizeFilename()` (every character outside `A-Za-z0-9_.-`
  replaced by `_`; dots also replaced when `$replaceDots`), emitted as
  `Content-Disposition: attachment; filename="<name>"` plus `Content-Description:
  File Transfer`, `Content-Type: <mimetype>`, `Content-Transfer-Encoding:
  binary`, `Content-Length` only if > 0, and no-cache headers unless disabled;
  an empty sanitized name suppresses Content-Disposition. `header_remove(
  'Content-Encoding')` is called before sending. Evidence:
  `libraries/classes/Core.php:472-535`; `Sanitize.php:248-262`.
- **SEC-SAU-308** — (added in review wave 1) Output encoding for inline
  JavaScript: `Sanitize::escapeJsString()` shall delete NUL, backslash-escape
  `\`, `'`, `"`, convert LF/CR to `\n`/`\r`, and break `</script` (case-
  insensitive) into `</' + 'script`. Evidence: `Sanitize.php:299-317`.
- **SEC-SAU-309** — (added in review wave 1) Deserialization shall use
  `Core::safeUnserialize()` for stored data (e.g. tracking schema snapshots):
  the serialized string is scanned token by token and rejected (returns `null`)
  unless every value type is one of `s` (string), `b`, `i`, `d`, `a` (array)
  or `N`; any other type (notably `O:` objects), unbalanced `}`, malformed
  string lengths or unterminated arrays yield `null`; only then `unserialize()`
  is called. Evidence: `Core.php:883-961`;
  `Tracking.php:665`.
- **SEC-SAU-310** — (added in review wave 1) SQL query signing: the system shall
  authenticate SQL text passed through URLs/forms with
  `hash_hmac('sha256', $sql, $_SESSION[' HMAC_secret '] . $cfg['blowfish_secret'])`
  (`Core::signSqlQuery`) and verify with `hash_equals` (`checkSqlQuerySignature`);
  an absent session secret is treated as `''` (signature then depends only on
  `blowfish_secret`, which may also be empty). Evidence: `Core.php:965-997`.
  Verification: flip one character of `sql_query` while keeping
  `sql_signature`; `checkSqlQuerySignature` must return false.
- **SEC-SAU-311** — (added in review wave 1) Identifier escaping for SQL:
  `Util::backquote()` wraps identifiers in backticks and doubles embedded
  backticks (`str_replace('`','``')`); in `MSSQL` compat mode it uses `"` with
  `\` escaping; `''` and `*` are returned unchanged. Evidence: `Util.php:395-435`.
- **SEC-SAU-312** — (added in review wave 1) Cookies written through
  `Config::setCookie()` shall: use cookie name `<name>` + server suffix
  (`getCookieName`: prefix `__Secure-` and suffix `_https` when served over
  HTTPS, else plain name), default validity 30 days (`time() + 2592000`; validity `0`
  = session cookie), `path` = application root path, empty domain, `secure`
  = `isHttps()`, `httponly` = true unless the caller passes false, `SameSite` =
  `$cfg['CookieSameSite']` (default `'Strict'`); a cookie whose value is empty
  or equals the supplied default is removed (expired `time()-3600`). For PHP
  < 7.3 SameSite is appended to the path. Session cookie: lifetime 0, same
  path, `secure` = `isHttps()`, HttpOnly, `session.use_only_cookies=1`,
  `session.use_strict_mode=1`, `session.use_trans_sid=0`. Evidence:
  `Config.php:888-1010`; `Session.php:145-190`; `config.default.php:802`.
- **SEC-SAU-313** — (added in review wave 1) Routing: the route shall be taken
  from `$_GET['route']` else `$_POST['route']` (non-string/empty => `/`);
  legacy `?db=...` with route `/` maps to `/database/structure` (or `/sql` when
  `table` is also given). An unknown route shall yield HTTP 404 with message
  "Error 404! The page %s was not found." (route HTML-escaped); a known route
  with wrong HTTP method yields HTTP 405 "Error 405! Request method not
  allowed.". The route is `rawurldecode`d before dispatch. Evidence:
  `libraries/classes/Routing.php:130-185`.
- **SEC-SAU-314** — (added in review wave 1) Outbound HTTP requests
  (`Utils\HttpRequest`, used for version checks and error reports) shall verify
  TLS: cURL with `CURLOPT_SSL_VERIFYPEER=true`, `VERIFYHOST=2`, and the stream
  fallback with `verify_peer` and `verify_peer_name` true. Evidence:
  `libraries/classes/Utils/HttpRequest.php:187-188`, `244-245`.
- **SEC-SAU-315** — (added in review wave 1) Error reporting: `/error-report`
  (GET/POST) shall only act for `exception_type` in `{js, php}`; submissions go
  to `https://reports.legacyadmin.net/incidents/create` as JSON POST and only
  when the user agrees (`$cfg['SendErrorReports']` default `'ask'`; values
  ask/always/never). Reported URLs are sanitized: script name must match
  `[a-zA-Z\-_\d.]*\.php` or `js/...js` else `index.php`, and query keys `db`,
  `table`, `token`, `server`, `eq` are removed. Report content includes pma
  version, browser/OS, `SERVER_SOFTWARE`, user agent, locale, PHP version and
  whether configuration storage is enabled. For `php` errors a session counter
  limits submissions to 3 before the loop is stopped (`stopErrorReportLoop`);
  note the timing comparison `prev_error_subm_time - time() <= 3000` is always
  true (the difference is non-positive), so the "time window" is ineffective.
  Evidence: `libraries/classes/ErrorReport.php:34,79-170,176-215`;
  `libraries/classes/Controllers/ErrorReportController.php:49-110`;
  `libraries/routes.php:108`; `config.default.php:2884-2886`.
- **SEC-SAU-316** — (added in review wave 1) Open-redirect hygiene for
  `Core::sendHeaderLocation()`: a leading `./` is replaced by the configured
  root path (`Config::getRootPath()`) to avoid relative-redirect problems with
  PATH_INFO URLs; the session is closed (`session_write_close`) before the
  `Location:` header; on IIS with URIs > 600 chars a `header_location`
  template (meta refresh) is used; if headers were already sent an
  `E_USER_ERROR` (`E_USER_WARNING` on PHP >= 8.4) is triggered. Callers pass
  only internal targets; user-supplied external targets go through SEC-SAU-071.
  Evidence: `libraries/classes/Core.php:356-395`.
- **SEC-SAU-317** — (added in review wave 1) Token-bearing request cleanup:
  `Sanitize::removeRequestVars($allowList)` shall delete from `$_REQUEST`,
  `$_GET`, `$_POST` every key not in the allow-list and, for allow-listed keys,
  any non-string value (arrays) in `$_REQUEST/$_POST/$_COOKIE/$_GET`.
  Evidence: `libraries/classes/Sanitize.php:377-411`.
- **NFR-SAU-318** — (added in review wave 1) Random values used for security
  (CSRF token, HMAC secret, `eq` nonce/key, WebAuthn challenge and user handle)
  shall come from `random_bytes()` (CSPRNG); `Util::generateRandom($len, $hex)`
  draws one `random_bytes(1)` at a time, masks to 7 bits and rejects bytes
  <= 32 and 127 (printable ASCII 33-126 only; `$hex` returns `bin2hex`, i.e.
  twice the length). Failure to generate a token is fatal
  ("Failed to generate random CSRF token!"). Evidence: `Util.php:2455-2472`;
  `Session.php:43-57`; `Crypto/Crypto.php:30-46`;
  `WebAuthn/CustomServer.php:198-205`.

## 12. Review wave 2 additions

- **SEC-SAU-319** — (added in review wave 2; defect observed) Binlog viewer SQL
  injection surface: `BinlogController::getSqlQuery()` builds
  `SHOW BINLOG EVENTS IN '<log>' LIMIT <pos>, <max>` by concatenating the raw
  POST `log` value (`$params['log'] ?? ''`) without escaping. The
  `array_key_exists($params['log'], $this->binaryLogs)` allow-list check only
  decides whether `log` is copied into the pagination URL params; it does NOT
  guard the query. `pos` is cast to int. Mitigations that remain: authenticated
  session, POST + CSRF token (SEC-SAU-041), single-statement `query()`, and the
  MySQL privilege needed for `SHOW BINLOG EVENTS`. A re-implementation shall
  validate `log` against the `SHOW BINARY LOGS` list or escape it.
  Evidence: `libraries/classes/Controllers/Server/BinlogController.php:45-61,
  114-127`.
  Verification: POST `log=x' LIMIT 1 -- ` and observe the altered statement in
  the SQL error/echo.
- **SEC-SAU-320** — (added in review wave 2; defect observed) Zoom search:
  `ZoomSearchController::zoomSubmitAction()` appends
  `' LIMIT ' . $_POST['maxPlotLimit']` to the generated SELECT with no integer
  cast (the form-rendering path at line 265 does `intval`, the submit path does
  not). Any text after the number is executed as part of the statement (e.g.
  `INTO OUTFILE` where the DB user has FILE). Also relevant: table-search
  `order` direction and `customWhereClause` are raw by design (wave-1 DTB
  note). Requirement for a re-implementation: cast to a non-negative integer.
  Evidence: `libraries/classes/Controllers/Table/ZoomSearchController.php:265-266,
  341`.
  Verification: POST `maxPlotLimit=5 PROCEDURE ANALYSE()` (or any suffix) and
  observe it in the executed query.
- **SEC-SAU-321** — (added in review wave 2) Router-level authorization does
  not exist. `Routing::callControllerForRoute()` dispatches solely on HTTP
  method + path (404 unknown, 405 wrong method, SEC-SAU-313); there is no
  route-to-permission table, middleware or role check. Authentication is applied
  uniformly in `Common::run()` (`Plugins::getAuthPlugin()->authenticate()`)
  for every route whenever a server is selected (`! empty($cfg['Server'])`),
  with these exceptions: (a) `$isMinimumCommon` entry points `url.php`,
  `js/messages.php`, setup (`setup/lib/common.inc.php:35`) and the route
  `/import-status`, for which `Common::run` skips authentication
  (`Common.php:91-93, 201-207`); `/import-status` only reads the caller's own
  session upload-progress/`Import_message` data; (b) the no-server state
  (`server=0`), where no DBI connection exists. Authorization is delegated to
  the MySQL server: controllers either run queries that MySQL refuses, or use
  `isSuperUser()`/`isGrantUser()`/`isCreateUser()` merely to choose UI,
  default DB (`selectDb('mysql')`) or `AllowUserDropDatabase` behaviour (see
  SEC-SAU-322). A hardened design should add explicit per-route authorization.
  Evidence: `libraries/classes/Routing.php:154-199`;
  `libraries/classes/Common.php:84-246`; `libraries/routes.php:126`.
  Verification: request any controller route without a session cookie and
  confirm the login form; request `/import-status` without login and confirm
  it responds without credentials.
- **SEC-SAU-322** — (added in review wave 2) `DatabaseInterface::isSuperUser()`
  does not test the SUPER privilege. It runs `SELECT 1 FROM mysql.user LIMIT 1`
  and returns true iff that query succeeds and returns at least one row, i.e.
  "the connected account can read `mysql.user`". The result is cached in
  `SessionCache['is_superuser']` for the session (a later privilege change is
  not seen until the cache is reset) and false when not connected. It is used
  in ~25 controllers as a UI/availability gate (server Databases, Engines,
  Plugins, Replication, Binlog, Export/Import/Sql tabs, Monitor, Privileges,
  drop-database permission) and, when true, to `selectDb('mysql')`.
  `isGrantUser()` and `isCreateUser()` are separate checks (Privileges page
  shows when any of the three holds). Not a security boundary (SEC-SAU-321).
  Evidence: `libraries/classes/DatabaseInterface.php:1746-1766`;
  `Controllers/Server/PrivilegesController.php:143-160`.
  Verification: connect as an account with SUPER but no SELECT on `mysql.user`;
  `isSuperUser()` returns false.
- **SEC-SAU-323** — (added in review wave 2; defect observed) Process list
  `sort_order` is unvalidated: `Processes::getList()` appends
  `' ORDER BY ' . Util::backquote($order_by_field) . ' ' . $sort_order` where
  `sort_order` comes straight from POST (`ProcessesController.php:43`) and only
  has to be non-empty. The column is safely backquoted, the direction is not
  restricted to ASC/DESC, so arbitrary SQL can follow the ORDER BY column
  (e.g. a sub-select ordering expression or `LIMIT`). The same value is
  copied into URL params. Requirement for re-implementation: accept only
  `ASC`/`DESC`.
  Evidence: `libraries/classes/Server/Status/Processes.php:45-70`.
  Verification: POST `order_by_field=Id&sort_order=ASC, (SELECT 1)` and observe
  the executed statement.
- **SEC-SAU-324** — (added in review wave 2) CSRF coverage limit: token
  validation is applied only to POST (SEC-SAU-041). GET requests are never
  token-checked and keep all their parameters, so any state-changing action
  reachable via GET is protected only by the `SameSite` cookie attribute
  (SEC-SAU-033, default Strict; `None` removes that protection). Logout is the
  one action explicitly forced to POST (FR-SAU-039).
  Evidence: `libraries/classes/Common.php:477-479`.

### 12.0 Review wave 3 additions: 2FA enablement, WebAuthn variants, TOTP window, library versions

- **FR-SAU-209** — (added in review wave 3; refines FR-SAU-045, 046, 047, 048,
  050, 051; see CF-003 in `10-conflicts.md`) 2FA enablement model of 5.2.3:
  (a) there is no global configuration switch; 2FA is enabled only by each
  user on the preferences page route `/two-factor`
  (`libraries/routes.php:141`, `Controllers/Preferences/TwoFactorController.php`);
  (b) no user has 2FA by default and an administrator cannot enforce or
  require it (no such setting or policy exists in the code); (c) removal
  (`2fa_remove`) requires first passing the current second factor
  (`TwoFactor::check(true)`, forced, ignoring the session cache), otherwise the
  confirm screen is shown (`TwoFactorController.php:43-52`); (d) persistence
  only when the user-preferences type is `db`, i.e. with configuration storage
  (`TwoFactor.php:69`: `writable = (config['type'] === 'db')`); the
  controller passes `enabled => isWritable()` to the page (`:69`); otherwise
  settings live in the session only (`UserPreferences.php:82-93`, DATA-SAU-047);
  (e) backend availability is computed by `TwoFactor::getAvailableBackends()`
  (`TwoFactor.php:129-155`): `simple` only with `$cfg['DBG']['simple2fa']`;
  `application` only if `Google2FA` (`pragmarx/google2fa-qrcode`) and
  `ImageRenderer` (`bacon/bacon-qr-code`) classes exist and (`XMLWriter` class
  or `imagick` extension); `WebAuthn` always listed; `key` only if
  `U2FServer` (`code-lts/u2f-php-server`) exists; `getMissingDeps()`
  (`TwoFactor.php:~160-185`) reports `pragmarx/google2fa-qrcode`,
  `bacon/bacon-qr-code` and `code-lts/u2f-php-server` (not the XML/imagick
  extension, not `web-auth/webauthn-lib`); (f) the login-time check is
  `AuthenticationPlugin::checkTwoFactor()` calling `$twofactor->check()`
  (`AuthenticationPlugin.php:333`), result cached in
  `$_SESSION['two_factor_check']` (`TwoFactor.php:229-233`, FR-SAU-050).
  Evidence: as cited inline.
  Verification: log in as a user without 2FA settings (no 2FA form appears);
  with configuration storage enrol a TOTP backend, log out/in (form appears);
  without configuration storage observe that the enrolment disappears with
  the session; POST `2fa_remove` without a valid code and observe the confirm
  screen instead of removal.
- **FR-SAU-210** — (added in review wave 3; corrects the generalisation in
  FR-SAU-059 and 09-diagrams 9.16; see CF-004) WebAuthn has two server
  variants behind the `Server` interface (INT-SAU-057). Selection rule
  (`Plugins/TwoFactor/WebAuthn.php:64`): `class_exists(Webauthn\Server::class)
  ? new WebauthnLibServer($this->twofactor) : new CustomServer()`.
  Variant A, `CustomServer` (fallback, no library): checks as in FR-SAU-059,
  i.e. type, credential-id allow-list, challenge, origin host only (scheme and
  port not compared; host from the request URI), rpIdHash, user-present flag;
  it performs NO assertion signature verification and NO sign-count check
  (`WebAuthn/CustomServer.php:76-110`, contains no such calls).
  Variant B, `WebauthnLibServer` (when `web-auth/webauthn-lib` is installed):
  the assertion is passed to `Webauthn\Server::loadAndCheckAssertionResponse`
  with the request options, user entity and PSR-7 request
  (`WebAuthn/WebauthnLibServer.php:145-150`); which checks the library performs
  (signature, counter, origin) is NOT verifiable in this tree because `vendor/`
  is absent and the library is not part of the source. The library is optional
  (DEP-SAU-091). A re-implementation shall not assume either set of guarantees
  without verifying them against a pinned library version.
  Verification: in an environment without the library confirm that a tampered
  signature is accepted by `CustomServer`; with the library installed run the
  same test and record the observed result (not done in this tree).
- **SEC-SAU-325** — (added in review wave 3; refines FR-SAU-054; see CF-005)
  TOTP verification uses `Google2FA::verifyKey` after `setWindow(8)`
  (`Plugins/TwoFactor/Application.php:42`), i.e. +-8 time steps. The step
  length is defined inside the Google2FA library, which is not in the tree;
  30 s is ASSUMED (library default), giving about +-4 minutes (17 valid
  steps). No replay protection or attempt limit exists in this class
  (`Application.php:62-72`).
  Verification: with a vendored library, generate a code for a step 8 steps
  old and observe acceptance, and for 9 steps old rejection; confirm the step
  length in the library source.
- **DEP-SAU-091** — (added in review wave 3) Optional 2FA libraries and their
  composer constraints (`composer.json`): `pragmarx/google2fa-qrcode` is in
  `suggest` as `^2.1` (line 102), in `require-dev` as `^2.1` (line 119) and in
  `conflict` as `<2.1` (line 89); `bacon/bacon-qr-code` is in `suggest` as
  `^2.0` (line 103), in `require-dev` as `^2.0 || ^3.0` (line 108) and in
  `conflict` as `<2.0` (line 88); `code-lts/u2f-php-server` is in `suggest`
  (no version, line 104) and `require-dev` `^1.2` (line 109);
  `web-auth/webauthn-lib` is in `suggest` ("For better WebAuthn/FIDO2
  authentication support", line 105) and `require-dev` as `^3.3.2` (line 126).
  None of them is in `require`; all are optional at runtime and the code
  feature-detects them with `class_exists` (FR-SAU-209, FR-SAU-210). The
  suggest constraint `^2.0` for bacon is narrower than the dev constraint
  that also allows `^3.0`; this tree does not show which one is functional.
  Verification: grep `composer.json` for the four package names; confirm
  `require` lacks them.

### 12.1 Threat model (added in review wave 2)

| Threat | Mitigating requirements | Known gaps |
|---|---|---|
| Authentication (credential theft, guessing, bypass) | FR-SAU-001..006, 019-029, SEC-SAU-020, 024, 025, 031, 202, 207, FR-SAU-203/SEC-SAU-302 (IP rules, AllowRoot/NoPassword), NFR-SAU-085 | No lockout or rate limit (SEC-SAU-206); captcha only for fresh cookie logins (Gap 8) and has a null-deref defect (208); password held in encrypted cookie for the session (Gap 4); CIDR defect (303); no router-level authorization (321); `/import-status` unauthenticated (321); signon/http/config types skip captcha |
| Session (fixation, hijack, expiry) | FR-SAU-032, SEC-SAU-033, 034, FR-SAU-035..037, 042, 200, SEC-SAU-201, 312 | Client-claimed `access_time` accepted within clamp (Gap 9); no IP/UA binding; session cookie only `Secure` when HTTPS detected (proxy headers) ; no HSTS (Gap 6) |
| CSRF | SEC-SAU-040, 041, FR-SAU-039, 042, 043, SEC-SAU-033, 317 | POST-only validation; GET unprotected (324); token reused for whole session (no per-form rotation) |
| XSS | SEC-SAU-077, 078, 301, 308, 313 (route escaped), FR-SAU-005 (DBI text escaped), NFR-SAU-085 | CSP allows `unsafe-inline`/`unsafe-eval` (078), so CSP is weak against injected script; `X-XSS-Protection` obsolete; `CSPAllow` unvalidated; raw exception text in WebAuthn errors (FR-SAU-064) |
| SQL injection | SEC-SAU-311 (backquote), 310 (signed SQL), 309 (safe unserialize, adjacent) | Unescaped concatenation in binlog `log` (319), zoom `maxPlotLimit` (320), process-list `sort_order` (323); table-search order/custom WHERE raw by design; no router authorization (321) |
| LFI / path traversal | SEC-SAU-068, 069, 070, 304, 305, 307, FR-SAU-073 | `securePath` collapses dots only (no realpath check); `SignonScript` includes configured path (205, Gap 7) |
| Open redirect / referrer leak | SEC-SAU-071, FR-SAU-072, SEC-SAU-316, 070 | Regex lacks `D` modifier (trailing newline, 071); allow-list includes third-party blog host; `Referrer-Policy` same-origin only |
| File upload | SEC-SAU-305, FR-SAU-073, 074, SEC-SAU-075, 307 | Uploaded content is SQL/CSV executed by design; no size/type scanning beyond format allow-list; symlink check applies to `UploadDir` only |
| Two-factor authentication | FR-SAU-045..053, 054, 059..065, SEC-SAU-306 | 2FA gate runs after credential cookies are issued (045); CustomServer lacks signature/sign-count check (059); U2F challenge reusable (306); TOTP window +-8 steps (054); session-storage fallback loses enrolment on multi-node setups (Gap 5); no captcha/rate limit on 2FA codes (Gap 8) |

Row text notes: requirement ranges such as "019-029" denote the inclusive FR/SEC
IDs of section 2; the type prefix of each ID is given in its own entry.

## Coverage

Files inspected (behavior derived from, and cited above):

- `libraries/classes/Plugins/AuthenticationPlugin.php`
- `libraries/classes/Plugins/Auth/AuthenticationConfig.php`,
  `AuthenticationCookie.php`, `AuthenticationHttp.php`,
  `AuthenticationSignon.php`
- `libraries/classes/Plugins.php` (auth plugin factory)
- `libraries/classes/Session.php`, `Common.php` (token + bootstrapping),
  `Sanitize.php` (referenced), `Url.php` (token injection)
- `libraries/classes/TwoFactor.php`,
  `libraries/classes/Controllers/Preferences/TwoFactorController.php`
- `libraries/classes/Plugins/TwoFactorPlugin.php`,
  `Plugins/TwoFactor/{Application,Key,WebAuthn,Simple,Invalid}.php`
- `libraries/classes/WebAuthn/{Server,WebauthnLibServer,CustomServer,DataStream,
  CBORDecoder,WebAuthnException}.php`
- `libraries/classes/Crypto/Crypto.php`
- `libraries/classes/Http/ServerRequest.php`,
  `Http/Factory/ServerRequestFactory.php`
- `libraries/classes/Config.php` (cookies, LoginCookieValidity cache),
  `Header.php` (headers/CSP), `Core.php` (checks, domains, IP),
  `UrlRedirector.php`, `url.php`, `Controllers/LogoutController.php`,
  `IpAllowDeny.php`, `UserPreferences.php` (2FA storage), `Plugins.php`,
  `Util.php` (`generateRandom`), `UserPassword.php` (password-change hook),
  `Controllers/Import/ImportController.php` (sql file/format restrictions)
- Direct-include guards: `libraries/vendor_config.php`, `libraries/routes.php`,
  `libraries/constants.php`, `libraries/config.values.php`,
  `setup/lib/common.inc.php`

## Gaps & open questions

1. **`Controllers\Security.php` does not exist** — the brief's reference could
   not be satisfied; the closest artifact is
   `Controllers/Preferences/TwoFactorController.php`. A corresponding entity in
   the target design should clarify which controller family walked the
   "Security" name.
2. **"Hotlink" 2FA backend** — no "Hotlink"-like backend or hotlink protection
   module exists in this release (`Plugins/TwoFactor/` contains only
   `application`, `key`, `WebAuthn`, `simple`, `invalid`). Was the brief
   referring instead to U2F (`key`), or to the removed "hotlink protection"
   that in older releases guard-transformed `transformation wrapper` access?
   If the target spec wants one, this is greenfield behavior.
3. **No auth exception classes** — `libraries/classes/Exceptions/` contains
   only `ExportException.php`; auth failures are communicated with strings,
   globals (`$conn_error`, `$errno`) and fatal errors rather than typed
   exceptions. The target architecture should decide on a typed exception
   hierarchy (only `WebAuthnException` exists locally).
4. **Password hashing** — password hashing is entirely the MySQL server's
   concern; LegacyAdmin stores the session password client-side in an encrypted
   cookie (plaintext inside the ciphertext) and refreshes it on password
   change (`UserPassword.php:127`). Any target-side requirement about server
   password hashing has no legacy counterpart in this subsystem.
5. **Session-based 2FA persistence** — when config storage is unavailable, 2FA
   silently degrades to session storage; multi-node deployments will lose
   enrolment. Determine whether target spec keeps the split-brain tolerance
   (`TwoFactor::isWritable()` gating enrol, noted at
   `TwoFactorController.php:69` enabled flag).
6. **Trusted host / CSP caveats** (typo "CSP.spoken" corrected in review wave 1) — CSP contains `unsafe-inline` and
   `unsafe-eval` allowances (`Header.php:594-606`); a target truly hardened
   build may drop both (nonce/hash). No `Strict-Transport-Security` header is
   emitted anywhere in this subsystem.
7. **`SignonScript` includes arbitrary configured paths** — safe only because
   the path comes from server configuration
   (`AuthenticationSignon.php:146-156`); a target design might forbid this
   mechanism or sandbox it.
8. **Captcha scope** — captcha is enforced only for fresh cookie logins,
   not for 2FA confirmations, signon, or config auth.
9. **Robustness of `browser_access_time`** — inactivity tracking is accepted
   from request-provided `access_time` (clamped) — worth confirming whether
   the target continues accepting client-claimed access times.
10. **`HMAC_secret`** usage outside signon restore is outside this subsystem's
    inspected scope (used by other subsystems, e.g. URL query encryption
    interactions); if 05 spec owns it, a dedicated requirement pass over its
    users is needed.
