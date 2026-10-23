# 10 — Conflicts and Open Decisions

Conflicts between the **observed legacy behaviour** of LegacyAdmin 5.2.3 (as recorded in files 00–09) and the **needs of DBLoom**. The SPEC describes what LegacyAdmin does; it does not decide what DBLoom must do. Each conflict below ends with a decision, and each legacy requirement it touches gets a disposition once decided: **retain**, **replace** or **drop**.

Evidence is code evidence from the LegacyAdmin source tree (`libraries/classes/...`), as verified during the review waves. Items marked *recommendation* are proposals by the reviewing engineer and have **not** been decided by the project owner.

## Status legend
- **DECIDED** — decision taken by the project owner.
- **OPEN** — decision pending; a recommendation may be given.
- **SPEC-FIX** — not a conflict but a correction the SPEC still needs.

## Index

| ID | Title | Status |
|---|---|---|
| CF-001 | Per-server configuration storage vs multi-server usage | OPEN |
| CF-002 | Ctrl+K console shortcut toggles twice | DECIDED |
| CF-003 | Two-factor authentication is opt-in per user and depends on config storage | OPEN |
| CF-004 | WebAuthn has two server implementations with different guarantees | OPEN + SPEC-FIX |
| CF-005 | TOTP verification window (±8 steps) | OPEN |
| CF-006 | Arbitrary-server login (`AllowArbitraryServer`) | OPEN |
| CF-007 | Implicit, order-dependent storage lookup and manual setup | OPEN |
| CF-008 | Preferences fall back to session-only storage | OPEN |
| CF-009 | Login model: legacy-style direct login vs two-step account login | DECIDED (both modes) |
| CF-010 | Source of target-server credentials in account mode | DECIDED (A and B now; C and D later) |
| CF-011 | User management and registration in account mode | DECIDED (admin-created + invite link only) |

---

## CF-001 — Per-server configuration storage vs multi-server usage
**Status:** OPEN  
**Driver:** Primary usage scenario of the project owner: connecting to **multiple servers via the login interface**, entering server, username and password.

**Legacy behaviour**
- Persistent state (preferences, history, bookmarks, designer layouts, tracking, recent/favourite tables, etc.) lives in the `la_*` tables of a "configuration storage" database on the **target server** (`sql/create_tables.sql`; keys `pmadb` and one per table in `config.sample.inc.php:34-65`).
- The storage connection is a separate connection: with `controluser` configured it uses that account (`controlhost` if set, otherwise the login host); without it, it opens a second connection with the **logged-in user's own credentials** (`Common.php:602-631`, `Config.php:1255-1300`).
- With `AllowArbitraryServer`, the login host is whatever the user typed, so the storage is looked up **on each typed server** (`AuthenticationCookie.php:305,407`).
- Rows of per-user tables are keyed by MySQL `username` (e.g. `la_userconfig` primary key `username`, `la_history` index on `username`); some tables are shared per database (e.g. `la_table_coords` keyed by `db_name`, `table_name`, `pdf_page_number`).
- Without storage, preferences are kept in `$_SESSION['userconfig']` (`UserPreferences.php:82-93`).

**Conflict**
Most servers reached through a free-form login will not have the storage, and the user often cannot or will not create it (it needs `CREATE` rights; error 1044 handling in `Relation::createPmaDatabase()`). Persistent preferences, bookmarks, history and tracking are then unavailable, and preferences last only for the session. (Corrected after wave 3: the Designer is not simply unavailable; its layouts fall back to browser IndexedDB. Favourites, NavigationWidth, Console options, monitor charts and the saved query also use browser storage. See DATA-CFG-108 ff. in `01-configuration.md`, `reviews/wave3-config-storage.md`.)

**Options**
1. Keep legacy: storage on each target server.
2. DBLoom-owned store, separate from managed servers, keyed by DBLoom user and by connection profile.
3. Hybrid: DBLoom-owned store by default; optional "store on target server" mode for features that must be visible to other clients; optional import of existing `la_*` data.

**Recommendation (not decided):** option 3 with the DBLoom-owned store as default, so DBLoom works with read-only accounts and writes nothing to target servers.

