# SPEC-08: Deployment, Documentation & Dependencies — LegacyAdmin 5.2.3

Source baseline: `legacy-release` (legacy read-only reference tree, version **5.2.3**, released 2025-10-07 per `ChangeLog:4`). All evidence citations are `path:line` within that tree. The project's `doc/` folder is NOT used as evidence in this spec. In review wave 1 the 46 requirements whose evidence came only from `doc/` were flagged; in review wave 2 each was either re-derived from code (file:line, marked '(corrected in review wave 2)'), rewritten as a code-observable requirement, or retired (ID kept, text says "retired in review wave 2", no evidence). No requirement in this file depends on `doc/` any more; the few remaining `doc/` substrings in the text are historical remarks about what was removed. (corrected in review wave 2)

Requirement types (README.md): FR (functional requirement), NFR (non-functional), SEC (security-related), DATA (data/schema), DEP (deployment/dependency), CPT (README: compatibility/portability; in this file also used for product-identity and documentation-link "concept" items, kept for ID stability), INT (integration interface), CON (constraint, e.g. licensing/legal). The previously undefined type `DEV` was removed in review wave 2.

**ID changes in review wave 2** (old -> new; no other SPEC file referenced any of these IDs): `DEP-090` -> `DEP-DEP-090`, `DEP-091` -> `DEP-DEP-091`, `DEP-092` -> `DEP-DEP-092`, `DEP-093` -> `DEP-DEP-093`, `DEP-094` -> `DEP-DEP-094`, `DEP-096` -> `DEP-DEP-096`, `DEP-100` -> `DEP-DEP-100`, `DEP-102` -> `DEP-DEP-102`, `DEP-103` -> `DEP-DEP-103`, `DEP-162` -> `DEP-DEP-162` (type DEP, subsystem DEP; `DEP-095`/`DEP-101`/`DEP-104` were already `FR-DEP-*`), `DEV-DEP-156` -> `NFR-DEP-156`, `DEV-DEP-157` -> `FR-DEP-157`. (corrected in review wave 2)

---

## 1. Product identity & versioning context

- **CPT-DEP-001** — The system shall be identifiable as LegacyAdmin 5.2.3, "A web interface for MySQL and MariaDB", with package name `legacyadmin/legacyadmin` and license `GPL-2.0-only`.
  Evidence: `composer.json:2-6,15`; `package.json:2-7`; `libraries/classes/Version.php:17-24`. (corrected in review wave 1: composer.json declares license `GPL-2.0-only` at line 15, but package.json:7 declares plain `GPL-2.0`, so the two manifests differ.)

- **FR-DEP-002** — The authoritative runtime version shall be the constants in `LegacyAdmin\Version` (`VERSION='5.2.3'.VERSION_SUFFIX`, `SERIES='5.2'`, `MAJOR=5`, `MINOR=2`, `PATCH=3`, `ID=50203`, `IS_DEV=false`); on a version bump `package.json:3` and the ChangeLog head entry (`5.2.3 (2025-10-07)`) shall be updated consistently (`scripts/set-version.sh -v <ver>` rewrites README, the Sphinx conf and package.json; ChangeLog is edited manually; `./scripts/console set-version` updates Version.php). (corrected in review wave 1)
  Evidence: `libraries/classes/Version.php:16-24`; `package.json:3`; `ChangeLog:4`; `scripts/set-version.sh:46-78`.
  Verification: read `Version.php` constants and assert `VERSION`==`package.json` version==first ChangeLog heading; run `scripts/set-version.sh -v X` on a copy and diff README/package.json.

- **CPT-DEP-003** — The release year/series shall be handled by a version-series-guarded release script that only accepts versions of the series it declares (5.2) and produces `all-languages`, `english` and `source` kits in `zip-7z`, `txz` and `tgz` compressions.
  Evidence: `scripts/create-release.sh:20-23`.

