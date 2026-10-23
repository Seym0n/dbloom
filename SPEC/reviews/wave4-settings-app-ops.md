# Wave 4 - Settings classification: application, UX and operations

Reviewer role: requirements/security engineer. Status: **PROPOSED**, not approved. Basis: `README.md`, `10-conflicts.md`, `OPEN.md` (item 18), `FUTURE.md`, `11-target-security.md` (sections 9-14), legacy `01-configuration.md`, `07-frontend.md`, `08-deployment-docs.md`. Only the spec was read for legacy directives; the defaults quoted for legacy directives (for example `SendErrorReports` = `ask`, `VersionCheck` = on) come from the reviewer's knowledge of LegacyAdmin 5.2 and were not re-verified in the source during this wave.

Setting IDs `APP-nn` are local to this review (not spec IDs). "Floor/ceiling" always means: an `.env` value that bounds what the UI may set. Direction rule used below: a change is "tightening" if it reduces exposure or increases protection; for retention periods that means longer, for lifetimes shorter.

## Verdict vocabulary
- **ENV** - `.env` only (startup, restart, not editable in UI).
- **UI** - administrator UI only (account mode); in direct mode the same setting comes from `.env`.
- **UI+F/C** - UI within an `.env` floor/ceiling (SEC-TGT-142), with step-up (SEC-TGT-143) if security-relevant.
- **USER** - user preference within admin limits (stored per user; direct mode: store keyed by target and username, DATA-TGT-094).
- **BOTH** - `.env` provides the default or hard override, UI changes it inside limits.
- **DROP** - do not carry over from legacy.

General principles derived from the what-if runs (they explain most verdicts):
- P1 Read-time clamp: the effective value is `clamp(stored, ENV floor, ENV ceiling)` computed on every read, not only on write. Someone who edits the store directly (SQL injection into the store, a DBA, a restored old backup) still cannot go outside the `.env` limits. If `.env` is tightened later, stored values outside the new limits are clamped and one audit/log entry is written; startup does not fail.
- P2 Anything that widens the attack surface of the browser (CSP, outbound calls, new code paths, file system access, pre-login content) is `.env`; a stolen administrator session must not be able to turn an XSS or a phishing page persistent.
- P3 Anything needed before the store is readable (store location, secrets, log destination, mode, setup) is `.env` by necessity.
- P4 Anything an end user plausibly wants differently (language, theme, time zone, shortcuts, console layout) is a user preference with an admin default; admin policy only bounds the allowed set.
- P5 Timers that protect against lockout (auto-revert, maintenance expiry) must live in the store with an absolute deadline, not in instance memory, so a restart or a second instance cannot lose them.

---

## 1. Classification table