**Open sub-decisions**
- Is the DBLoom user the MySQL username, or a separate DBLoom login? (Answered by CF-009: both models are supported, one per deployment. Direct mode keeps state in a DBLoom-owned store keyed by target and username. Account-mode storage details are still open.)
- Where does the DBLoom store live: local file or DBLoom-owned database?
- Do connection profiles (saved servers) exist, in addition to free-form login?

**Affected legacy requirements:** configuration-storage and preference requirements in `01-configuration.md` (CFG), `03-database-table.md` (bookmarks, tracking, designer, central columns, history), `02-server.md` (user groups, navigation hiding), `05-security-auth.md` (2FA persistence), and the ER view in `09-diagrams.md`. Dispositions to be assigned once decided.

---

## CF-002 — Ctrl+K console shortcut toggles twice
**Status:** DECIDED  
**Legacy behaviour:** Outside input fields, `Ctrl+K` runs the Ctrl+K branch (toggle) and falls through to the plain `k` branch, which toggles the console a second time, so the net effect is no change. Inside inputs only one toggle happens (`js/src/shortcuts_handler.js:56-72`, `libraries/classes/Header.php:358-359`).  
**Decision:** DBLoom shall toggle the console exactly once on `Ctrl+K` in all contexts. Deliberate deviation; the legacy double toggle is treated as a defect.  
**Recorded in:** FR-UIX-111 (`07-frontend.md`), `00-overview.md` open-decisions note.  
**Disposition:** replace.

---

## CF-003 — Two-factor authentication is opt-in per user and depends on config storage
**Status:** OPEN  
**Legacy behaviour**
- No global switch: each user enables a backend on the preferences page `/two-factor` (`libraries/routes.php:141`, `Controllers/Preferences/TwoFactorController.php`). Nobody has 2FA by default, and an administrator cannot require it.
- Settings are saved per user via `UserPreferences`. They are writable only when the preference type is `db`, i.e. with configuration storage (`TwoFactor.php:69`: `writable = (config['type'] === 'db')`). Without storage they exist only in the session.
- Backend availability depends on optional packages (`TwoFactor.php:129-155`): the authenticator-app backend needs `pragmarx/google2fa-qrcode`, `bacon/bacon-qr-code` and `XMLWriter` or `imagick`; `WebAuthn` is always listed; `key` (U2F) needs `code-lts/u2f-php-server`; `simple` is debug-only (`$cfg['DBG']['simple2fa']`).
- At login `AuthenticationPlugin.php:333` calls `TwoFactor::check()`; the result is cached in `$_SESSION['two_factor_check']`.

**Conflict:** Depends on CF-001 (where 2FA settings can be persisted) and offers no way to enforce 2FA.  
**Open decisions:** opt-in only, or add an administrator policy to require 2FA for all users or privileged accounts? Which backends are mandatory?  
**Recommendation (not decided):** persist 2FA settings in the DBLoom-owned store (CF-001) and support an enforcement policy.

---

## CF-004 — WebAuthn has two server implementations with different guarantees
**Status:** OPEN + SPEC-FIX  
**Legacy behaviour:** `Plugins/TwoFactor/WebAuthn.php:64` selects the server with `class_exists(Webauthn\Server::class) ? new WebauthnLibServer(...) : new CustomServer()`. With `web-auth/webauthn-lib` installed (`composer.json`, declared as optional, `^3.3.2`), validation is delegated to the library. Otherwise LegacyAdmin's own `CustomServer` is used, which does **not** verify the assertion signature or the sign count; its origin check compares host only. The library is not present in the analysed source tree, so its checks could not be verified.

**SPEC-FIX:** FR-SAU-059 and the 2FA flow note in `09-diagrams.md` §9.16 describe "no signature check" as a property of WebAuthn in general. It applies to the `CustomServer` fallback only. They should be rewritten as two variants plus the selection rule, with the library variant marked unverified.  
**Open decision:** DBLoom shall use a maintained library and **require** signature and sign-count verification (recommendation, not decided). The legacy fallback should not be copied.

---