- **CPT-DEP-004** — The ChangeLog shall record each release with a dated head section enumerating fixed upstream issues (e.g. `5.2.3 (2025-10-07)` with entries referencing GitHub issue numbers #19548, #19619, …).
  Evidence: `ChangeLog:4-40`.

---

## 2. Platform requirements (PHP, extensions, OS)

- **FR-DEP-010** — The system shall require PHP **>= 7.2.5 and support PHP 8.x** (composer constraint `^7.2.5 || ^8.0`), and shall abort execution with an explanatory message when running on PHP < 7.2.5 (runtime gate checking `PHP_VERSION_ID < 70205`). The gate output is the HTML fragment `<p>PHP 7.2.5+ is required.</p><p>Currently installed version is: <PHP_VERSION></p>` and runs before the autoloader is loaded. (corrected in review wave 2)
  Evidence: `composer.json:56`; `index.php:14-16`; `url.php:14-16`; `js/messages.php:17-19`; `setup/lib/common.inc.php:9-11`.
  Verification: run `php -r` / web request to `index.php`, `url.php`, `js/messages.php`, `setup/index.php` on PHP 7.1 (or with the constant stubbed) and compare the exact HTML fragment; `composer validate` on `composer.json:56`.

- **FR-DEP-011** — The system shall require the following PHP extensions at minimum (composer `require`, `ext-*` entries): **hash, iconv, json, mysqli, openssl, pcre, xml**; additionally the code checks at runtime (see FR-DEP-160) for `ctype` (fatal; needed by Twig, polyfilled by composer), `mbstring` (warning only), `mysqlnd` (warning only), `pcre`, `json` (fatal) and `hash` (fatal, probed through `hash_hmac`). (corrected in review wave 2) (doc/ marker removed: evidence is code-only.)
  Evidence: `composer.json:57-63`; `libraries/classes/Common.php:306-353`.
  Verification: `composer install` with each `ext-*` removed must fail; with `ctype`, `pcre`, `json`, `hash_hmac` disabled the app must show a fatal error, with `mbstring`/`mysqlnd` disabled a warning only.

- **FR-DEP-012** — The system shall offer the following **optional features driven by suggested PHP extensions** and shall degrade gracefully when they are absent:
  - `ext-curl` — version-update checking (`composer.json:93`);
  - `ext-opcache` — better performance (`composer.json:94`);
  - `ext-zlib` — gzip import/export (`composer.json:95`);
  - `ext-bz2` — bzip2 import/export (`composer.json:96`);
  - `ext-zip` — zip import (`composer.json:97`; the composer description says zip import AND export);
  - `ext-gd2` — image transformations (`composer.json:98`);
  - `ext-mbstring` — best performance (`composer.json:99`; symfony/polyfill-mbstring is a hard dependency, composer.json:80; missing mbstring only raises a warning, Common.php:312-315);
  - `ext-sodium` — better encryption performance; the `paragonie/sodium_compat` polyfill (`composer.json:67`) supplies `sodium_crypto_secretbox*` when the extension is missing (`composer.json:100`). (corrected in review wave 2)

  Evidence (list): `composer.json:92-106`.

- **INT-DEP-013** — The system shall support reCAPTCHA on the login page (composer package `google/recaptcha`), which additionally requires the `openssl` extension (already a hard `require`, composer.json:61).
  Evidence: `composer.json:61,65`.

- **INT-DEP-014** — Two-factor authentication (2FA) shall be pluggable via optional packages `pragmarx/google2fa-qrcode` (^2.1), `bacon/bacon-qr-code` (^2.0), `code-lts/u2f-php-server` (FIDO U2F), and `web-auth/webauthn-lib` (WebAuthn/FIDO2); incompatible older versions are excluded via composer `conflict` (`bacon/bacon-qr-code <2.0`, `pragmarx/google2fa-qrcode <2.1`, `tecnickcom/tcpdf <6.4.4`). Client-side counterparts are `js/src/u2f.js` and `js/src/webauthn.js`. (corrected in review wave 1: doc/ citations removed)
  Evidence: `composer.json:87-90,92-106,107-127` (suggest/conflict/require-dev blocks); `js/src/u2f.js`; `js/src/webauthn.js`.

- **INT-DEP-015** — PDF output support (PDF schema generation/export) shall be enabled by installing `tecnickcom/tcpdf` (^6.4.4 minimum; <6.4.4 must conflict), which is bundled as a **dev** dependency in the released tree.
  Evidence: `composer.json:90,101,123` (conflict, suggest and require-dev entries for tecnickcom/tcpdf).

- **NFR-DEP-016** — The system shall import/export XML and OpenDocument Spreadsheet data using the PHP `xml` extension (hard requirement `ext-xml`). (corrected in review wave 1: doc/ citation removed; code-level usage of libxml in import/export plugins not re-verified here)
  Evidence: `composer.json:63`.

---

## 3. Database support matrix

- **FR-DEP-020** — The system shall support MySQL-compatible database servers, with the code-level minimum server version configurable as `$cfg['MysqlMinVersion']` = `{internal: 50500, human: '5.5.0'}`; connecting to an older server shall yield the unsupported-version error. (MariaDB >= 5.5 is the documented counterpart; not code-verified.) (corrected in review wave 1)
  Evidence: `libraries/classes/Config/Settings.php:4524-4545`; `composer.json:4`.
  Verification: connect to a server reporting a version below 5.5.0 (or lower `MysqlMinVersion` in a test config) and assert the unsupported-version fatal error from `Common::run`.

- **FR-DEP-021** — All database access shall be via PHP **mysqli** (hard requirement `ext-mysqli`); `mysqlnd` is additionally expected (`mysqli_stmt_get_result` absence raises a warning). (corrected in review wave 1)
  Evidence: `composer.json:60`; `libraries/classes/Common.php:318-322`.
  Verification: static check that all DB access goes through `Dbal\DbiMysqli`/`mysqli`; run with `mysqli_stmt_get_result` undefined and assert the mysqlnd warning.

- **DATA-DEP-022** — The configuration-storage database (`create_tables.sql`) shall target databases that understand the `CREATE DATABASE ... DEFAULT CHARACTER SET utf8 COLLATE utf8_bin` syntax ("meant for use with MySQL 5 and above").
  Evidence: `sql/create_tables.sql:4,20-22`.

- **FR-DEP-023** — The system shall present MySQL/MariaDB server authentication plugins with localised descriptions: `mysql_native_password` ("Native MySQL authentication"), `sha256_password`, `caching_sha2_password` ("Caching sha2 authentication"), `auth_socket`/`unix_socket`, and `mysql_old_password`; unknown plugin descriptions are passed through unchanged. (Rewritten from a doc/-only claim about controluser creation syntax per server generation; that syntax is not in code.) (corrected in review wave 2)
  Evidence: `libraries/classes/Server/Plugins.php:55-90`.

- **CPT-DEP-024** — The multi-server capability shall allow administration of several servers from one install: `$cfg['Servers'][$i]` entries are iterated by the configuration loader, `ServerDefault` selects the default (0 = ask), and the navigation header shows the server chooser only when more than one server is configured (FR-UIX-006). (corrected in review wave 2)
  Evidence: `config.sample.inc.php:21-32`; `libraries/config.default.php` (`ServerDefault`); `templates/navigation/main.twig:52-56`; `examples/config.manyhosts.inc.php`.

- **INT-DEP-025** — The system shall support SSL/TLS connections to the database server with per-server directives `ssl`, `ssl_key`, `ssl_cert`, `ssl_ca`, `ssl_ca_path`, `ssl_ciphers`, `ssl_verify`, plus a whitelist to suppress the SSL warning (`MysqlSslWarningSafeHosts`, default `['127.0.0.1','localhost']`). (corrected in review wave 1: evidence re-derived from code)
  Evidence: `libraries/classes/Config/Settings/Server.php:619-700`; `libraries/config.default.php:730-732`.

---

## 4. Web server & browser requirements

- **FR-DEP-030** — The system shall be a pure PHP application served by any web server able to run PHP; its HTTP entry points are the front controller `index.php` (all routes via `?route=`), `url.php` (external-link redirector), `show_config_errors.php`, `js/messages.php`, `setup/index.php` (+ `setup/config.php`, `setup/validate.php`). (corrected in review wave 2) (doc/ evidence replaced by tree listing.)
  Evidence: root listing; `index.php:14-16`; `url.php:1-60`; `show_config_errors.php`; `setup/` listing.

- **SEC-DEP-031** — Web-server-level protection of `libraries/`, `templates/`, `test/`, `setup/` and the TempDir cannot be verified in code: the tree ships no `.htaccess` (CON-DEP-167). Code-level mitigations that exist: include-only PHP files `exit` when the `LEGACYADMIN` constant is undefined (e.g. `libraries/constants.php:5-7`, `setup/lib/common.inc.php:13-15`); the default `TempDir` (`<root>/tmp/`) and cache dir (`libraries/cache/`) lie inside the web root (vendor_config.php), so denying web access to them is an operator obligation. (corrected in review wave 2) (was doc/-only)
  Evidence: `libraries/constants.php:5-7`; `libraries/vendor_config.php:20-24,66-71`; `setup/lib/common.inc.php:13-15`.

- **SEC-DEP-032** — The package shall ship a `robots.txt` disallowing all agents (`User-agent: *` / `Disallow: /`) so installations can block robots from crawling a public LegacyAdmin.
  Evidence: `robots.txt:1-2`. (corrected in review wave 1: doc/ citation removed)

- **FR-DEP-033** — The client requirement shall be a browser with **cookies and JavaScript enabled and able to run Bootstrap 5.3.8** (package.json pin; see NFR-UIX-102/115 in 07-frontend.md). (corrected in review wave 1: version taken from package.json, not from doc/; corrected in review wave 2: the pin is `package.json:19`, line 20 is codemirror)
  Evidence: `package.json:19`; `templates/header.twig:22,33-37`.

---

## 5. Installation procedures

- **FR-DEP-040** — The release process shall build installable kits named `LegacyAdmin-<version>-<kit>` for kits `all-languages`, `english`, `source` in `.zip`, `.tar.xz`, `.tar.gz` form (compression list `zip-7z txz tgz`), each unpacked to the web root and configured by creating `config.inc.php` (FR-DEP-051/045). (corrected in review wave 2) (was doc/-only; install steps now derived from release script)
  Evidence: `scripts/create-release.sh:20-21,131,654,709-717`.

- **SEC-DEP-041** — Every release archive shall get checksum files (`.sha1`, `.sha256`) and, unless `--no-sign` is passed, a detached ASCII-armoured GPG signature (`gpg --detach-sign --armor`, i.e. `.asc`) made with the default key. Key IDs and the keyring URL were doc/-only claims and are not requirements here. (corrected in review wave 2)
  Evidence: `scripts/create-release.sh:731-748`.

- **FR-DEP-042** — The package shall be installable as a Composer project: `composer.json` declares `type: project`, name `legacyadmin/legacyadmin`, a custom `composer` repository `https://www.legacyadmin.net`, and keeps all QA tooling in `require-dev` so that `--no-dev` yields a runtime-only tree. (corrected in review wave 2) (was doc/-only)
  Evidence: `composer.json:2-3,44-48,107-127`.

- **FR-DEP-043** — Git installs shall require the developer pipeline: Git + Composer (`composer update` / `update --no-dev`) + Node.js ≥ 12 + Yarn (`yarn install --production`).
  Evidence: `package.json:9-11,62`; `scripts/create-release.sh:603-606` (release build runs `yarn install --production`, which triggers `postinstall` -> `build`). (corrected in review wave 1: doc/ citation removed)

- **FR-DEP-044** — When the Composer autoloader is missing (not readable), the entrypoints shall abort with a "Most likely you did not run Composer" hint pointing to the docs.
  Evidence: `setup/lib/common.inc.php:15-25`.
  Verification: rename `vendor/autoload.php` in a test copy and request `index.php`, `url.php`, `setup/index.php`; each must `die` with the 'Most likely you did not run Composer' message.

- **FR-DEP-045** — A wizard-style **setup script** shall be available under `/setup`, generating `config.inc.php` outside of server persistence (the changes are not saved to the server; use Download and upload). Persisted keys it emits shall include `DefaultLang`, `ServerDefault`, `UploadDir`, `SaveDir`, `Servers/1/verbose|host|port|socket|auth_type|user|password`.
  Evidence: `setup/lib/common.inc.php:38-49`. (corrected in review wave 1: doc/ citation removed; Servers/1/* persist keys beyond line 49 not re-verified)

- **SEC-DEP-046** — Packagers shall be able to relocate configuration and resource paths through `libraries/vendor_config.php` (keys `configFile`, `customHeaderFile`, `customFooterFile`, `autoloadFile`, `tempDir`, `sqlDir`, `localePath`, `cacheDir`, `licenseFile`, `changeLogFile`; see DEP-DEP-162). NOTE: the `SETUP_CONFIG_FILE` / `SETUP_DIR_WRITABLE` overrides and Debian `pma-configure`/`pma-secure` mentioned by the old doc/-based text do NOT exist in this version's code (no occurrence in any `*.php`, none in vendor_config.php); setup output is download-only (SEC-DEP-140). (corrected in review wave 2)
  Evidence: `libraries/vendor_config.php:15-76`; `libraries/constants.php:30-41`.

- **INT-DEP-047** — The system shall run on Unix-like and Windows hosts: `Config` detects Windows (`PMA_IS_WINDOWS`), the setup script defaults its generated line endings to `win` or `unix` accordingly, and the world-writable configuration permission check is skipped on Windows (NFR-DEP-161). Distro packaging statements (Debian, SUSE, Gentoo, Fedora, XAMPP) were doc/-only and are out of scope. (corrected in review wave 2)
  Evidence: `libraries/classes/Config.php:292-303,666`; `libraries/classes/Controllers/Setup/HomeController.php:105`.

---

## 6. Configuration deployment

- **DATA-DEP-050** — All configuration shall be a single file `config.inc.php` in the toplevel directory (overriding defaults from `libraries/config.default.php`); themes read design parameters from `themes/themename/scss/_variables.scss`; optional hook files `config.header.inc.php` / `config.footer.inc.php` may be created by the site operator.
  Evidence: `libraries/vendor_config.php:46-56` (`configFile` = ROOT_PATH.'config.inc.php', `customHeaderFile` = 'config.header.inc.php', `customFooterFile` = 'config.footer.inc.php'); `libraries/config.default.php` (defaults). (corrected in review wave 1: doc/ citations replaced)

- **FR-DEP-051** — A minimal manual configuration template (`config.sample.inc.php`) shall ship, first requiring the cookie-auth encryption key:
  `$cfg['blowfish_secret']` — must exist for cookie auth ("YOU MUST FILL IN THIS FOR COOKIE AUTH!", 32 bytes of random bytes), one server entry with `auth_type='cookie'`, `host='localhost'`, `compress=false`, `AllowNoPassword=false`, and optional storage settings.
  Evidence: `config.sample.inc.php:12-16,28-32`. (corrected in review wave 1: doc/ citation removed; the sample ships `blowfish_secret` as an empty string, so cookie auth is unusable until filled in)

- **SEC-DEP-052** — Cookie (login) encryption shall use **sodium_crypto_secretbox / sodium_crypto_secretbox_open** (native ext-sodium or the `paragonie/sodium_compat` polyfill) in `AuthenticationCookie::cookieEncrypt/cookieDecrypt`: 24-byte random nonce prepended to the ciphertext, base64-encoded. The key is `$cfg['blowfish_secret']` when it is a string of exactly 32 bytes (`SODIUM_CRYPTO_SECRETBOX_KEYBYTES`), truncated to its first 32 bytes when longer, and a random per-session key (`$_SESSION['encryption_key']`) when absent, non-string or shorter than 32 bytes. Login-recall (`LoginCookieRecall`, default true) additionally needs a non-empty `blowfish_secret`. URL-query encryption (`Crypto\Crypto`, key `URLQueryEncryptionSecretKey`) is a separate use of the same primitive (SEC-DEP-053). (corrected in review wave 2) (wave 1 cited `Crypto.php`, which implements URL-query encryption, not cookie encryption; truncation/session-key semantics now code-derived)
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationCookie.php:44-45,104,587-640`; `composer.json:67`; `libraries/config.default.php:807-809`.
  Verification: unit-test `AuthenticationCookie::cookieEncrypt/Decrypt` round trip; with `blowfish_secret` of 31, 32 and 40 bytes assert session key / exact key / truncated key are used (extend `test/classes/Plugins/Auth/AuthenticationCookieTest.php`).

- **SEC-DEP-053** — The sample config shall expose URL-query encryption (`URLQueryEncryption`, `URLQueryEncryptionSecretKey` 32-byte key).
  Evidence: `config.sample.inc.php:150-155` (both options are commented out in the sample).

- **CON-DEP-054** — With `auth_type='config'` the credentials come from `$cfg['Servers'][$i]['user'|'password']` without any login prompt (`readCredentials` always succeeds); the setup configuration checker raises a warning for it ("full user credentials"), and the logout link is then labelled "Empty session data" (FR-UIX-005). LegacyAdmin holds no own account store: for cookie/http/signon the typed credentials are passed to MySQL. (corrected in review wave 2)
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationConfig.php:35-70`; `libraries/classes/Config/ServerConfigChecks.php:178-195`; `templates/navigation/main.twig:8-50`.

- **FR-DEP-055** — Cookie auth shall use sodium-encrypted cookies (not openssl/AES; cookie name `pmaAuth-<server index>`) with the `CookieSameSite` directive (default `Strict`) and `LoginCookieValidity` (default 1440 s), `LoginCookieStore` (default 0 = until browser closes). (corrected in review wave 1: the former 'AES/openssl' wording contradicted SEC-DEP-052; corrected in review wave 2: evidence re-pointed from `Crypto.php` to `AuthenticationCookie.php`)
  Evidence: `libraries/config.default.php:800-824`; `libraries/classes/Plugins/Auth/AuthenticationCookie.php:587-640,665-690`.
  Verification: log in with cookie auth and inspect the `pmaAuth-<n>` cookie (base64, 24-byte nonce prefix, SameSite attribute equal to `CookieSameSite`, expiry per `LoginCookieValidity`/`LoginCookieStore`).

- **FR-DEP-056** — Error reporting to the LegacyAdmin team on JavaScript errors shall be configurable (`SendErrorReports`: `ask`|`always`|`never`, default `ask`).
  Evidence: `libraries/config.default.php:2884-2886`; `config.sample.inc.php:140-148` (commented example `always`).

- **DATA-DEP-057** — Config import errors surface through `show_config_errors.php`, sending no-cache HTTP headers and `Content-Type: text/html; charset=utf-8`.
  Evidence: `show_config_errors.php:12-26`.

- **INT-DEP-058** — The four authentication plugins shall behave as follows (code-observed): (corrected in review wave 2)
  - `config` — credentials from the server entry, no form (see CON-DEP-054); Evidence: `Plugins/Auth/AuthenticationConfig.php:35-70`.
  - `http` — HTTP Basic: reads `PHP_AUTH_USER`/`PHP_AUTH_PW` (and falls back to the `Authorization` environment value for CGI setups), challenges with `WWW-Authenticate: Basic realm=…` and status 401; Evidence: `Plugins/Auth/AuthenticationHttp.php:75-76,111-140`.
  - `cookie` — login form + sodium-encrypted `pmaAuth-<n>` cookie, session token regenerated by `Session::secure()`, optional reCAPTCHA (SEC-DEP-143); Evidence: `Plugins/Auth/AuthenticationCookie.php:187-196,239-254,326`.
  - `signon` — redirects to `SignonURL` (fatal 'You must set SignonURL!' if unset), reads the foreign session named by `SignonSession` with `SignonCookieParams`, optional `SignonScript`; Evidence: `Plugins/Auth/AuthenticationSignon.php:44-47,66,125-134`.
  Paths relative to `libraries/classes/`.

---

## 7. LegacyAdmin configuration storage (pmadb / linked-tables)

- **FR-DEP-060** — Advanced features (bookmarks, relations, PDF pages, column comments/transformations, history, recent/favorite tables, table UI prefs, tracking, user config, navigation hiding, saved searches, central columns, designer settings, export templates) shall be enabled per feature only when the corresponding storage table directive (`bookmarktable`, `relation`, … see FR-DEP-063) resolves to an existing table; storage lives either in the user's database or in a central `pmadb` accessed through the control connection (DATA-DEP-064). (corrected in review wave 2) (was doc/-only)
  Evidence: `libraries/classes/ConfigStorage/Relation.php:228,1584-1620,1749-1770`.

- **DATA-DEP-061** — The storage schema (`sql/create_tables.sql`) shall create database `legacyadmin` (`utf8`/`utf8_bin`) with the following tables (all `CREATE TABLE IF NOT EXISTS`, `utf8_bin` default):
  | Table | Key columns | Evidence line |
  |---|---|---|
  | `la_bookmark` | id (PK, auto-inc), dbase, user, label (utf8_general_ci), query TEXT | `sql/create_tables.sql:39-48` |
  | `la_column_info` | id PK, db_name/table_name/column_name (UNIQUE key db_name), comment, mimetype, transformation(+options), input_transformation(+options) | `sql/create_tables.sql:56-71` |
  | `la_history` | id bigint PK, username, db, table, timevalue, sqlquery TEXT, KEY username(db,table,timevalue) | `sql/create_tables.sql:79-90` |
  | `la_pdf_pages` | db_name, page_nr PK auto-inc, page_descr | `sql/create_tables.sql:98-106` |
  | `la_recent` | username PK, tables TEXT | `sql/create_tables.sql:114-120` |
  | `la_favorite` | username PK, tables TEXT | `sql/create_tables.sql:128-134` |
  | `la_table_uiprefs` | username+db_name+table_name PK, prefs TEXT, last_update timestamp ON UPDATE CURRENT_TIMESTAMP | `sql/create_tables.sql:142-151` |
  | `la_relation` | master_db/master_table/master_field PK, foreign_db/table/field; KEY foreign_field | `sql/create_tables.sql:159-170` |
  | `la_table_coords` | db_name+table_name+pdf_page_number PK, x, y float unsigned | `sql/create_tables.sql:178-187` |
  | `la_table_info` | db_name+table_name PK, display_field | `sql/create_tables.sql:195-202` |
  | `la_tracking` | db_name+table_name+version PK, date_created/date_updated, schema_snapshot, schema_sql, data_sql longtext, tracking SET('UPDATE',…,'DROP VIEW'), tracking_active | `sql/create_tables.sql:210-224` |
  | `la_userconfig` | username PK, timevalue, config_data TEXT | `sql/create_tables.sql:232-239` |
  | `la_users` | username+usergroup PK | `sql/create_tables.sql:247-253` |
  | `la_usergroups` | usergroup+tab+allowed('Y'/'N' enum default 'N') PK | `sql/create_tables.sql:261-268` |
  | `la_navigationhiding` | username+item_name+item_type+db_name+table_name PK | `sql/create_tables.sql:276-285` |
  | `la_savedsearches` | id PK, username+db_name+search_name UNIQUE (u_savedsearches_username_dbname), search_data | `sql/create_tables.sql:293-303` |
  | `la_central_columns` | db_name+col_name PK, col_type, col_length TEXT, col_collation, col_isNull boolean, col_extra, col_default TEXT | `sql/create_tables.sql:311-323` |
  | `la_designer_settings` | username PK, settings_data TEXT | `sql/create_tables.sql:331-337` |
  | `la_export_templates` | id PK, username+export_type+template_name UNIQUE (u_user_type_template), template_data | `sql/create_tables.sql:345-355` |
  Verification: import `sql/create_tables.sql` into an empty MySQL; `SHOW TABLES` must list exactly the 19 `la_*` tables above and `Relation::getDefaultPmaTableNames` must return the same 19 names.

- **DATA-DEP-062** — The script shall not create the controluser itself (the SQL file's comment gives the rationale: too many parallel installs with the same password); it leaves a commented `GRANT SELECT, INSERT, DELETE, UPDATE, ALTER ON 'legacyadmin'.* TO 'pma'@localhost;` to activate.
  Evidence: `sql/create_tables.sql:6-12,29-31`.

- **FR-DEP-063** — After importing `create_tables.sql`, the table names shall be wired in `config.inc.php` via `$cfg['Servers'][$i]['pmadb']` and 19 table directives (`bookmarktable`, `relation`, `table_info`, `table_coords`, `pdf_pages`, `column_info`, `history`, `table_uiprefs`, `tracking`, `userconfig`, `recent`, `favorite`, `users`, `usergroups`, `navigationhiding`, `savedsearches`, `central_columns`, `designer_settings`, `export_templates`).
  Evidence: `config.sample.inc.php:44-64` (all lines commented out in the sample).
  Verification: uncomment the 19 directives in a copy of `config.sample.inc.php`, set `pmadb`, and assert `Relation::arePmadbTablesDefined()` and the check-relations page report all features OK.

- **DATA-DEP-064** — Storage tables are accessed through a *control connection*: if `controluser` is set it is connected first (`CONNECT_CONTROL`), otherwise a second connection with the user's own credentials is opened for control queries; the home page warns when the controluser is still the default `pma`. The only privilege statement shipped is the commented `GRANT SELECT, INSERT, DELETE, UPDATE, ALTER ON legacyadmin.* TO 'pma'@localhost` (DATA-DEP-062). (corrected in review wave 2) (was doc/-only per-version GRANT matrix; removed)
  Evidence: `libraries/classes/Common.php:604-630`; `libraries/classes/Controllers/HomeController.php:297-310`; `sql/create_tables.sql:25-31`.

- **INT-DEP-065** — **Zero Configuration (zeroconf)** mode (`$cfg['ZeroConf']`, default `true`) shall, after connecting, call `postConnectControl` → `Relation::initRelationParamsCache`, which first probes the default/configured storage database (`legacyadmin` when `pmadb` is empty), and if no eligible pmadb is found probes the current database; when storage is missing the check-relations page offers links to create the database `legacyadmin` (when no db selected), create the storage in the current database, or create missing tables; with ZeroConf disabled these offers are not shown and no probing occurs. (corrected in review wave 2)
  Evidence: `libraries/classes/Common.php:296-302`; `libraries/classes/DatabaseInterface.php:1201-1214`; `libraries/classes/ConfigStorage/Relation.php:1544-1560,1813-1834`; `templates/relation/check_relations.twig:17-37`; `libraries/config.default.php:2898-2900`.

- **DATA-DEP-066** — Transformations shall be driven by `la_column_info` (`mimetype`, `transformation`, `transformation_options`, `input_transformation`, `input_transformation_options`) and implemented by the transformation plugin classes; the generator scripts `scripts/transformations_generator_main_class.sh` / `_plugin.sh` scaffold new plugin classes (FR-DEP-157). (corrected in review wave 2)
  Evidence: `sql/create_tables.sql:56-71`. (doc/transformations.rst citation removed in review wave 1)

---

## 8. Upgrade & migration (SSE — software system evolution)

- **FR-DEP-070** — Application upgrades are file replacement (new tree + existing `config.inc.php`); the code offers no installer. What the code does provide: a version check (`$cfg['VersionCheck']`, default from `vendor_config.php` `versionCheckDefault`=true) via route `/version-check` that reports the latest *compatible* release for the running PHP, shown on the home page. The documented "never extract over an old installation" procedure was doc/-only and is not a code requirement. (corrected in review wave 2)
  Evidence: `libraries/classes/Controllers/VersionCheckController.php:36-45`; `libraries/classes/Controllers/HomeController.php:247`; `libraries/config.default.php:635-640`; `libraries/vendor_config.php:46-51`.

- **FR-DEP-071** — After an upgrade, stale client state is invalidated by version: static assets carry `?v=<version>` (NFR-UIX-100) and the script loader resets its cache when the server version changes (FR-UIX-023). No legacy-config shims exist (e.g. no `set_magic_quotes_runtime` handling anywhere in `libraries/` or `sql/`); the doc/-based guidance on old config files is dropped. (corrected in review wave 2)
  Evidence: `js/src/ajax.js:628-757`; `templates/header.twig:15-19`.

- **FR-DEP-072** — The tree ships three storage upgrade scripts plus the create script; the code consumes only two: (1) `create_tables.sql` is parsed at runtime by splitting on `;` and matching statements of the form CREATE TABLE IF NOT EXISTS followed by a backquoted table name and an opening parenthesis, to obtain default `la_*` DDL (so its statement format is a contract); (2) `upgrade_column_info_4_3_0+.sql` (47 lines) is applied silently with `legacyadmin`/`la_column_info` substituted by the configured names when `la_column_info` lacks the input-transformation columns (2-row probe). `upgrade_tables_mysql_4_1_2+.sql` (144 lines, starts with `ALTER DATABASE legacyadmin DEFAULT CHARACTER SET utf8 COLLATE utf8_bin`) and `upgrade_tables_4_7_0+.sql` (24 lines, normalises `la_bookmark.id` etc.) are not referenced from any code and are for manual use. (corrected in review wave 2) (doc/ ordering claim removed)
  Evidence: `libraries/classes/ConfigStorage/Relation.php:365-395,1510-1535`; `sql/upgrade_tables_mysql_4_1_2+.sql:1-14`; `sql/upgrade_column_info_4_3_0+.sql:1-19`; `sql/upgrade_tables_4_7_0+.sql:1-24`.

- **CPT-DEP-073** — (retired in review wave 2) The Sphinx `versionadded/versionchanged` annotation requirement was evidenced only by `doc/config.rst` and is not code-observable. Its code-level substitute is the per-release `ChangeLog` (CPT-DEP-004), served by route `/changelog`. (corrected in review wave 2)
  Evidence: `ChangeLog:4-40`; `libraries/routes.php:47`.

- **CPT-DEP-074** — MySQL server upgrade knowledge (Y2K38 note "fixed in MariaDB 11.5") shall be maintained in the docs.
  Evidence: `ChangeLog:18`.

- **DATA-DEP-075** — Storage-table upgrades shall be idempotent in the sense that scripts do not recreate `la_*` tables, only `ALTER`/`UPDATE` existing ones and assume the `legacyadmin` database already exists (`USE 'legacyadmin';`).
  Evidence: `sql/upgrade_column_info_4_3_0+.sql:1-16`; `sql/upgrade_tables_4_7_0+.sql:11`.

---

## 9. Docker deployment

- **INT-DEP-080** — Code-level hooks relevant to reverse-proxy / container deployments: `$cfg['PmaAbsoluteUri']` overrides the computed base URL; `HTTP_X_FORWARDED_PROTO: https` is honoured when determining HTTPS; client-IP headers are trusted only for addresses listed in `TrustedProxies` (value names the header, read through `Core::getenv`). The official Docker image, its `PMA_*` environment variables, docker-compose and haproxy/traefik recipes live in a separate repository and were doc/-only: no such code exists in this tree (a search for `PMA_HOST`, `PMA_ARBITRARY`, `PMA_USER_CONFIG` outside doc/ finds nothing). (corrected in review wave 2)
  Evidence: `libraries/classes/Config.php:794,810,840`; `libraries/classes/Core.php:817-827`.

- **INT-DEP-081** — (retired in review wave 2) Docker environment-variable configuration (`PMA_USER`, `PMA_CONTROL*`, `PMA_PMADB`, `UPLOAD_LIMIT`, `PMA_CONFIG_BASE64`, `PMA_SSL*`, …) was doc/-only; it is implemented by the external image's generated `config.inc.php` and is not code-observable here. A re-implementation must define its own env-var contract (see CON-DEP-167). (corrected in review wave 2)
  Evidence: none in tree.

- **INT-DEP-082** — (retired in review wave 2) Docker volumes (`/etc/legacyadmin/config.user.inc.php`, `/sessions/`, `/www/themes/`) were doc/-only. Code-observable analogues: the optional operator files `config.header.inc.php` / `config.footer.inc.php` (DATA-DEP-050), `$cfg['SessionSavePath']` (SEC-DEP-145) and theme discovery by directory under `themes/` (DEP-UIX-112). (corrected in review wave 2)
  Evidence: `libraries/vendor_config.php:46-56`; `libraries/classes/Session.php:162-170`.

---

## 10. Composer (PHP) dependencies

- **DEP-DEP-090** — The PHP dependency baseline shall be exactly the `require` block of `composer.json`, resolved through `composer.lock` (PSR-4 autoload of `LegacyAdmin\` → `libraries/classes`):
  `composer/ca-bundle` ^1.2 · `google/recaptcha` ^1.1 · `nikic/fast-route` ^1.3 · `paragonie/sodium_compat` ^1.17 · `legacyadmin/motranslator` ^5.0 · `legacyadmin/shapefile` ^3.0.1 · `legacyadmin/sql-parser` ^5.8 · `legacyadmin/twig-i18n-extension` ^4.1.3 || ^5.0.0 · `psr/http-factory` ^1.0 · `psr/http-message` ^1.0 · `slim/psr7` ^1.4.1 (locked 1.4.2) · `symfony/config`, `symfony/dependency-injection`, `symfony/expression-language` ^5.2.3 · polyfills (ctype^1.17, iconv^1.33, mbstring^1.17, php80^1.16, php84^1.33) · `twig/twig` ^3.3.5 (locked 3.11.3) · `webmozart/assert` ^1.10 · `williamdes/mariadb-mysql-kbs` ^1.2.
  Evidence: `composer.json:55-86`.
  Verification: `composer validate`, then diff the `require` block against this list and against `composer.lock` `packages[]` names/versions; `composer install --no-dev` must succeed offline from the lock.

- **DEP-DEP-091** — Custom Composer repositories shall include the official LegacyAdmin packagist mirror `https://www.legacyadmin.net` and a GitHub fork patch repo (`MauricioFauth/thecodingmachine-safe.git`, no-api); branch alias `dev-master` → `5.2.x-dev`; feature branches restricted to `RELEASE_.*`.
  Evidence: `composer.json:23,44-54,128-132`.

- **DEP-DEP-092** — Dev-only dependencies shall include the QA toolchain: `phpunit/phpunit` ^8.5.16 || ^9.6 (locked 8.5.48), `phpstan/phpstan` ^1.12 (+ extension-installer, deprecation-rules, phpunit, strict-rules, webmozart-assert plugins), `vimeo/psalm` ^4.30 (+ psalm-plugin-phpunit), `legacyadmin/coding-standard` ^3.0, `php-webdriver/webdriver` ^1.13 (Selenium), `roave/security-advisories` dev-latest, `thecodingmachine/safe` 1.3.3.1, `symfony/console` ^5.2.3, plus the optional 2FA/PDF packages exercised in tests (tcpdf 6.10.0 locked).
  Evidence: `composer.json:107-127`; `composer.lock` entries (slim/psr7 1.4.2, tecnickcom/tcpdf 6.10.0, twig/twig 3.11.3, phpstan 1.12.32, phpunit 8.5.48, psalm 4.30.0).

- **DEP-DEP-093** — Composer `allow-plugins` shall whitelist `dealerdirect/phpcodesniffer-composer-installer`, `phpstan/extension-installer`, `composer/package-versions-deprecated`; and `sort-packages: true`.
  Evidence: `composer.json:151-159`.

- **DEP-DEP-094** — The autoload classmap shall exclude the test directory and selected tcpdf binaries/parsing files; the `motranslator` gettext functions shim shall be force-autoloaded.
  Evidence: `composer.json:28-36`.

- **FR-DEP-095** — Composer scripts shall provide the QA workflow: `test` = phpcs + phpstan + psalm + phpunit; `phpcbf`, `phpcs`, `phpstan`, `psalm`, `phpunit`, `update:baselines`, `twig-lint` (`scripts/console lint:twig`).
  Evidence: `composer.json:133-150`.

- **DEP-DEP-096** — (old ID `DEP-096`) The kits bundle Composer libraries under `vendor/` after `composer update --no-dev` and `cleanup_composer_vendors` (FR-DEP-165); each library's own licence is whatever its package ships. This cannot be verified here because the snapshot has no `vendor/` (CON-DEP-167). The project's own licence is shipped as `LICENSE` (CON-DEP-110). (corrected in review wave 2) (was doc/-only)
  Evidence: `scripts/create-release.sh:537-612`; `composer.json:55-86`.

---

## 11. Node/Yarn build pipeline (client)

- **DEP-DEP-100** — The client build shall use **Node.js ≥ 12** (`engines`) with **Yarn classic 1.22.22** (pinned via `packageManager` include SHA-512 hash) and a `private: true` npm package.
  Evidence: `package.json:8-10,62`. (corrected in review wave 1: doc/ citation removed; `private: true` is at package.json:8)

- **FR-DEP-101** — Build scripts shall be: `postinstall` → `build`; `build` = `css-compile --style=compressed` (SassDart 1.60.0 compiling `themes/pmahomme|original|metro|bootstrap/scss` → `themes/*/css` and `setup/scss` → `setup`), `css-prefix` (postcss ^8 + autoprefixer ^10 over `themes/*/css/*.css` + `setup/styles.css`), `css-rtl` (rtlcss ^3.5 for bootstrap/pmahomme/original/metro theme.css + the 4 metro variants using `.rtlcssrc.json`), `js-compile` (Babel 7: `babel js/src -d js/dist`).
  Evidence: `package.json:51-59`; `babel.config.json:1-4`; `.rtlcssrc.json`.
  Verification: `yarn install` then assert `js/dist/*.js` and `themes/*/css/theme.css` + `theme.rtl.css` exist and that the css has no vendor prefixes missing for `autoprefixer` targets (`package.json:51-59`).

- **DEP-DEP-102** — Runtime client dependencies shall be pinned: `bootstrap` 5.3.8, `codemirror` 5.65.10, `jquery` 3.7.1 (+ `jquery-migrate` 3.5.2, `jquery-ui-dist` 1.13.3, `jquery-ui-timepicker-addon` 1.6.3, `jquery-validation` 1.21.0, `jquery-uitablefilter`, `jquery-debounce-throttle`), `@popperjs/core` 2.11.8, `@zxcvbn-ts/core` ^2.0.1, `ol` 6.15.1 (OpenLayers), `tablesorter` ^2.31.3, `tracekit` 0.4.7 (error reporting), `u2f-api-polyfill` 0.4.4, `updated-jqplot` 1.0.9, `locutus.sprintf` ^2.0.32-code-lts.1, `js-cookie` 2.2.1.
  Evidence: `package.json:12-39`.

- **DEP-DEP-103** — Lint/test dev tooling: `jest` ^27.3.1 + `babel-jest`, `eslint` ^7.32 (+ `eslint-plugin-compat`, `eslint-plugin-no-jquery`), `stylelint` ^13.13.1 (+ scss configs, `css-lint` over `themes/**/scss` and `setup/scss`; `js-lint` over `js/src`, `test/javascript`, `test/jest`).
  Evidence: `package.json:40-60`.

- **FR-DEP-104** — The release tree shall ship prebuilt client artifacts (`js/dist` from `js-compile`, compiled theme CSS under `themes/*/css`, `js/vendor` for vendored runtime libs) so end deployments do **not** need Node/Yarn; only Git builds require the build pipeline. The release script runs `composer update --no-dev` and `yarn install --production` (-> `postinstall` -> `build`) before packaging. NOTE: in the analysed source snapshot `js/dist/` and `themes/*/css/` are empty and `vendor/` is absent, i.e. the snapshot is a pre-build Git tree. (corrected in review wave 1)
  Evidence: `package.json:51-59`; `scripts/create-release.sh:562,603-606`; `js/` listing (config, dist, src, vendor, messages.php).
  Verification: run `scripts/create-release.sh` (or inspect a published kit) and assert `js/dist`, compiled theme css and `vendor/` are present and `node_modules`/`.git*` are absent.

- **CPT-DEP-105** — Vendored JS libraries are maintained by `scripts/sync-js-vendor-files.sh`, which deletes every file in `js/vendor/` and re-copies the needed files from `node_modules` (so the vendor tree is derived, never hand-edited). Licence files are present only for two libraries: `js/vendor/jquery/MIT-LICENSE.txt` and `js/vendor/codemirror/LICENSE` (jQuery ships MIT only; the earlier "(MIT|GPL) both shipped" claim was wrong). Other vendored libraries (jqplot, openlayers, bootstrap, tracekit, zxcvbn, …) carry licence text only in file headers, if at all. (corrected in review wave 2)
  Evidence: `scripts/sync-js-vendor-files.sh:10-30`; `js/vendor` listing.

---

## 12. Licensing & redistribution constraints

- **CON-DEP-110** — Distribution shall be under the **GNU General Public License, version 2 only** (`GPL-2.0-only` in composer, full GPLv2 text shipped as `LICENSE`). Meaning: source code must be offered, license terms displayed, modifications carry the same license, no additional restrictions imposed.
  Evidence: `LICENSE:1-7,59+`; `composer.json:15`; `package.json:7`.

- **CON-DEP-111** — The full GPL-2 text shall be shipped as `LICENSE` and served to users in-app as `text/plain; charset=utf-8` by route `/license` from `LICENSE_FILE` (path overridable via vendor_config `licenseFile`); the release changelog is likewise served at `/changelog`. The copyright-holder chain (Ratschiller etc.) was doc/-only and is dropped. (corrected in review wave 2)
  Evidence: `libraries/routes.php:47,127`; `libraries/classes/Controllers/LicenseController.php:20-35`; `libraries/vendor_config.php:26-35`; `LICENSE:1-7`.

- **CON-DEP-112** — Third-party licence obligations: only the licence files listed in CPT-DEP-105 are in the tree; Composer libraries' licences live in `vendor/` of a built kit (not in snapshot). Redistributors may relocate `LICENSE`, `ChangeLog`, config, temp, SQL, locale and autoload paths through `vendor_config.php` (DEP-DEP-162) and substitute system libraries via `autoloadFile`; there is no code-level compatibility test for such substitution. (corrected in review wave 2) (doc/vendors.rst evidence removed)
  Evidence: `libraries/vendor_config.php:15-76`; `js/vendor/jquery/MIT-LICENSE.txt`; `js/vendor/codemirror/LICENSE`.

- **CON-DEP-113** — Redistribution of derivative code must satisfy GPLv2 §§ copy/distribute/modify obligations; the license text itself may be included but not changed.
  Evidence: `LICENSE:6-7,56+`.

- **CPT-DEP-114** — Support and security-reporting channels shall be published (legacyadmin.net/support, /security, GitHub issues, wiki, docs.legacyadmin.net).
  Evidence: `composer.json:7-14`; `README.rst:63-68`.

---

## 13. Documentation obligations

- **CPT-DEP-120** — In-app documentation links shall resolve through `Html\MySQLDocumentation::getDocumentationLink($page,$anchor)`: if a locally built `doc/html/index.html` exists (and not under TESTSUITE) the link is `./doc/html/<page>.html[#anchor]`, otherwise `Core::linkURL('https://docs.legacyadmin.net/en/latest/<page>.html[#anchor]')`, which routes external URLs through `url.php` (FR-UIX-096); MySQL/MariaDB manual links are built by `Util::getMySQLDocuURL` (version-mapped `https://dev.mysql.com/doc/refman/<5.5|5.6|5.7|8.0>/en/<page>.html`) and `Util::getDocuURL` (MariaDB: `https://mariadb.com/kb/en/documentation/`). The documentation icon is `Html\Generator::showDocumentationLink` (`b_help`). (corrected in review wave 2) (rewritten from "doc/ ships a Sphinx toctree"; the manual itself is not specified here)
  Evidence: `libraries/classes/Html/MySQLDocumentation.php:70-101`; `libraries/classes/Html/Generator.php:738-748`; `libraries/classes/Util.php:205-255`; `libraries/classes/Core.php:626-651`.

- **CPT-DEP-121** — Product scope is defined by the route table: route groups for central columns, database(s), export/import, SQL, structure/table/view operations, maintenance, partitions, privileges and user groups, server engines/variables/status/monitor/processes/replication, multi-table query, themes, templates, transformations, preferences and 2FA, plus single routes such as `/changelog`, `/license`, `/phpinfo`, `/git-revision`, `/version-check`. (corrected in review wave 2) (rewritten from the doc/ intro feature list)
  Evidence: `libraries/routes.php:45-281`.

- **CPT-DEP-122** — The declared platform requirements shall stay consistent across their code declarations: PHP `^7.2.5 || ^8.0` in `composer.json:56`, the runtime gate `PHP_VERSION_ID < 70205` (FR-DEP-010), required extensions in `composer.json:57-63` versus the runtime probe (FR-DEP-011, gap 5), and the Bootstrap 5.3.8 client baseline in `package.json:19`. The doc/-only "Bootstrap 5.0 since 5.2.0" statement is superseded. Known mismatch: `iconv`, `openssl`, `xml` are declared but not probed at runtime. (corrected in review wave 2)
  Evidence: `composer.json:55-63`; `index.php:14-16`; `package.json:19`; `libraries/classes/Common.php:306-353`.

- **CPT-DEP-123** — Each configuration directive shall be defined in four code places: default in `libraries/config.default.php`, typed normaliser in `Config/Settings.php` (`Settings/Server.php` for per-server keys), user-facing name/description in `Config/Descriptions.php`, and (for the setup UI) a form entry in `Config/Forms/**`; UI pages link directives to the manual with `show_docu('config','cfg_<Directive>')` anchors. (corrected in review wave 2) (rewritten from "doc/config.rst is canonical")
  Evidence: `libraries/classes/Config/Settings.php:1580-1766`; `libraries/classes/Config/Descriptions.php:88-109,547`; `libraries/classes/Config/Forms/Setup/FeaturesForm.php:46-69`; `templates/relation/check_relations.twig:35`.

- **CPT-DEP-124** — (retired in review wave 2) The installation-manual structure (distro packages, Docker, quick install, securing checklist) was evidenced only by `doc/setup.rst`. Code-observable installation facts are covered by FR-DEP-040/042/043/044/045, SEC-DEP-031/140/141/145, INT-DEP-065 and DEP-DEP-162. (corrected in review wave 2)
  Evidence: none (cross-reference only).

- **CPT-DEP-125** — (retired in review wave 2, content moved) The security-policy text (XSS/CSRF/SQLi guidance, reporting mailbox, PGP key) was doc/-only. Code-observable security behaviour is specified elsewhere: CSRF token in SEC-DEP-146, login logging in SEC-DEP-142, captcha in SEC-DEP-143, host rules in SEC-DEP-144; no brute-force counter or rate limiter exists in `Plugins/Auth/*` (only the AuthLog hook). (corrected in review wave 2)
  Evidence: `libraries/classes/Logging.php:25-90`.

- **CPT-DEP-126** — (retired in review wave 2) The glossary / `:term:` usage was doc/-only and has no code counterpart. (corrected in review wave 2)
  Evidence: none.

- **CPT-DEP-127** — A README shall exist in plain (`README`) and RST (`README.rst`) form covering CI/quality badges, download branches (`STABLE`, `master`, `RELEASE_<ver>` tags), Composer notice for Git versions and support/security/translation/contribution links. Note: `README.rst:72` links to `CONTRIBUTING.md`, which is absent from this snapshot. (corrected in review wave 2)
  Evidence: `README.rst:11-72`.

- **CPT-DEP-128** — FAQ references in code: the changelog viewer rewrites text of the form `FAQ <n>.<m>` into links to `https://docs.legacyadmin.net/en/latest/faq.html#faq<n>-<m>` via `url.php`, and `Routing.php` cites FAQ 1.34 for route caching behaviour. The enumerated `faqX_Y` identifiers of the old text were doc/-only. (corrected in review wave 2)
  Evidence: `libraries/classes/Controllers/ChangeLogController.php:66-75`; `libraries/classes/Routing.php:141`.

- **CPT-DEP-129** — (retired in review wave 2) "User guide"/"developer guide" as parts of the shipped manual were evidenced only by `doc/*.rst`. (corrected in review wave 2)
  Evidence: none.

- **CPT-DEP-130** — (retired in review wave 2) The "Known issues" list (#11922, #11898) came from `doc/setup.rst`; the tree has no code or ChangeLog marker for it. (corrected in review wave 2)
  Evidence: none (a search for the issue numbers outside doc/ finds nothing).

- **CPT-DEP-131** — The tree shall ship an `examples/` directory with `config.manyhosts.inc.php`, `signon.php` (session-SSO pattern using `PMA_single_signon_user/password/host/port` + `SignonSession` cookie, HMAC secret `PMA_single_signon_HMAC_secret`), `signon-script.php` and `openid.php`. (corrected in review wave 2) (literalinclude statement was doc/-based; removed)
  Evidence: `examples/` listing; `examples/signon.php:13-39`.

---

## 14. Security/deployment hardening requirements

- **SEC-DEP-140** — The setup script shall not persist configuration to the server: the generated `config.inc.php` text is only shown in a textarea (`Display`), offered as a `text/plain` download named `config.inc.php` (`Download`), or discarded (`Clear`); the operator uploads it manually. (corrected in review wave 2)
  Evidence: `setup/config.php:30-52`; `templates/setup/home/index.twig:164-166`; `templates/setup/config/index.twig:22`.

- **SEC-DEP-141** — For `auth_type='config'` deployments anybody who can reach the URL gets the configured MySQL account; the code only warns (setup configuration check "full user credentials" and an AllowNoPassword warning) and provides no access control of its own beyond `AllowDeny`/`AllowRoot`. Protecting the URL (web-server auth, firewall) is an operator obligation. (corrected in review wave 2)
  Evidence: `libraries/classes/Config/ServerConfigChecks.php:178-225`; `libraries/classes/Plugins/Auth/AuthenticationConfig.php:57-70`.

- **SEC-DEP-142** — Authentication events shall be loggable via `$cfg['AuthLog']`: value `auto` selects `syslog` if available, else PHP `error_log` (`php`), else none; messages are `user authenticated: <user> from <ip>` and `user denied: <user> (<reason>) from <ip>`; successes are logged only when `AuthLogSuccess` is true (default false). This enables fail2ban-style integration. (corrected in review wave 2)
  Evidence: `libraries/classes/Logging.php:25-90`; `libraries/classes/Common.php:243`; `libraries/classes/Plugins/AuthenticationPlugin.php:105`.

- **SEC-DEP-143** — reCAPTCHA on the cookie login form is active only when `CaptchaApi`, `CaptchaRequestParam`, `CaptchaResponseParam`, `CaptchaLoginPrivateKey` and `CaptchaLoginPublicKey` are all non-empty; a missing response parameter rejects the login; verification uses `google/recaptcha` against `CaptchaSiteVerifyURL` (default Google). (corrected in review wave 2)
  Evidence: `libraries/classes/Plugins/Auth/AuthenticationCookie.php:187-196,239-256`; `composer.json:65`.

- **SEC-DEP-144** — Access control for all auth types: `AllowDeny['order']` (`allow,deny` | `deny,allow` | `explicit`) with `AllowDeny['rules']` evaluated by `IpAllowDeny` (reject with failure `allow-denied`), `AllowRoot=false` rejects user `root` (`root-denied`; default true), `AllowNoPassword=false` rejects empty passwords (`empty-denied`), and `AllowArbitraryServer` allows free host input on the login form (setup check warns when enabled). (corrected in review wave 2)
  Evidence: `libraries/classes/Plugins/AuthenticationPlugin.php:272-322`; `libraries/config.default.php:531-533`; `libraries/classes/Config/ServerConfigChecks.php:62-86`.

- **SEC-DEP-145** — `$cfg['SessionSavePath']`, when non-empty, shall set `session_save_path()` and force `session.save_handler=files`; sessions always use cookies only, strict mode and HttpOnly cookies. (corrected in review wave 2)
  Evidence: `libraries/classes/Session.php:158-180`.

- **SEC-DEP-146** — CSRF protection: a 16-character random `$_SESSION[' PMA_token ']` (plus `HMAC_secret`) is generated by `Session::generateToken` (fatal 'Failed to generate random CSRF token!' on failure) and regenerated, with `session_regenerate_id(true)`, by `Session::secure()` at login; every POST must carry `token`, compared with `hash_equals`, otherwise `token_mismatch` is set. (corrected in review wave 2)
  Evidence: `libraries/classes/Session.php:43-76`; `libraries/classes/Common.php:476-494`; `libraries/classes/Plugins/Auth/AuthenticationCookie.php:326`; `libraries/classes/Plugins/AuthenticationPlugin.php:257`.

---

## 15. Development & test environment requirements

- **FR-DEP-150** — PHP unit testing shall be defined by `phpunit.xml.dist`: PHPUnit 8.5 schema, bootstrap `test/bootstrap-dist.php`, `forceCoversAnnotation`, random execution order, default suite `unit` (`test/classes`), second suite `selenium` (`test/selenium`), coverage logging (clover/coverage-xml/junit into `build/logs/`), coverage whitelist of root `.php` excluding `examples`, `libraries/cache`, `node_modules`, `test`, `tmp`, `vendor`; the `LEGACYADMIN` and `TESTSUITE` test constants are set; env `LC_ALL=C.UTF8` is forced; tests run in random order (`executionOrder="random"`).
  Evidence: `phpunit.xml.dist:1-45`.

- **FR-DEP-151** — Test bootstrap shall define `ROOT_PATH`/`TEST_PATH` (Debian may relocate tests), set `precision=14`, `E_ALL` reporting, UTC timezone; long-running/late PHP versions may use the alternate `phpunit-php-nightly.xml`.
  Evidence: `test/bootstrap-dist.php:1-28`; test dir listing (`phpunit-php-nightly.xml`).

- **FR-DEP-152** — The test tree shall be organized as: `test/classes` (289 `*Test.php` unit tests, PSR-4 `LegacyAdmin\Tests\`), `test/javascript` (Jest, suite "LegacyAdmin", jsdom environment, module mapping `legacyadmin/*` → `js/src/*` and `@vendor/*` → `js/vendor/*`, coverage into `build/javascript/` over `js/src/**`), `test/jest` (setup file `test-env.js` + file-transformer), `test/selenium` (22 browser E2E tests, `LegacyAdmin\Tests\Selenium\`), `test/stubs`, `test/test_data`, `test/config`, `test/bootstrap-dist.php`.
  Evidence: `composer.json:38-43`; `jest.config.js:3-26`; `test/README.rst:1-85`.

- **FR-DEP-153** — Selenium E2E configuration shall be env-var driven (`TESTSUITE_USER`, `TESTSUITE_PASSWORD`, `TESTSUITE_DATABASE_PREFIX`, `TESTSUITE_URL`, `TESTSUITE_SELENIUM_HOST/PORT/BROWSER`, or BrowserStack `TESTSUITE_BROWSERSTACK_USER/KEY` + BrowserStackLocal tunnel; PHP built-in server usage documented).
  Evidence: `test/README.rst:15-85`.

- **SEC-DEP-154** — The `test/` directory is described by `test/README.rst:4-7` as protected from web visitors by an `.htaccess` file; the tree ships no such file (CON-DEP-167) and production kits are expected not to contain tests (see `scripts/check-release-excludes.sh`). (corrected in review wave 2)
  Evidence: `test/README.rst:4-7`; `composer.json:30` (corrected in review wave 1: composer.json:30 only excludes `/test/` from the classmap, it does not exclude it from the package; kit contents are decided by `scripts/create-release.sh` and `scripts/check-release-excludes.sh`; the 'securing checklist' wording was from doc/ — removed/needs re-verification).

- **FR-DEP-155** — JS testing/linting gates (`yarn test` = `jest`; `yarn js-lint` = eslint over `js/src test/javascript test/jest jest.config.js`; `yarn css-lint` = stylelint) and PHP QA gates (`composer test` = phpcs, phpstan, psalm, phpunit in this order; `composer twig-lint`) shall form the mandated pre-commit CI quality gates. NOTE: the ESLint/Stylelint rule files (`.eslintrc*`, `.stylelintrc*`) and CI workflow files (`.github/`) are absent from the analysed snapshot, so rule sets are not reproducible from this tree (corrected in review wave 1) (documented badges: GitHub Actions tests.yml, test-selenium.yml, codecov, scrutinizer, psalm shepherd, infection MSI).
  Evidence: `package.json:51-60`; `composer.json:133-150`; `README.rst:11-45`.

- **NFR-DEP-156** — Maintainability assets (type changed from the undefined `DEV` to NFR in review wave 2; old ID `DEV-DEP-156`): code style/stubs and analysis baselines (`test/stubs`, `legacyadmin/coding-standard`, `.rtlcssrc.json`, `update:baselines` composer script) shall be maintained so static-analysis services stay reproducible. (corrected in review wave 2)
  Evidence: `composer.json:111,145-148`; `README.rst:39-45`.

- **FR-DEP-157** — Release engineering scripts under `scripts/` (type changed from the undefined `DEV` to FR in review wave 2; old ID `DEV-DEP-157`) shall include `create-release.sh` (kits/compressions/signing, series guard 5.2), `set-version.sh`, `generate-mo`, `remove-incomplete-mo`, `lang-cleanup.sh`, `update-po`, `locales-contributors`, `sync-js-vendor-files.sh` (deletes and re-copies `js/vendor` from `node_modules`), `match-twig-cache`, `transformations_generator_main_class.sh` / `_plugin.sh`, `check-release-excludes.sh`, `upload-release`, and `console` (Symfony console for twig lint). (corrected in review wave 1: two scripts were missing from the list)
  Evidence: scripts dir listing; `scripts/create-release.sh:20-23`; `scripts/sync-js-vendor-files.sh:10-18`; `composer.json:149`.

---

## 16. Review wave 1 additions (added in review wave 1)

- **FR-DEP-160** — Runtime PHP/extension gate (added in review wave 1; corrected in review wave 2): before any other processing `index.php`, `url.php`, `js/messages.php` and `setup/lib/common.inc.php` shall `die()` with `<p>PHP 7.2.5+ is required.</p><p>Currently installed version is: <ver></p>` when `PHP_VERSION_ID < 70205`. After bootstrap `Common::checkRequiredPhpExtensions()` shall: warn (non-fatal) when `mb_detect_encoding` is missing (mbstring) or `mysqli_stmt_get_result` is missing (mysqlnd); fail fatally (`Core::warnMissingExtension(…, true)` → `Core::fatalError`) when `preg_replace` (pcre), `json_encode` (json), `ctype_alpha` (ctype) or `hash_hmac` (hash) is missing. `checkServerConfiguration()` shall fail fatally when the mbstring extension is loaded and `mbstring.func_overload` is non-empty, and when `ini_get`/`ini_set` are disabled. A missing Composer autoloader (`AUTOLOAD_FILE`, default `vendor/autoload.php`, overridable via `vendor_config.php`) shall abort with 'File … missing or not readable. Most likely you did not run Composer' plus a link to the Git-install manual page. — index.php:14-16, url.php:14-29, js/messages.php:17-35, setup/lib/common.inc.php:9-25, libraries/classes/Common.php:306-353,548-580, libraries/classes/Core.php:193-224
  Verification: PHPUnit/`CommonTest` for the extension probes with `function_exists` stubs; manual run on PHP < 7.2.5 for the die message; `mbstring.func_overload` can only be set on old PHP.
- **NFR-DEP-161** — Directory and file permissions (added in review wave 1): (a) `config.inc.php` must not be world-writable when `$cfg['CheckConfigurationPermissions']` is on and the OS is not Windows; otherwise the request ends with the fatal error 'Wrong permissions on configuration file, should not be world writable!'; (b) the writable temp directory `$cfg['TempDir']` (default `<root>/tmp/`, overridable by `vendor_config.php` `tempDir`) gets per-purpose sub-directories (`twig`, `upload`, …) created with mode `0770` (recursive); if the directory cannot be created or is not writable the feature using it degrades (path `null`: Twig cache disabled, etc.); (c) the upload temp dir falls back from `TempDir/upload` to PHP `upload_tmp_dir` to `sys_get_temp_dir()`, first writable wins; (d) `UploadDir` and `SaveDir` default to empty (disabled); (e) `libraries/cache` is the default cache dir (`vendor_config.php` `cacheDir`). — libraries/classes/Config.php:651-678,1092-1139, libraries/config.default.php:2803-2824, libraries/vendor_config.php:20-71
  Verification: `chmod o+w config.inc.php` on Linux and request `index.php` -> fatal 'Wrong permissions…'; same on Windows -> no error; make `tmp/` read-only and assert Twig cache is disabled but pages still render.
- **DEP-DEP-162** — Packager (vendor) overrides (added in review wave 1; old ID `DEP-162`, renamed in review wave 2; supplies the code-level facts for CON-DEP-112): `libraries/vendor_config.php` shall be the single place where distributors override: `autoloadFile`, `tempDir`, `changeLogFile`, `licenseFile`, `sqlDir`, `configFile`, `customHeaderFile`, `customFooterFile`, `versionCheckDefault` (true), `localePath` (`<root>/locale/`), `cacheDir`, `versionSuffix` (''). The constants `AUTOLOAD_FILE`, `TEMP_DIR`, `LOCALE_PATH`, … are derived from it in `libraries/constants.php`. The file is not user configuration. — libraries/vendor_config.php:1-76, libraries/constants.php:9-50
- **FR-DEP-163** — Build and test commands (added in review wave 1), exact: client build `yarn install` (runs `postinstall` = `yarn run build`) where `build` = `css-compile --style=compressed && css-prefix && css-rtl && js-compile`; separate steps `yarn run css-compile`, `css-lint`, `css-prefix`, `css-rtl`, `js-lint`, `js-compile`; JS tests `yarn test` (= `jest`, config `jest.config.js`: project 'LegacyAdmin', `testEnvironment: jsdom`, tests `test/javascript/**/*.js` (currently `functions.test.js`, `sql.test.js`), setup `test/jest/test-env.js` which exposes jQuery, CommonParams, AJAX and Functions as globals, coverage into `build/javascript/`); PHP `composer install`, `composer phpunit` (`phpunit --color=always`, default suite `unit` = `test/classes/**/*Test.php`, 289 files; suite `selenium` = `test/selenium`, 22 files), `composer phpcs`, `composer phpcbf`, `composer phpstan`, `composer psalm`, `composer test` (all four gates), `composer twig-lint`, `composer update:baselines`. Release: `scripts/create-release.sh <version> <branch> [--tag] [--stable] [--test] [--ci] [--daily] [--no-sign] [--kits] [--compressions]`. — package.json:51-59, jest.config.js:3-26, test/jest/test-env.js:1-10, composer.json:133-150, phpunit.xml.dist:1-45, scripts/create-release.sh:20-90
- **FR-DEP-164** — Translation build pipeline (added in review wave 1): translations live in `po/<code>.po` (95 files) with template `po/legacyadmin.pot`; `scripts/generate-mo [--quiet] [<code>]` shall compile each to `locale/<code>/LC_MESSAGES/legacyadmin.mo` using GNU `msgfmt --check` (so gettext tools are a build prerequisite; any failing file makes the script exit non-zero); `scripts/remove-incomplete-mo [threshold]` shall delete .mo files whose translation percentage is below the threshold (default 40) and write `libraries/language_stats.inc.php`; the English-only kit has no locale directory and `LanguageManager` then offers only `en`. `scripts/update-po`, `scripts/lang-cleanup.sh` and `scripts/locales-contributors` maintain the sources. — scripts/generate-mo:1-40, scripts/remove-incomplete-mo:12-40, scripts/create-release.sh:508-512, libraries/classes/LanguageManager.php:751-770
- **FR-DEP-165** — Release packaging steps (added in review wave 1): the release script shall refuse versions outside series 5.2, derive the minimum PHP version from `composer.json` (`"php"` constraint) and run `composer config platform.php <min>`, `composer update --no-dev`, `cleanup_composer_vendors` (remove tests/docs of dependencies), `composer dump-autoload --optimize` (also removing excluded files from class maps), optionally commit `composer.lock`, `yarn install --production`, `generate-mo`/`remove-incomplete-mo`, strip `.git*` metadata, and then build kits `all-languages`, `english`, `source` in compressions `zip-7z`, `txz`, `tgz`, signing each unless `--no-sign`. It must not run as CGI. — scripts/create-release.sh:8-24,152-265,508-512,537-612
- **FR-DEP-166** — Test bootstrap and fixtures (added in review wave 1): `test/bootstrap-dist.php` shall define `ROOT_PATH`/`TEST_PATH` if absent (TEST_PATH overridable for Debian), set `precision=14`, `E_ALL` and timezone UTC; test PSR-4 namespaces are `LegacyAdmin\Tests\` -> `test/classes` and `LegacyAdmin\Tests\Selenium\` -> `test/selenium/` (autoload-dev); fixtures in `test/test_data`, stubs in `test/stubs`; the nightly PHP variant is `test/phpunit-php-nightly.xml`. — test/bootstrap-dist.php:1-28, composer.json:37-42
- **CON-DEP-167** — Snapshot completeness constraint (added in review wave 1): the analysed tree contains none of the dotfiles normally present in a Git checkout except `.rtlcssrc.json` (no `.htaccess`, `.eslintrc*`, `.stylelintrc*`, `.editorconfig`, `.github/` workflows, `.gitignore`), no `vendor/`, no `node_modules/`, no compiled `js/dist` or `themes/*/css`, and no `locale/*.mo`. Any re-implementation shall not assume these artefacts exist and shall define them explicitly (see FR-DEP-104, FR-DEP-155, SEC-DEP-031). — directory listing of repository root, js/dist, themes/pmahomme/css

---

## Coverage

| Category | Requirement IDs |
|---|---|
| Product identity & versioning | CPT-DEP-001–004, FR-DEP-002 |
| PHP platform & extensions | FR-DEP-010–012, NFR-DEP-016 |
| Integration points (captcha/2FA/PDF) | INT-DEP-013–015 |
| Database support matrix | FR-DEP-020–021, DATA-DEP-022, FR-DEP-023, CPT-DEP-024, INT-DEP-025 (corrected in review wave 1: types of 024/025 fixed) |
| Web server / browser | FR-DEP-030, FR-DEP-033, SEC-DEP-031–032 |
| Installation | FR-DEP-040–045, INT-DEP-047 |
| Setup wizard | FR-DEP-045, SEC-DEP-046 |
| Configuration deployment | DATA-DEP-050, FR-DEP-051, SEC-DEP-052–053, CON-DEP-054, FR-DEP-055–056, DATA-DEP-057, INT-DEP-058 |
| Configuration storage schema | FR-DEP-060, DATA-DEP-061–062, FR-DEP-063, DATA-DEP-064, INT-DEP-065, DATA-DEP-066 |
| Upgrade / migration (SSE) | FR-DEP-070–072, CPT-DEP-073–074, DATA-DEP-075 |
| Docker / reverse proxy | INT-DEP-080 (code hooks), INT-DEP-081–082 (retired) |
| Composer dependencies | DEP-DEP-090–094, FR-DEP-095, DEP-DEP-096 |
| Node/Yarn build pipeline | DEP-DEP-100–103, FR-DEP-101, FR-DEP-104, CPT-DEP-105 |
| Licensing | CON-DEP-110–113, CPT-DEP-114 |
| Documentation links & docs-related code | CPT-DEP-120–123, 127, 128, 131 (rewritten); CPT-DEP-124–126, 129, 130 (retired) |
| Security hardening | SEC-DEP-140–146, SEC-DEP-041–046, SEC-DEP-154 |
| Dev/test environment | FR-DEP-150–153, FR-DEP-155, NFR-DEP-156, FR-DEP-157 |
| Review wave 1 additions (IDs as renamed in wave 2) | FR-DEP-160, NFR-DEP-161, DEP-DEP-162, FR-DEP-163, FR-DEP-164, FR-DEP-165, FR-DEP-166, CON-DEP-167 |

Total after review wave 2: 97 requirement IDs (unchanged; wave 2 renamed or retyped 12 IDs and retired 8: INT-DEP-081, INT-DEP-082, CPT-DEP-073, 124, 125, 126, 129, 130). Types used: FR, NFR, SEC, DATA, DEP, CPT, INT, CON (all defined in README.md; `DEV` removed). 15 requirements carry a `Verification:` line. (corrected in review wave 2)

## Gaps & open questions

1. (resolved in review wave 2: doc/-only, no code counterpart; dropped) **TempDir guidance cross-reference** (formerly a doc/config.rst formatting artifact).
2. **No `.htaccess` files in release tree** — `test/README.rst:4` assumes `.htaccess` protection in `test/`, `libraries/`, `templates/`, but the Apache-specific files are absent from this distribution snapshot. Open question: are they generated by distro packaging only, or lost in packaging? Verify against the official tarball manifest.
3. (resolved in review wave 1: stale item; no action) **Java/JS "DAV" structure** — the prompt referenced "config.rst dav structure"; no WebDAV feature exists in LegacyAdmin 5.2.3 (no such route or class in `libraries/`). Item closed.
4. **`package.json` name is `legacyadmin` but is `private`** — packages are not published to npm (evidence `package.json:8`); documents don't cover reproducible-distro npm choices. Open: policy for vendoring JS libs (`scripts/sync-js-vendor-files.sh`) vs `yarn.lock` — cite both.
5. **Suggested vs required extension mismatch** (corrected in review wave 1) — `composer.json` hard-requires `ext-hash, iconv, json, mysqli, openssl, pcre, xml`; the runtime probe in `Common::checkRequiredPhpExtensions()` additionally tests `ctype` (fatal), `mbstring` and `mysqlnd` (warnings) and tests pcre/json/hash by function presence (fatal) — see FR-DEP-160. `session` and `SPL` are not probed anywhere. `iconv`, `openssl` and `xml` are declared but not probed at runtime.
6. **Docker image sources are external** — the Dockerfile/compose live in the `legacyadmin/docker` repo, not in this tree; requirements INT-DEP-080..082 are behavior contracts only.
7. **`test/javascript` file count** — recursive listing returned 2 items, suggesting a sparse tree in this snapshot (transform file likely under `test/jest/file-transformer.js` per `jest.config.js:17`). Verify upstream.
8. **`tempy`/`vendor/` absent from snapshot** — `composer.lock` is present but `vendor/` does not exist in the checked-out tree; runtime requirements DEP-DEP-090 assume installation via Composer as docs specify (FR-DEP-044 covers the missing-autoloader failure path).
9. (resolved in review wave 2) **Legacy naming**: the legacy magic-quotes/PHP 5.3 upgrade hints were doc/-only; no such code exists (see FR-DEP-071). Nothing to carry over.
10. **MySQL version upper bounds** — code gives a lower bound only (`MysqlMinVersion` 5.5.0, FR-DEP-020; the MariaDB minimum is not distinguished in code); MariaDB 11.5 Y2K38 note (`ChangeLog:18`) hints the support matrix implicitly grows; define an explicit upper-bound testing policy in the re-spec.
11. (added in review wave 2) **Wave-1 evidence error found** — the cookie-encryption requirements cited `Crypto/Crypto.php`, which only implements URL-query encryption; cookie encryption is `AuthenticationCookie::cookieEncrypt/Decrypt`. 05-security-auth.md already describes the correct key resolution and agrees with SEC-DEP-052.