| ID | Setting | Verdict | Decisive what-if and rationale | PROPOSED values | Depends on |
|---|---|---|---|---|---|
| APP-01 | DBLoom store location and type (file path or database URL) | **ENV** | (3) The store cannot hold its own address; also (1) an admin who can repoint it can swap in an attacker-controlled store with a known admin. | Env `DBLOOM_STORE_URL` (`sqlite:/path` or `postgres://...`). Path must be outside any served directory, directory mode 0700. | OPEN 12 (file vs database), OPEN 13 |
| APP-02 | Store credentials (DB user/password, TLS to store, file mode) | **ENV** (secret, support `_FILE` variant) | (6) A secret that is needed to open the store cannot come from the store; (1) UI-editable would let a thief redirect writes. Store DB user must be least-privilege, separate from any target. | Env or file (`DBLOOM_STORE_PASSWORD_FILE`). TLS to a remote store required when non-loopback. | OPEN 12 |
| APP-03 | Application master secret (source for MAC keys of SEC-TGT-111/118/082, CSRF, cookie/state signing, encryption of reversible store fields such as TOTP seeds) | **ENV** (secret, key ring) | (6)+(3) Must exist before login/store; (5) all instances must hold the same ring or tokens issued by one fail on the other. | At least 256 bits. Ring: `current` plus up to N `previous` keys (rotate without logging users out). Purpose keys derived with HKDF using a fixed purpose label, so a leak of one derived key does not expose others. Missing/placeholder = refuse start (SEC-TGT-081). | Stack crypto library (SEC-TGT-080) |
| APP-04 | Session identifier / "session secret" | **no setting** | (6) With server-side sessions (SEC-TGT-040) the session id is a random opaque value that needs no signing secret; a "session secret" setting would suggest a cookie that carries state. See disagreement D1. | Session id >= 128 bits from CSPRNG. | SEC-TGT-040 |
| APP-05 | Master key for shared profiles | **deferred** | Decided (FU-005). When introduced it is ENV (never in the store, SEC-TGT-027). Not classified further. | - | FU-005 |
| APP-06 | One-time setup token (supply or generate) | **ENV** (optional supply) / generated at startup otherwise | (3) Setup runs before any admin exists; (1) after setup it must be gone; (5) two instances racing to finish setup need one atomic "setup complete" flag in the store. | 128-bit random, compared in constant time, valid for 60 min after process start, single use, stored only as hash, never printed to a log stream (see D2). | DEP-TGT-100/123 |
| APP-07 | Instance id / cookie names (suffix) | **ENV** | (5) Cookies are not isolated by port: two instances on one host name overwrite each other's `__Host-` cookie. An instance suffix is needed. (1) Name changes log everybody out, harmless but pointless to expose. | Fixed secure prefix `__Host-` (or `__Secure-` if sub-path, D8) is not editable; only the suffix. | SEC-TGT-135 |
| APP-08 | Application log level | **UI+F/C** | (1) Thief sets `debug` to dump data into logs (SEC-TGT-023 risk); (2) typo is harmless. The ceiling prevents debug from the UI. | ENV default `info`; UI range `warn`..`info`; `debug` only through `.env`. Raising above default auto-reverts after 60 min. | - |
| APP-09 | Log destinations, format, rotation (stdout, file path, syslog/OTLP endpoint) | **ENV** | (3) Needed at boot; (1) a thief who repoints logs to a remote host exfiltrates log data or blinds the operator. | Default stdout, JSON lines. File: 0600. Remote sink: TLS required. | Deployment model |
| APP-10 | Audit log retention | **UI+F/C** | (1) Thief shortens retention to erase evidence; a floor stops it. (2) Mistyped "1 day" is the worst case without a floor. | Default 365 d, floor 90 d, ceiling 1095 d (ceiling is a privacy/storage-limitation bound, align with legal advice). Changing needs step-up. Maximum store size for audit: ENV. | Legal/retention policy (owner) |
| APP-11 | Audit log access (who may view, export) | **UI (role-based)**, read only | (1) Thief with admin role reads everything: view needs admin plane (SEC-TGT-147), export needs step-up. No delete or edit exists in the UI; deletion only by the retention job. (7) Direct mode: no UI, access is OS/sink level. | Role `auditor` optional (SEC-TGT-061). Audit of audit reads: yes, one entry per export. | Roles (SEC-TGT-061) |
| APP-12 | External audit sink (syslog, SIEM, append-only file) | **ENV** | (1) A tamper-resistant copy is only worthwhile if the admin cannot switch it off. (7) The only audit route that exists in direct mode. | Optional hash chain over records (each carries hash of the previous). | NFR-TGT-090 |
| APP-13 | Error reporting to a third party (legacy `SendErrorReports` ask/always/never; reporting URL) | **DROP** (candidate FUTURE) | (1) Thief enables "always" and every JS/PHP error with URLs, SQL and table names leaves the installation; (9) a user cannot consent on behalf of the organisation. Replace with local error log and an error id shown to the user. | If ever offered: `.env` only, off, fixed destination. | New FU entry if wanted |
| APP-14 | Version check (legacy `VersionCheck`) | **BOTH** | (1) Thief cannot cause harm other than an outbound GET, but outbound reach is egress policy: `.env` decides whether the feature may exist, the UI admin turns it on/off inside that. (7) Direct mode: `.env` only. Air-gapped sites need off. | ENV `VERSION_CHECK=off` default; if `allowed`, UI toggle. URL fixed in code, not a setting. Interval 24 h, timeout 5 s. Request carries nothing but the client IP; compare locally against a static `latest` document. No version string is shown to unauthenticated users (SEC-TGT-132). | Release hosting |
| APP-15 | Usage telemetry | **no feature** | First release has none. (1) Any telemetry switch is an exfil path. | - | - |
| APP-16 | Outbound HTTP proxy (legacy `ProxyUrl`/user/pass) | **ENV** (secret) | (6) Contains credentials; (1) redirecting outbound traffic through an attacker proxy exposes version-check and any future outbound call. | Only used for the fixed outbound calls, never for target-database connections. | - |
| APP-17 | Debug flags (legacy `DBG.*`, `environment`, verbose errors, test backends) | **ENV** | (1) Debug in the UI is a direct way to leak data or switch on a weaker 2FA backend (DEP-TGT-092). | Refuse start with any debug flag when bound beyond loopback unless a second explicit override is set; warn (extend SEC-TGT-125). | - |
| APP-18 | Enabled built-in modules - high risk (server-file import/export, `UploadDir`/`SaveDir`, display transformations that render HTML/links/images, any mode that interprets content) | **ENV** (enable) + UI may disable | (1) Thief enabling server-side file reads or HTML rendering opens file disclosure or XSS (SEC-TGT-071/112). Switching **off** is tightening and is allowed from the UI. | Default all off. Directory paths ENV only. | SEC-TGT-071, 112; OPEN 1 (scope) |
| APP-19 | Enabled built-in modules - low risk (export/import formats such as CSV/SQL/JSON, text-only transformations) | **UI+F/C** | (1) Thief can only disable (annoyance) or enable a format that is in the ENV allowed set; (2) a mistyped disable is recoverable by re-enabling; (8) admins toggle this often. The registry is closed (SEC-TGT-113), so the toggle never loads code. | ENV lists the set the build allows (ceiling); UI selects the subset. Enabling needs no step-up, disabling none; both audited. | Closed registry; scope matrix |
| APP-20 | SQL console / query window available at all | **UI+F/C** | (1) Thief enabling the console widens the SQL surface; ceiling in `.env` decides whether it can ever be on. Individual users still have only their target privileges (SEC-TGT-050). | ENV `CONSOLE_MAX=on/off`; UI default on within it. Read-only mode (SEC-TGT-052) is not touched here. | SEC-TGT-052 decision |
| APP-21 | Default language | **UI** (admin default) + **USER** | (2) Cannot lock anyone out; fall back to English if a language is incomplete. (9) Each user may choose their own. (3) Login page language: from user choice cookie, else `Accept-Language` matched against the available list, else default. | Default `en`. | OPEN 7 (95 languages?) |
| APP-22 | Available languages (legacy `FilterLanguages`) | **UI** within the bundled set | (1) Harmless; (2) never allow an empty list: server rejects it; (8) common admin task. | At least `en` is always enabled. | OPEN 7 |
| APP-23 | Default theme / colour mode | **UI** (admin default) + **USER** | (1) Harmless as long as themes are built-in and closed (no admin-uploaded CSS, P2). (9) User override stored in preferences; dark mode follows OS by default. Legacy `ThemeDefault` per-user persisted (FR-CFG-016/017). | Default `auto`. | OPEN 7 |
| APP-24 | Time zone for display | **UI** (admin default) + **USER** | (4) Does not change stored data: all stored and audit timestamps are UTC (ISO 8601). (2) Wrong zone only misleads display. (9) Users differ. Target connection `time_zone` is a per-connection option, not this setting. | Default `UTC`; users may override. | - |
| APP-25 | Date, time and number formats | **UI** default + **USER** | Same as APP-24. Audit export always ISO 8601 UTC. | Default locale-based. | - |
| APP-26 | Base path / URL prefix | **ENV** | (3) Needed to build every URL and cookie path before anything is read; (4) changing it invalidates cookies and links; (1) a thief changing it breaks all invite links or redirects. | Recommend: sub-path is not supported in the first release (or supported only with `__Secure-` cookies); see D8. Value is part of the public origin (SEC-TGT-126). | SEC-TGT-135 decision |
| APP-27 | Branding text on login page and header (product name, notice text) | **UI+F/C** | (1) Pre-login text is a phishing channel ("call this number to unlock"), so a thief could abuse it; therefore step-up, plain text only, length cap, audit with old/new text. (2) Typo harmless. (7) Direct mode: `.env` (`LOGIN_NOTICE`). | Plain text, no markup, no links, max 300 characters; always escaped. Product version never shown pre-login. | - |
| APP-28 | Logo / custom CSS / custom JS / HTML templates | **ENV** (logo file path only); **DROP** custom CSS/JS/HTML | (1) Uploaded images (SVG) and CSS are XSS/UI-redress vectors and conflict with a strict CSP (SEC-TGT-043). | Logo: raster only, file placed by the operator. | - |
| APP-29 | Maintenance mode | **BOTH** | (1) Thief switches it on: denial of service for ordinary users, but the thief is already an admin; admin plane and CLI are always exempt so the admin can switch it off (lockout rule). (2) Mistyped end time must not lock the owner out. (4) Existing sessions get a banner and are read-only after a grace period. (5) Must be in the store, visible to all instances. (7) Direct mode: `.env` flag (`MAINTENANCE=on`) or CLI. | UI switch with optional absolute end time (auto-off, P5). `.env` flag overrides (forces on). Schema migrations put the instance into maintenance automatically. Health endpoint stays up and reports "maintenance". | - |
| APP-30 | Information banner (non-security notice) | **UI** | (1) Same phishing aspect as APP-27, but shown after login only: plain text, 500 characters. Audit with old/new. (8) Frequent change is expected. | Step-up not required if shown only to authenticated users; required if shown pre-login. | - |
| APP-31 | CSP overrides (legacy `CSPAllow`, `CaptchaCsp*`) | **ENV**, strict default, no overrides in first release | (1) Widening `script-src` or `connect-src` is exactly what turns a stolen session or an XSS into persistence. SEC-TGT-043 demands nonces and no inline; the closed registry (SEC-TGT-113) removes the need for third-party hosts. | If an override is ever needed: ENV, per directive, with a warning (SEC-TGT-125). | - |
| APP-32 | CSP report endpoint / report-only mode | **ENV** | (1) A report URI to an external host leaks blocked URLs; (3) must exist before login; unauthenticated endpoint is a flood risk. | Default: same-origin endpoint, body cap 8 KB, rate limit, reports go to the log only, never into the store. Report-only mode is for rollout, ENV only. Endpoint must be registered in the route registry (SEC-TGT-136) and exempt from CSRF. | - |
| APP-33 | Settings export / import (administrator settings, not secrets) | **UI** export; import **UI+F/C** | (1) Import is a bulk change that must not bypass floors/ceilings or step-up: validate every key, one audit entry per changed key. Export contains no secrets; secrets are masked. | Format versioned JSON; refuse unknown keys. | - |
| APP-34 | Backup and restore of the whole DBLoom store | **ENV** (schedule, destination) + CLI; no UI download | (1) A UI download gives a stolen session the user table, password hashes, encrypted vaults, 2FA seeds and audit. (6) Backup must be restorable only together with the separately kept keys (APP-03). (7) Same in direct mode. | CLI `dbloom backup/restore` needs host access. Restore into a store with different `APP-03` ring: vault data unreadable; documented. Backup retention: operator. | OPEN 12 |
| APP-35 | Export of a user's own state (bookmarks, history, preferences) | **USER** | (9) The user owns it. (1) Thief with a user session can export that user's data only; the vault stays encrypted (SEC-TGT-026). | Excludes stored credentials. | OPEN 13 |
| APP-36 | `TempDir` (uploads in progress, export scratch) and `CacheDir` | **ENV** | (3) File system path needed at boot; (1) a thief who repoints it to a served or shared directory writes files where they are executed or read; legacy notice SEC-CFG-062 shows the risk. | Mode 0700, outside web root and outside static asset dir, own mount recommended, files random-named (SEC-TGT-071), swept hourly, size cap `.env`. Never inside the store directory. | Stack (upload handling) |
| APP-37 | Health endpoint (path, enabled, readiness detail) | **ENV** | (1) Detail endpoints reveal version/config; (3) used by orchestrators before login; (5) every instance answers for itself. Contents fixed by code, not configurable. | Liveness: `{"status":"ok"}`, nothing else, fixed path. Readiness (store reachable, migration state) only loopback or admin session (SEC-TGT-132). Probe sources need their own ENV allow-list because of D6. | SEC-TGT-129/132 |
| APP-38 | Step-up window and auto-revert period (parameters of SEC-TGT-143/144) | **ENV** | (1) If the UI could lengthen them, a thief would extend the window or the revert time. | Step-up window 5 min (range 1-15). Auto-revert 3 min (range 1-10). | OPEN 18 |
| APP-39 | The floors and ceilings themselves | **ENV** | They are the root of the UI rules (SEC-TGT-142); editable limits would be circular. | One `.env` key per limited setting with documented defaults. | OPEN 18 |
| APP-40 | Notice thresholds and "new location" definition (FR-TGT-149) | **UI+F/C** | (1) Thief raises thresholds to hide a brute-force; floor on sensitivity. (2) Too low = noise, recoverable. | Default: 10 failures in 10 min per account or address; ceiling 20. "New location" = first login from an IP /24 (IPv4) or /48 (IPv6) not seen in the last 90 days. | OPEN 18; no email (CF-011) |
| APP-41 | Retention limit of per-user history/bookmarks in the store | **UI+F/C** (admin limit) + **USER** (own value inside it) | History holds SQL text with literal data. (1) Raising retention is loosening. (9) User may shorten. (7) Direct mode: ENV limit. | Default 90 d / 1000 entries per user; ceiling 365 d / 5000. | OPEN 13, DATA-TGT-094 |
| APP-42 | Disable shortcut keys (legacy `DisableShortcutKeys`) | **USER** | No security effect. Users with screen readers or conflicting browser shortcuts need it (character-key shortcuts must be switchable, WCAG 2.1.4). Admin cannot know. Ctrl+K toggles once (CF-002). | Default on; admin may set the default only. | - |
| APP-43 | Console options (legacy `Console`: StartHistory, AlwaysExpand, CurrentQuery, EnterExecutes, DarkTheme, Mode, Height, GroupQueries, OrderBy, Order) | **USER** | Pure presentation of the user's own session. Whether the console exists is APP-20. | Admin default only. | OPEN 7 |
| APP-44 | Temporary admin session secrets, session cookie attributes (HttpOnly, Secure, SameSite) | **no setting** | Fixed by SEC-TGT-040; making them configurable only creates insecure choices. | - | - |
| APP-45 | Login mode, public origin, bind, TLS, proxies, allowed hosts | **ENV** (already decided) | Listed for completeness; classified in other waves/DEP-TGT-140. | - | - |