## CF-005 — TOTP verification window (±8 steps)
**Status:** OPEN  
**Legacy behaviour:** `Plugins/TwoFactor/Application.php:42` sets `setWindow(8)`: a code is accepted within ±8 time steps. With the library's default 30 s step this is about ±4 minutes. The step length is set inside the Google2FA library, which is not in the analysed tree, so the 30 s value is an assumption.  
**Conflict:** A window this wide weakens the second factor; a window of ±1 is the usual choice.  
**Open decision:** window size for DBLoom. Recommendation (not decided): ±1 step, with a stated tolerance requirement.

---

## CF-006 — Arbitrary-server login (`AllowArbitraryServer`)
**Status:** OPEN  
**Legacy behaviour:** With `$cfg['AllowArbitraryServer']` the cookie-auth login page has a free-text server field (`AuthenticationCookie.php:180,305,407,425,538`). The option defaults to `false` (verified in wave 3). Two further findings from wave 3: with the option on and `controlhost` empty, the `controluser` credentials are sent to the host the user typed; and a failed control connection silently falls back to the user's own login. Both are security-relevant for DBLoom (see SEC-TGT-030 to 033).  
**Driver:** The project owner's usage (CF-001).  
**Conflict:** The capability is central to the owner's scenario, but it allows the application host to be directed at arbitrary network addresses (server-side request risk) and it complicates storage and credential handling.  
**Open decisions:** saved connection profiles, free-form connections, or both; access policy for arbitrary targets (allow/deny lists of hosts and ports, network restrictions).

---

## CF-007 — Implicit, order-dependent storage lookup and manual setup
**Status:** OPEN  
**Legacy behaviour**
- The storage database is chosen in this order (`ConfigStorage/Relation.php:1798-1832`): configured `pmadb`; else the default name `legacyadmin`; else the **currently selected database** if it contains valid `la_*` tables (then `pmadb` is set to it, line 1683).
- Setup is manual and split across three places: import `sql/create_tables.sql`, grant privileges (commented in the script), and uncomment the matching keys in `config.inc.php`. The relations check page (`CheckRelationsController`) can create the database and tables (`createPmaDatabase`, `fixPmaTables`) when the account has `CREATE` rights; `config.inc.php` is never written after in-app creation (confirmed in wave 3), so the keys must always be added by hand.
- Nothing tells the user which step is missing apart from the "session only" banner (CF-008).

**Conflict:** Behaviour depends on implicit discovery order and manual administration; it is hard to specify, test and operate.  
**Open decision:** DBLoom should define its schema creation, schema-version check and migration explicitly (recommendation, not decided). Superseded in large part by the decision on CF-001.

---

## CF-008 — Preferences fall back to session-only storage
**Status:** OPEN  
**Legacy behaviour:** Without configuration storage the preference pages show: "Your preferences will be saved for current session only. Storing them permanently requires LegacyAdmin configuration storage." (`templates/preferences/header.twig:58-62`). Preferences are held in `$_SESSION['userconfig']` (`UserPreferences.php:82-93`). Browser storage is not an automatic fallback for preferences (INT-CFG-083 covers import/export only), but other UI state does use it: favourites, NavigationWidth, Console options, monitor charts and the saved query (confirmed in wave 3).  
**SPEC-FIX:** The "session only" notice is not yet recorded as a requirement in `01-configuration.md`.  
**Open decision:** depends on CF-001. If DBLoom owns its store, the session-only fallback may be unnecessary; otherwise the notice remains a requirement.

---

## CF-009 — Login model: legacy-style direct login vs two-step account login
**Status:** DECIDED (project owner): DBLoom shall support **both** login modes.

**Legacy behaviour:** The login screen is the database login. The user enters server, username and password once, and the session is tied to that server; preferences, history and 2FA attach to the MySQL username on that server (`AuthenticationCookie.php`; CF-001, CF-003).

**Decision**
- **Direct mode** (legacy style): the user types server, username and password at the login page and goes straight to work. No DBLoom account exists. Intended for users who want the LegacyAdmin way of working.
- **Account mode** (two-step, modern): the user first logs in to DBLoom (passkey or password, second factor), then connects to one or more target servers from within the session. Intended for security-conscious deployments and multi-server work.

**Consequences recorded**
- Features that need a DBLoom identity (enforced 2FA, saved connection profiles, cross-server preferences, audit by DBLoom user) are available in account mode only. In direct mode, 2FA is available only if provided outside DBLoom (for example by a reverse proxy).
- Security properties that do not depend on the mode apply to both: target credentials never in a client cookie (SEC-TGT-021), target host policy (SEC-TGT-030–033), CSRF, CSP, SQL handling.
- Requirements: SEC-TGT-010, SEC-TGT-018, SEC-TGT-019 in `11-target-security.md`.

**Further decisions (project owner)**
- **Mode selection is per deployment, and exactly one mode is active at a time.** A deployment never offers both modes at once, and users do not choose a mode. (Recommended default, not decided: account mode, with direct mode enabled explicitly and shown with a warning that it lacks DBLoom-level protections.)
- **State in direct mode lives in a DBLoom-owned store, keyed by target server and username** (not session-only). Interpretation recorded by the reviewing engineer from the owner's answer; to be confirmed. This also settles the direct-mode part of CF-001 and CF-008.
- **Still open:** how the target server is identified for the key (the string typed by the user vs a normalised host and port), and what the state store is (file or database).

---

## CF-010 — Source of target-server credentials in account mode
**Status:** DECIDED (project owner): options A and B are supported in the first release; C and D are deferred.

**Legacy behaviour:** The user types server, username and password at the login page; the credentials are kept (encrypted) in a cookie (`AuthenticationCookie.php`; CF-009). There are no administrator-defined connection profiles other than `$cfg['Servers']` entries in the configuration file.

**Decision (account mode)**
- **A — entered per connection:** the user supplies their own database username and password after logging in to DBLoom; kept only in server-side session memory.
- **B — saved personal profile:** the user's own credentials are stored for that user, encrypted (never plain), and decrypted for use.
- **C — pre-configured shared profile (DEFERRED to the future, FUTURE.md FU-005; not part of the first release, owner decision):** an administrator defines a connection profile (host, port, optional default database, TLS settings, service-account username and password). Users select it by name and never see the password; DBLoom injects it server-side.
- **D — short-lived credentials from a secrets manager or cloud IAM:** deferred to a later release.

**Consequences recorded**
- Stored database passwords must be reversible (they are sent to the server), so they are encrypted with authenticated encryption, not hashed; security depends on key management (SEC-TGT-022).
- With C the database sees the service account, so per-user database privileges and database-side audit are lost; DBLoom roles and the DBLoom audit log carry the control (SEC-TGT-025).
- The list of allowed targets is a separate administrator policy (SEC-TGT-030).
- Direct mode is unaffected: the user always supplies credentials at the login page.

**Deferred:** shared-profile master key and shared profiles (FUTURE.md FU-005); personal profiles decided (vault passphrase + recovery key, SEC-TGT-026) — `OPEN.md` item 14; audit attribution and who may use which shared profile — `OPEN.md` item 15.

---

## CF-011 — User management and registration in account mode
**Status:** DECIDED (project owner).

**Legacy behaviour:** LegacyAdmin has no user management of its own. Identity is the database account entered at login (CF-009); account administration is done on the database server (privileges, user accounts in `02-server.md`).

**Decision (account mode only; direct mode has no DBLoom users)**
- At first deployment the administrator configures DBLoom, chooses the login mode and sets a password. **The first administrator is also the first user.**
- Users are created in exactly two ways: **(1) admin-created accounts**, where the administrator enters a username and password, and **(2) invite links**.
- **Registration with approval and open registration are not part of DBLoom.**

**Consequences recorded**
- No public registration form exists, which removes a public attack surface.
- An administrator who sets a password knows it. **Decided:** the password is temporary and the user must change it at first login (SEC-TGT-103).
- **Decided:** invitation and recovery links are handed over manually by the administrator; DBLoom sends no email (FR-TGT-104, FR-TGT-105). This removes any SMTP dependency.
- Still proposed, not decided: setup token, invite lifetime and token strength, password policy (`OPEN.md` item 17).
- Requirements: DEP-TGT-100 to NFR-TGT-107 in `11-target-security.md`.

---

## Maintenance
- When a conflict is decided, change its status, record the decision and rationale, and assign a disposition (retain / replace / drop) to each affected legacy requirement in files 01–09.
- New conflicts get the next free `CF-nnn` ID. Do not renumber.
- Known unverifiable items (vendored libraries absent from the tree) are listed in the review logs under `reviews/`.