---

## 2. What-if matrix

Cells are short on purpose. Numbers refer to the nine cases: (1) attacker holds an admin session; (2) admin mistypes; (3) needed before store/login exists; (4) restart / existing sessions; (5) several instances; (6) secret; (7) direct mode; (8) non-technical admin changes often; (9) user wants own value. "n/a" = not applicable. "ok" = no problem found.

### 2.1 Store and secrets

| Setting | (1) Attacker with admin session | (2) Mistyped, worst case, recoverable? | (3) Chicken-and-egg | (4) Restart / sessions | (5) Multi-instance | (6) Secret? | (7) Direct mode | (8) Frequent change | (9) User value |
|---|---|---|---|---|---|---|---|---|---|
| APP-01 store location/type | Could repoint to a hostile store with a known admin: so not editable. | Start fails or empty store appears (setup reopens! must need token and loopback). Recoverable only by fixing `.env`. | Yes, root of the problem: only `.env`/env can hold it. | Restart needed. Sessions live in store or memory: moving store drops them. | All instances must point at the same store; file store (SQLite) does not work across hosts (D5 / OPEN 12). | The URL may embed a password: treat as secret. | Same, `.env`. | No. | n/a |
| APP-02 store credentials | Not editable. | Store unreachable: fail closed, readiness fails, health says down. | Yes. | Restart. | Same credentials or per-instance users. | Yes: `_FILE` support, never logged. | Same. | No. | n/a |
| APP-03 master secret / ring | Not editable; also never shown (masked). | Placeholder or wrong key: refuse to start; wrong key after change breaks tokens and encrypted fields (TOTP seeds) - **worst outcome: 2FA enrolment data unreadable**; mitigate by key ring and a startup self-test that decrypts a canary record. | Yes. | Rotation: new key becomes `current`, old kept as `previous`; sessions survive. | Must be identical on all instances or tokens fail randomly. | Yes (SEC-TGT-081). | Needed too (MAC for client state, CSRF). | Rare; rotation procedure documented. | n/a |
| APP-04 session secret | Nothing to steal if server-side sessions. | n/a | n/a | Sessions in store survive restart (decision needed). | Shared session store needed or sticky routing. | no | Same. | n/a | n/a |
| APP-06 setup token | Gone after setup; thief cannot re-run setup. | Lost token: restart generates a new one while setup is open. After setup: use CLI reset, not setup. | Yes: exists before any admin. | Token valid only for this process lifetime (60 min). | Atomic "setup complete" in store; second instance must refuse. | Yes: never in log stream (D2). | No setup in direct mode; the mode itself is `.env`. | Once. | n/a |
| APP-07 instance id / cookie suffix | Not editable. | Colliding suffix: sessions of two instances overwrite; rare. | Needed to read the cookie. | Change logs everyone out. | Distinct per deployment, **same** across instances of one deployment (so any instance can read the cookie). | no | Same. | no | n/a |

### 2.2 Logging, audit, outbound, debug

| Setting | (1) | (2) | (3) | (4) | (5) | (6) | (7) | (8) | (9) |
|---|---|---|---|---|---|---|---|---|---|
| APP-08 log level | Sets debug to leak data: UI cannot exceed `info`; change audited, reverts after 60 min. | Too quiet (`warn`): lose diagnostics; UI recovers. Too loud cannot happen from UI. | Initial value from `.env` before store. | Applies live, no restart; reverts. | Value from store with 15 s cache; instances may differ briefly. | no | `.env` only; restart to change. | Yes, when troubleshooting; time-boxed raise fits. | no |
| APP-09 log destinations | Not editable (would blind or exfiltrate). | Unwritable file: fall back to stdout and warn; never stop auditing silently. | Yes. | Restart. | Each instance writes its own; include instance id. | Sink credentials secret. | Same. | No. | no |
| APP-10 audit retention | Cannot shorten below floor 90 d; change needs step-up and is itself audited. | "1" instead of "365": rejected by floor. Over-long: ceiling. | Initial from `.env`. | Retention job picks up on next run; no restart. | Retention job must run once (store-level lock), not per instance. | no | `.env`; no UI. | Rare. | no |
| APP-11 audit access | Reads all: admin plane only, export needs step-up and is logged; no delete route. | n/a | Needs store. | Live. | Same store. | Content must contain no secrets (SEC-TGT-023). | Sink/file at OS level. | Occasional. | A user may see own events? Open question Q9. |
| APP-12 external sink | Cannot disable. | Sink down: buffer to local file, alert on admin page. | Yes. | Restart. | Per instance. | Credentials secret. | Only audit route. | No. | no |
| APP-13 error reporting | Would exfiltrate data: no UI switch exists. | n/a | n/a | n/a | n/a | n/a | n/a | n/a | Users must not be asked (no per-user consent for org data). |
| APP-14 version check | Can only enable an allowed GET; no data leaves except IP. | Wrong toggle harmless; stale version notice is advice only. | Off by default before store. | Live. | Run once per interval per deployment (store-level timestamp), not per instance. | no | `.env`. | Occasional. | no |
| APP-16 outbound proxy | Not editable. | Wrong proxy: version check fails quietly. | Yes. | Restart. | Same. | Yes. | Same. | No. | no |
| APP-17 debug flags | Not editable. | n/a (cannot happen in UI). | Yes. | Restart. | Must be off on all; startup warning if any instance runs it (exposure report). | Debug output may contain secrets: forbidden to log them anyway. | `.env`. | Developers only. | no |

### 2.3 Modules, console, history

| Setting | (1) | (2) | (3) | (4) | (5) | (6) | (7) | (8) | (9) |
|---|---|---|---|---|---|---|---|---|---|
| APP-18 high-risk modules | Cannot enable from UI. Can disable (safe). | Cannot enable by mistake. | Needs `.env` to exist. | Restart to enable; disable is live. | Must agree: otherwise behaviour differs by instance; exposure report shows differences (D7). | no | `.env`. | Rare. | Users cannot enable. |
| APP-19 low-risk modules | Can disable (annoyance) or enable allowed format: low impact, audited. | Disabled a needed format: re-enable, no data loss. | Defaults from `.env` ceiling. | Live; running export finishes. | Store + 15 s cache. | no | `.env`. | Yes, frequent: no step-up. | A user may hide formats from their own menu, not enable. |
| APP-20 console available | Enabling blocked above ceiling. | Disabled by mistake: re-enable. | n/a | Open consoles close at next request. | Store. | History may hold literals (APP-41). | `.env`. | Occasional. | Layout is APP-43. |
| APP-41 history/bookmark retention | Raising: within ceiling only, audited. | Short value deletes history: **data loss, not recoverable from UI**: confirm dialog and a 7-day grace before purge. | Store needed. | Purge job next run. | Single job (lock). | Contains sensitive literals: not in logs. | `.env` limit; user's own value in state store. | Rare. | Yes: shorter than admin limit. |

### 2.4 Presentation

| Setting | (1) | (2) | (3) | (4) | (5) | (6) | (7) | (8) | (9) |
|---|---|---|---|---|---|---|---|---|---|
| APP-21 default language | Harmless. | Incomplete language shows English fallback; recoverable. | Pre-login: cookie, `Accept-Language`, default. | Live; user's own choice persists. | Store. | no | `.env` default; user choice in state store (keyed target+user) or cookie before login. | Rare. | **Yes**, user preference. |
| APP-22 available languages | Harmless. | Empty list: rejected; `en` forced on. | Needs default before store: `.env` initial. | Users with a removed language fall back to default. | Store. | no | `.env`. | Rare. | Within admin set. |
| APP-23 default theme | Harmless while themes are built-in. | Unreadable contrast: user override or CLI reset; keep "reset appearance" link on login page. | Same as language. | Live. | Store. | no | `.env`. | Rare. | **Yes**. |
| APP-24/25 time zone and formats | Harmless; display only, UTC underneath. | Misleading display; recoverable. | Store holds UTC; no startup need. | Live. | Store. | no | `.env` default. | Rare. | **Yes**. |
| APP-26 base path | Not editable. | Wrong path: nothing loads, login impossible; fix `.env`. | Yes. | Restart; cookies invalid. | All instances and the proxy must agree. | no | Same. | No. | n/a |
| APP-27 login-page text | Phishing text: step-up, plain text, audit old/new. | Typo harmless; a 5000 char text blocked by cap. | Pre-login read: needs store; cache so login works if store is slow; if store down show nothing. | Live. | Store. | Must not contain secrets (admins sometimes paste passwords): no way to prevent, warn. | `.env`. | Occasional. | n/a |
| APP-28 logo | Not editable. | n/a | Static file. | Restart. | Same file on all. | no | `.env`. | Rare. | n/a |
| APP-29 maintenance | Can enable (DoS to users); admin plane and CLI exempt; ends at deadline. | Forgot to turn off: end time and banner; worst: users blocked until admin acts. | `.env` flag works without store (during migration). | Existing sessions: banner then read-only after 5 min grace. | Store, visible to all within cache TTL. | no | `.env` flag or CLI. | Occasional: needs a one-click switch. | n/a |
| APP-30 banner | Phishing risk lower, post-login. | Typo. | Store. | Live. | Store. | no | `.env` one-off. | Yes. | n/a |

### 2.5 Headers, cookies, files, health, backup

| Setting | (1) | (2) | (3) | (4) | (5) | (6) | (7) | (8) | (9) |
|---|---|---|---|---|---|---|---|---|---|
| APP-31 CSP overrides | Widening is the persistence step of an attack: not editable. | Broken UI if too strict: only `.env`; report-only mode helps. | Headers sent on the first byte. | Restart. | Must agree. | no | `.env`. | No. | n/a |
| APP-32 CSP report | External URI exfiltrates; not editable. | Wrong URI: reports lost, harmless. | Yes. | Restart. | Per-instance logs. | no | Same. | No. | n/a |
| APP-33 settings export/import | Import bypass attempt blocked by P1 clamp and step-up. Export has no secrets. | Bad import: all-or-nothing validation, preview diff. | Initial import via CLI possible. | Applied live per key. | Store. | Secrets masked. | n/a (no UI). | Occasional (staging to production). | n/a |
| APP-34 store backup | No UI download. | Restore of an old backup resurrects deleted users and old hashes: CLI warns and audits. | Done outside the app. | Offline restore. | Stop all instances. | Backup holds hashes and ciphertext: protect like the store; the keys are separate. | Same via CLI. | Scheduled by operator. | n/a |
| APP-36 TempDir/CacheDir | Not editable. | Unwritable: uploads and exports fail with a clear error, startup check. | Yes. | Restart; leftover files swept. | Per instance, not shared (or each upload must stick to its instance). | Contents may be data: 0700, sweep. | `.env`. | No. | n/a |
| APP-37 health | Not editable. | Wrong ENV: orchestrator kills good instance; keep fixed path. | Yes. | Reports "starting" during boot. | Per instance. | No info disclosure. | Works the same (no UI needed). | No. | n/a |
| APP-38/39 step-up, revert, limits | Not editable, otherwise circular. | Absurd values rejected at startup by range check. | Yes. | Restart. | Must agree. | no | `.env`. | No. | n/a |
| APP-40 notice thresholds | Raising up to ceiling only. | Too many notices: lower again. | Store. | Live. | Store, counters shared or per instance (document). | no | n/a (no UI; notices go to log). | Occasional. | n/a |
| APP-42/43 shortcuts, console options | Thief changes only that user's preference. | Harmless. | n/a | Live in browser, persisted when store reachable. | Store. | no | Store keyed by target+user. | n/a | **Yes**, user preference. |

---

## 3. Parameters summary (PROPOSED, all subject to owner approval)

| Parameter | Default | Floor / lower bound | Ceiling / upper bound | Rationale |
|---|---|---|---|---|
| Audit retention | 365 d | 90 d | 1095 d | Floor protects evidence against a stolen session; ceiling limits personal-data storage. |
| App log level range from UI | `info` | `warn` | `info` (debug only `.env`) | Debug can leak data. |
| Log raise auto-revert | 60 min | - | 240 min | Forgotten verbose logs. |
| Step-up window | 5 min | 1 min | 15 min | Balance usability and re-prompt risk. |
| Settings auto-revert (network changes) | 3 min | 1 min | 10 min | Enough to test a new connection, short enough to recover. |
| Setup token validity | 60 min | 5 min | 24 h | A fresh install must not stay open. |
| Login-page text | empty | - | 300 chars plain | Phishing and layout. |
| Banner | empty | - | 500 chars plain | Same. |
| Version check interval | 24 h | 6 h | 7 d | Low traffic, no tracking value. |
| History retention per user | 90 d / 1000 | 1 d / 10 | 365 d / 5000 | SQL text contains data. |
| Notice threshold (failures) | 10 / 10 min | 3 | 20 | Floor on sensitivity. |
| Settings cache TTL (multi-instance) | 15 s | 5 s | 60 s | Consistency across instances after a change. |
| CSP report body | 8 KB | - | 16 KB | Flood protection. |
| Master secret length | 256 bit | 128 bit refuse below | - | SEC-TGT-081/080. |
| Temp file sweep | 60 min | 5 min | 24 h | Leftover uploads. |

Mark: all numbers above are PROPOSED defaults chosen by judgement; none comes from a standard verified in this wave.

---

## 4. Disagreements with the spec text

- **D1 - "session secret" (task wording, SEC-TGT-081, legacy `blowfish_secret`).** With server-side sessions (SEC-TGT-040) no session signing secret is needed. What is needed is one application master secret from which purpose-bound keys for CSRF, client-carried state (SEC-TGT-118) and reversible field encryption are derived. Spec should name that secret and the key ring, and say the legacy `blowfish_secret` has no counterpart.
- **D2 - DEP-TGT-100 setup token "shown in the console".** Container and systemd output goes to log collectors, which conflicts with SEC-TGT-023 and leaves the token in log storage. Prefer: token written to a 0600 file in the data directory (or supplied by env), printed to console only if stdout is a terminal, and expiring after 60 min.
- **D3 - DEP-TGT-140 `.env` list is incomplete.** Add: store credentials, application secrets and ring, log destinations, external audit sink, outbound switches and proxy, debug flags, cookie suffix and instance id, CSP settings, health endpoint, temp/cache directories, step-up window, auto-revert period, forced maintenance flag, high-risk module enablement.
- **D4 - FR-TGT-141 "at least" list.** Add audit retention, default language/theme/time zone, enabled low-risk modules, banner and login text, maintenance mode, notice thresholds, history limits. Add that import of settings must pass the same limits.
- **D5 - NFR-TGT-090 "retention and access shall be configurable".** Unbounded configurability lets a thief erase evidence. Change to: retention within an `.env` floor and ceiling, no UI deletion, access limited to the administration plane, export with step-up, optional external append-only sink.
- **D6 - SEC-TGT-129 global network middleware vs health and CSP-report endpoints.** An orchestrator or load balancer is usually outside the administration and user ranges; the endpoint rules need an explicit `.env` allow-list for probe addresses, otherwise the allow-list kills health checks or tempts operators to disable it. The CSP report endpoint is browser-originated and must follow the user allow-list, not the probe list.
- **D7 - SEC-TGT-125 warnings.** Add triggers: debug flag on, log level debug, setup still open, any outbound feature enabled, high-risk module enabled, instances disagreeing on a security `.env` value. Instances should write a hash of their security-relevant `.env` values to the store at startup so the admin page can show a mismatch.
- **D8 - SEC-TGT-135 sub-path versus `__Host-`.** `__Host-` needs path `/`. Recommend: first release serves at the root of a host name; a sub-path deployment (`APP-26`) uses `__Secure-` and a `Path`, and the exposure report says so. Needs owner decision.
- **D9 - SEC-TGT-144 auto-revert.** Define for multi-instance: the pending change and its deadline are stored as an absolute time in the store (P5); a restart must not turn a pending change into a permanent one or a lost one. Apply the same mechanism to maintenance mode with end time, and to raised log levels.
- **D10 - SEC-TGT-142 write-time checks only.** Add read-time clamping (P1), otherwise a store edit bypasses the floors and ceilings.
- **D11 - Legacy telemetry and error reporting (01-configuration.md directives such as `SendErrorReports`, `VersionCheck`).** The spec contains no disposition. Proposal: drop error reporting, keep version check as off-by-default optional, no telemetry.
- **D12 - DATA-TGT-094 / OPEN 12 store type.** A JSON/flat file cannot satisfy the audit, retention, locking and multi-instance needs of the above (single retention job, atomic setup flag, absolute-deadline timers). Recommendation: an embedded database (for example SQLite) for single instance and a server database for multi-instance, behind one storage interface. Depends on stack choice and OPEN 12.
- **D13 - Backup.** SEC-TGT-090 and section 14 say nothing about backup of DBLoom's own state; add: CLI-only, keys stored separately, no UI download of the full store.

---

## 5. Open questions for the owner

1. Q1 Store type (OPEN 12): file or database, and is a server database (multi-instance) in scope for the first release? Many verdicts (APP-01/02/29/34) hinge on it.
2. Q2 Are several DBLoom instances against one store supported in the first release (SEC-TGT-131 mentions it as open)? If not, the settings cache, retention-job lock and `.env` agreement items shrink.
3. Q3 Sub-path deployment: support or not (D8)?
4. Q4 Audit retention: which minimum and maximum do you want (legal/organisational), and should the audit log be tamper-evident (hash chain / external sink) in the first release?
5. Q5 May DBLoom make any outbound call at all in the first release (version check)? Or is the product to be fully offline-capable by default?
6. Q6 Should error reporting to a third party be dropped completely (recommended) rather than kept as an opt-in?
7. Q7 Is the full set of 95 legacy languages kept (OPEN 7)? It determines whether "available languages" needs an admin setting at all.
8. Q8 Custom branding: text only (as proposed) or also logo upload by the UI? A UI upload requires raster-only, re-encoding and a separate review.
9. Q9 Should ordinary users see their own audit events (login history)? It helps spot account takeover and fits FR-TGT-149, but extends audit access.
10. Q10 Do you want a UI toggle for "log level" at all (APP-08), or `.env` only for simplicity?
11. Q11 Maintenance mode: what should happen to running sessions (banner only, read-only after grace, forced logout)?
12. Q12 Is a settings export/import function wanted in the UI, or CLI only? (APP-33.)
13. Q13 Where may the setup token go (D2): file, env, TTY console only?
14. Q14 How are history and bookmarks limited when there is no administrator (direct mode): `.env` only?
15. Q15 Should the "new location" definition (APP-40) be per user or global, and is a /24 or /48 granularity acceptable?

## 6. Items that depend on undecided scope or stack
- OPEN 1 (scope): APP-18/19/20 (which modules exist), APP-21/22 (languages).
- OPEN 2 (stack): log format and rotation (APP-09), outbound proxy support (APP-16), upload temp handling (APP-36), key-derivation library (APP-03), cookie prefix behaviour (APP-07/26), health endpoint behind the framework (APP-37).
- OPEN 12/13 (store type, account-mode storage): APP-01, 02, 06, 29, 34, 35, 41, and the multi-instance cells of the matrix.
- OPEN 18 (thresholds, auto-revert, default administration network): APP-38, 39, 40 and all values in section 3.
