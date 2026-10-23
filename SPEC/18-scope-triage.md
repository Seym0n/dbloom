# 18 — Scope triage of the legacy requirements

**Status: machine-triaged; the licence is proposed (Apache-2.0, to be confirmed); the 23 owner features were decided by the owner on 2026-10-23 (section 3); the other decisions are proposals, not yet reviewed by the owner.** Answer to `OPEN.md` item 1 (scope): which of the 946 legacy requirements of files 00 to 08 DBLoom keeps, adapts or drops, given the decided stack (TypeScript, TanStack Start, Node.js, MySQL/MariaDB only, self-hosted). Nothing here changes the legacy files.

## 1. Method and limits

- **Input:** all 946 requirements found in files 00 to 08 (items that start with a requirement ID; each text cut at 520 characters, evidence and verification text removed). The settings table of file 12 and the target requirements of file 11 were not triaged; they are already DBLoom's own.
- **Review:** 18 subagents on the Sonnet model, about 55 requirements each, working from one brief (decided facts, the proposed minimum servers MySQL 8.4 and MariaDB 10.11, and the five decisions below). They could read the rest of the SPEC and the legacy source. Issue and spec text was treated as data.
- **Decisions:** KEEP (same behaviour needed), ADAPT (the need stays, the PHP or legacy realisation changes), SUPERSEDED (DBLoom already specifies it differently), DROP (not needed), OWNER (a product-scope choice for the owner; grouped by feature). After the owner's decisions of 2026-10-23 a sixth decision, DEFER (whole feature postponed beyond the first release), exists.
- **Second review (2026-10-23):** 10 Haiku subagents re-read all 946 decisions (about 95 each) against the owner decisions and flagged 18; 10 were changed with the owner's approval (the rows whose note starts with "Second review"), 8 were left as they are with reasons given to the owner, FR-SRV-009 was decided by the owner's approval of DEFER. The Haiku reviewers did not know the earlier consistency-pass approvals, so some of their flags contradicted decisions the owner had already approved.
- **Checks:** every requirement has exactly one decision (946 of 946, none missing, none twice). The orchestrator did **not** read the individual notes; the counts of two agents were estimates and are replaced here by the real counts. The notes are the agents' words.
- **Known weaknesses:** the agents judged from a cut text; SUPERSEDED rows may name no replacing ID; some features appear under different group names (merged in section 3); OWNER is used more by some agents than by others, so section 2 per subsystem is uneven. The proposed server minimums are not confirmed by the owner (`OPEN.md` item 2); DROPs that rest on them would change if the minimums change.

## 2. Result

| Decision | Count |
|---|---|
| KEEP | 124 |
| ADAPT | 343 |
| SUPERSEDED | 88 |
| DROP | 342 |
| DEFER | 49 |
| OWNER | 0 |
| Total | 946 |

By subsystem:

| Subsystem | KEEP | ADAPT | SUPERSEDED | DROP | DEFER | OWNER | Total |
|---|---|---|---|---|---|---|---|
| CC (Overview) | 0 | 9 | 5 | 7 | 0 | 0 | 21 |
| CFG (Configuration) | 0 | 29 | 16 | 72 | 1 | 0 | 118 |
| SRV (Server) | 44 | 56 | 4 | 20 | 14 | 0 | 138 |
| DTB (Database/table) | 41 | 43 | 1 | 15 | 17 | 0 | 117 |
| IOX (Import/export) | 21 | 40 | 0 | 31 | 9 | 0 | 101 |
| SAU (Security/auth) | 2 | 38 | 46 | 39 | 3 | 0 | 128 |
| PLG (Plugins) | 0 | 57 | 2 | 36 | 3 | 0 | 98 |
| UIX (Front end) | 14 | 51 | 1 | 50 | 2 | 0 | 118 |
| DEP (Deployment/docs) | 2 | 20 | 13 | 72 | 0 | 0 | 107 |

KEEP and ADAPT together (467 requirements) are the basis of DBLoom's functional scope; ADAPT rows need new wording before they become DBLoom requirements. DROP and SUPERSEDED (430) leave scope. DEFER (49) is a decision of the owner on whole features: they are not in the first release and are recorded in `FUTURE.md` (FU-010). No OWNER rows are left.

**Sample review (2026-10-23):** 40 decisions were sampled across the nine subsystems; 3 were changed (CON-CC-006, FR-SAU-051, FR-SAU-054; see section 4). **Consistency pass (2026-10-23):** a keyword check flagged 98 further rows whose decision may disagree with the owner's feature decisions; four Sonnet agents checked them, 31 were changed (the owner approved the list; FR-SAU-050 and FR-SAU-061 became ADAPT, not SUPERSEDED, because SEC-TGT-011 to 014 do not cover them yet) and 67 stayed. The four sign-on mechanism rows FR-SAU-014, 015, 017 and SEC-SAU-205 stay DROP.

## 3. Features decided by the owner

The agents marked 117 requirements as OWNER; they fall into 23 features. On 2026-10-23 the owner accepted the recommendation for every feature. The decisions are applied to the requirement rows of section 4 (note "owner decision"). `other formats` was decided as: keep SQL, CSV and JSON, drop the others; its 10 requirements all concern the dropped formats and are DROP in section 4. `licensing` was decided as: permissive licence, Apache-2.0 proposed (CON-TGT-001, `OPEN.md` item 9); its three requirements are SUPERSEDED.

| Feature | Requirements | Count | Decision (owner accepted the recommendation) |
|---|---|---|---|
| column transformations | FR-DTB-137, FR-PLG-025, FR-PLG-026, FR-PLG-028, FR-PLG-030, FR-PLG-031, FR-PLG-032, FR-PLG-034, FR-PLG-035, FR-PLG-036, DATA-PLG-002, FR-PLG-037, FR-PLG-038, FR-PLG-039, FR-PLG-041, FR-PLG-042, FR-PLG-043, FR-PLG-044, FR-PLG-045, FR-PLG-046, FR-PLG-047, FR-PLG-048, FR-PLG-049, FR-PLG-050, FR-PLG-051, FR-PLG-052, FR-PLG-053, FR-PLG-054, FR-PLG-056, DATA-PLG-008, CPT-PLG-006, DATA-DEP-066 | 32 | Keep a small built-in set (date/time, hex, JSON, image/link preview, bool); drop the plugin mechanism (closed registry, FU-006). **ADAPT, reduced** |
| replication ui | FR-SRV-004, FR-SRV-024, CPT-SRV-003, FR-SRV-025, FR-SRV-026, SEC-SRV-003, FR-SRV-027, DATA-SRV-009, FR-SRV-028, FR-SRV-076, FR-SRV-077 | 11 | Niche, high risk; leave to server tools. Defer to FUTURE. **DEFER** |
| designer | FR-DTB-066, FR-DTB-101, FR-DTB-120, FR-DTB-121, FR-DTB-122, FR-DTB-123, FR-DTB-124, DATA-DTB-005, FR-PLG-013, DATA-PLG-005, FR-UIX-063 | 11 | Visual designer, internal relations and schema diagram export; FU-009 already defers designer items. Defer as one feature. **DEFER** |
| other formats | FR-IOX-076, FR-IOX-077, FR-IOX-079, FR-IOX-080, FR-IOX-081, FR-IOX-082, FR-IOX-090, FR-IOX-091, FR-IOX-097, INT-DEP-015 | 10 | Keep CSV, SQL, JSON and Excel (FU-009) as the first-release formats; drop XML, YAML, LaTeX, Texy, MediaWiki, PDF, ODS, schema export. **KEEP core, DROP rest** |
| tracking | FR-DTB-110, FR-DTB-111, FR-DTB-112, FR-DTB-113, FR-DTB-114, CPT-DTB-002, FR-DTB-150, FR-DTB-151, DATA-DTB-004 | 9 | Version tracking of structure changes; a large feature. Defer. **DEFER** |
| server monitor | FR-SRV-009, FR-SRV-010, FR-SRV-011, FR-SRV-012, FR-SRV-013, UI-SRV-008 | 6 | Live server status charts are a DBA need; keep a reduced form (fits the AI-sidebar insight goal). **KEEP, reduced** |
| query by example | FR-DTB-094, FR-DTB-095, FR-DTB-158, FR-DTB-159, FR-UIX-062 | 5 | Superseded by the SQL editor and AI sidebar. Drop. **DROP** |
| server advisor | FR-SRV-062, FR-SRV-063, INT-SRV-008, SEC-SRV-010 | 4 | Rule-based advice; the AI sidebar can cover it. Drop; revisit with the sidebar details (OPEN 19). **DROP** |
| gis editor | FR-IOX-067, FR-IOX-068, FR-IOX-098, FR-IOX-099 | 4 | Spatial editor and map visualisation; niche. Defer. **DEFER** |
| themes | FR-UIX-012, DEP-UIX-084, FR-UIX-085, DEP-UIX-112 | 4 | Light and dark mode only; no theme packs (UI details are OPEN 7). Drop packs. **DROP packs** |
| bookmarks and history | FR-DTB-025, FR-DTB-026, CPT-DTB-001 | 3 | Saved queries and history are already required in file 17 (query history). Keep. **KEEP** |
| single sign-on | FR-SAU-013, FR-SAU-016, FR-SAU-018 | 3 | Needed by many companies, but not designed yet; check SEC-TGT first. Defer or add to scope in OPEN 17. **DEFER** |
| zoom search | FR-DTB-092, FR-UIX-060 | 2 | Rarely used. Drop. **DROP** |
| login captcha | SEC-SAU-031, INT-DEP-013 | 2 | Rate limiting (SEC-TGT-017) replaces it. Drop. **DROP** |
| two-factor auth | UI-SAU-053, SEC-SAU-325 | 2 | Already required by SEC-TGT-014. Treat as superseded. **SUPERSEDED** |
| query console | FR-UIX-047, CON-UIX-051 | 2 | The SQL editor is core; keep one editor, no separate legacy console. **KEEP** |
| central columns | DATA-DTB-002 | 1 | Depends on the pmadb store; no demand in open issues. Drop. **DROP** |
| normalization wizard | FR-DTB-140 | 1 | Educational, rarely used. Drop. **DROP** |
| hidden nav items | FR-UIX-042 | 1 | Part of the navigation design (OPEN 7). Keep as a user preference. **KEEP** |
| charts | FR-UIX-059 | 1 | Chart of result data; defer. **DEFER** |
| error reporting | FR-DEP-056 | 1 | Sends reports to LegacyAdmin.net; not applicable. Drop. **DROP** |
| configuration storage | FR-DEP-060 | 1 | The pmadb store is replaced by the DBLoom store (OPEN 12); migration is OPEN 8. **SUPERSEDED** |
| licensing | CON-DEP-110 | 1 | Not a feature: permissive licence, Apache-2.0 proposed, rules in CON-TGT-001 (OPEN 9). **SUPERSEDED** |

## 4. Disposition of every requirement

| ID | Decision | Feature area | Note |
|---|---|---|---|
| CON-CC-006 | SUPERSEDED | licence | Replaced by CON-TGT-001 (permissive licence) (owner decision 2026-10-23). |
| CON-CC-019 | DROP | PHP config file | PHP defaults mirror and unit test; internal detail. |
| CPT-CC-020 | DROP | platform baseline | PHP/jQuery/Bootstrap baseline and old MySQL minimum; DBLoom has its own stack and server minimums. |
| DEP-CC-013 | ADAPT | control connection | No controluser; DBLoom uses its own app store. Keep clear error and denial handling when the user's server connection fails. |
| DEP-CC-014 | ADAPT | auth logging | Keep loggable login outcomes with optional success logging, written to stdout or structured log instead of syslog/PHP error_log. |
| INT-CC-004 | ADAPT | server version support | Minimums become MySQL 8.4 and MariaDB 10.11; detect product via Adapter/Strategy; refuse older servers with clear message. |
| INT-CC-021 | ADAPT | export format availability | Keep conditional format availability and Excel-CSV clarity; no TCPDF/curl dependency; PDF only if owner wants it. |
| NFR-CC-001 | DROP | PHP runtime | PHP version gate. |
| NFR-CC-003 | DROP | PHP build chain | Yarn/Composer build specifics; DBLoom has its own Node build. |
| NFR-CC-007 | ADAPT | user preferences | Persist per-user preferences in DBLoom own store tied to user accounts; no session-only fallback or la_userconfig. |
| NFR-CC-011 | DROP | PHP extensions | PHP extension checks. |
| NFR-CC-012 | DROP | PHP runtime | PHP ini and timezone normalisation. |
| NFR-CC-015 | ADAPT | routing errors | Keep deterministic 404/405 responses with escaped output; PHP route cache is irrelevant. |
| NFR-CC-016 | ADAPT | import memory bound | Keep bounded memory on import via streaming and chunking; not tied to PHP memory_limit. |
| SEC-CC-002 | DROP | PHP include guards | PHP direct-include protection. |
| SEC-CC-008 | SUPERSEDED | CSRF token | Replaced by DBLoom CSRF/request protection design in 11-target-security.md (SEC-TGT-*). |
| SEC-CC-009 | SUPERSEDED | session hardening | PHP session ini; DBLoom session and cookie hardening specified in 11-target-security.md. |
| SEC-CC-010 | SUPERSEDED | session regeneration | Session fixation protection covered by DBLoom session design in 11-target-security.md. |
| SEC-CC-017 | ADAPT | privilege capability check | Keep a capability check for privilege-table access rather than SUPER; use it to gate drop-database and admin features. |
| SEC-CC-018 | SUPERSEDED | credential encryption | Cookie credential encryption replaced by DBLoom connection profile vault in 11-target-security.md. |
| UI-CC-005 | ADAPT | UI translation | Keep translatable UI and RTL support via TS i18n, not gettext/po; language set is an open choice. |
| CON-CFG-020 | SUPERSEDED | server selection | Replaced by personal connection profiles; no multi-server config array or md5 verbose matching. |
| CON-CFG-024 | SUPERSEDED | auth type setting | auth_type config/http/signon/cookie replaced by DBLoom own accounts and security design. |
| CON-CFG-027 | ADAPT | enumerated settings | Keep constrained allowed-value validation for settings, defined in TS schema per 12-settings.md; legacy option set differs. |
| CON-CFG-072 | DROP | zero-conf storage | ZeroConf pmadb auto-detection; DBLoom has its own application store. |
| CON-CFG-106 | DROP | PHP config file | config.default.php mirror and parity test. |
| CON-CFG-107 | DROP | PHP config file | Settings class source of defaults; PHP structure. Settings design is in 12-settings.md. |
| CON-CFG-111 | DROP | PHP config file | config.inc.php write behaviour; no such file. |
| CPT-CFG-071 | DROP | zero-conf storage | pmadb probing and adoption of la_ tables; DBLoom does not use LegacyAdmin storage. |
| DATA-CFG-022 | DROP | PHP config file | PHP Settings class internals. |
| DATA-CFG-023 | ADAPT | connection profile defaults | Keep sensible connection defaults (host, port, socket, SSL verify on, compress) in profiles; drop config.inc.php keys and control* fields. |
| DATA-CFG-025 | DROP | pmadb table names | la_ table-name directives. |
| DATA-CFG-026 | DEFER | signon cookie params | Signon cookie parameters belong to single sign-on, which is deferred. (consistency pass 2026-10-23, was DROP) |
| DATA-CFG-028 | DROP | PHP config file | config.values.php overrides and validators; PHP mechanism. |
| DATA-CFG-029 | DROP | PHP config file | Descriptions module for config forms; PHP detail. |
| DATA-CFG-069 | ADAPT | app storage features | Feature-to-table mapping becomes DBLoom own storage schema; which features exist is decided per feature elsewhere. |
| DATA-CFG-090 | DROP | PHP config file | PHP-era runtime directives, warnings, AuthLog, blowfish_secret. |
| DATA-CFG-091 | SUPERSEDED | login cookie auth | Cookie, CAPTCHA and URL-encryption directives replaced by DBLoom security design in 11-target-security.md. |
| DATA-CFG-092 | ADAPT | navigation tree settings | Keep tree grouping, separators and item limits as user settings with new defaults; drop logo-link options. |
| DATA-CFG-093 | ADAPT | browse display settings | Keep rows per page, ordering, binary protection, grid editing as settings; drop PHP-specific and obsolete directives. |
| DATA-CFG-094 | ADAPT | language and theme settings | Keep default language, connection collation and title templates as settings; PHP charset recoding and ThemeManager dropped. |
| DATA-CFG-108 | DROP | pmadb storage | LegacyAdmin configuration storage DB and create_tables.sql; DBLoom has its own store. |
| DEP-CFG-085 | DROP | PHP vendor config | vendor_config.php packaging. |
| DEP-CFG-086 | DROP | PHP Composer | Composer autoloader check. |
| DEP-CFG-087 | DROP | PHP config file | config.sample.inc.php template; DBLoom uses .env and settings (12-settings.md). |
| DEP-CFG-109 | DROP | pmadb storage | Manual pmadb setup steps and config keys. |
| FR-CFG-001 | SUPERSEDED | settings precedence | Layered config replaced by precedence rule in 12-settings.md (.env and settings). |
| FR-CFG-002 | DROP | PHP config file | baseSettings snapshot and PHP runtime facts. |
| FR-CFG-003 | DROP | PHP config file | Config object constructor and include. |
| FR-CFG-004 | DROP | PHP config file | Evaluating config as PHP include. |
| FR-CFG-005 | DROP | PHP config file | Slash-key quirk of flattened paths. |
| FR-CFG-006 | DROP | PHP config file | Config mtime for session preference cache. |
| FR-CFG-007 | DROP | PHP config file | PHP fatal handler during include. |
| FR-CFG-008 | DROP | PHP config file | CIFS readability probe for PHP config. |
| FR-CFG-009 | ADAPT | config load errors | Keep clear startup error when settings or env are invalid or unreadable; no PHP include semantics. |
| FR-CFG-010 | DROP | PHP config file | PHP vendor_config.php and deployment constants; DBLoom uses .env/settings (12-settings.md). |
| FR-CFG-011 | SUPERSEDED | PHP config file | No config.inc.php; secrets/settings file handling covered by 11-target-security.md and 12-settings.md. |
| FR-CFG-012 | DROP | user preferences storage | PHP session cache and array_replace_recursive mechanics; internal detail. |
| FR-CFG-013 | ADAPT | user preferences storage | Preferences stored per DBLoom user account in its own store; no session-only fallback tier. |
| FR-CFG-014 | ADAPT | user preferences storage | Set a single preference at runtime and persist per user; drop cookie write and default-removal quirks. |
| FR-CFG-015 | DROP | user preferences storage | Cookie versus persistent preference lookup is legacy; preferences live server-side per user. |
| FR-CFG-016 | ADAPT | user preferences storage | Per-user allow-list of settable prefs (theme, language, hidden DBs); 2fa handled in account security. |
| FR-CFG-017 | ADAPT | user preferences storage | Theme and language persist per user and apply on login; no cookie reconciliation needed. |
| FR-CFG-018 | ADAPT | user preferences storage | Per-user/profile default connection collation applied on connect, via Adapter. |
| FR-CFG-019 | DROP | login cookie auth | PHP login cookie validity cache; DBLoom session design in 11-target-security.md. |
| FR-CFG-021 | DROP | PHP config file | Servers array normalization; DBLoom uses connection profiles, single instance. |
| FR-CFG-030 | DROP | setup wizard | Session-held ConfigFile model of the PHP setup wizard. |
| FR-CFG-031 | DROP | setup wizard | ConfigFile set() path canonicalization is PHP setup internals. |
| FR-CFG-032 | DROP | setup wizard | Persist keys for generated config.inc.php; no generated PHP file. |
| FR-CFG-033 | ADAPT | per-page settings | Per-page settings dialogs (browse, export, import, SQL) saved to user preferences; no ConfigFile classes. |
| FR-CFG-034 | DROP | setup wizard | Server bookkeeping of config file; replaced by connection profiles. |
| FR-CFG-035 | DROP | setup wizard | PHP form type derivation from config.values.php. |
| FR-CFG-036 | ADAPT | settings form validation | Typed settings form validation with clear errors; implement with TypeScript schema validation. |
| FR-CFG-037 | DROP | setup wizard | Allocating server index in config file; profiles use own IDs. |
| FR-CFG-038 | DROP | trusted proxies | Legacy TrustedProxies line format; proxy trust handled by 11-target-security.md/12-settings.md. |
| FR-CFG-039 | DROP | setup wizard | UserprefsDisallow flags in setup; no setup wizard. |
| FR-CFG-040 | DROP | setup wizard | PHP Validator class dispatch mechanics. |
| FR-CFG-041 | ADAPT | settings form validation | Keep numeric, port, regex bound checks as schema validation in settings; drop PHP validator naming. |
| FR-CFG-042 | ADAPT | connection profile test | Test connection when saving a profile, with clear error; no auth_type/signon fields; uses Adapter. |
| FR-CFG-043 | DROP | configuration storage | pmadb controluser validation; DBLoom keeps its own app storage. |
| FR-CFG-044 | DROP | setup wizard | setup/validate.php AJAX endpoint. |
| FR-CFG-045 | DROP | setup wizard | PHP version and bootstrap requirements for setup front controller. |
| FR-CFG-046 | DROP | setup wizard | Setup disabled when config exists; no setup wizard in DBLoom. |
| FR-CFG-047 | DROP | setup wizard | Setup page dispatch and formsets. |
| FR-CFG-048 | DROP | setup wizard | Setup server add/edit flow; replaced by connection profile management. |
| FR-CFG-049 | DROP | setup wizard | Setup server removal; replaced by profile deletion. |
| FR-CFG-050 | DROP | setup wizard | Setup form processing redirects and error template. |
| FR-CFG-051 | DROP | setup wizard | Setup server form tabs for config.inc.php and pmadb. |
| FR-CFG-052 | DROP | setup wizard | Generating and downloading config.inc.php. |
| FR-CFG-053 | DROP | setup wizard | PHP config file generator. |
| FR-CFG-054 | SUPERSEDED | PHP config file | blowfish_secret replaced by DBLoom secret/vault key handling in 11-target-security.md. |
| FR-CFG-055 | DROP | setup wizard | Line endings of generated PHP config. |
| FR-CFG-056 | DROP | setup wizard | Setup home page checks, version check, server list. |
| FR-CFG-068 | DROP | configuration storage | pmadb feature table probing; DBLoom uses its own storage, not LegacyAdmin tables. |
| FR-CFG-070 | DROP | configuration storage | PHP session relation cache keyed by version. |
| FR-CFG-073 | ADAPT | table UI preferences | Cap on stored per-table UI prefs (column order, hidden columns) with pruning; limit configurable. |
| FR-CFG-074 | ADAPT | SQL history | Capped per-user SQL history, newest first; stored in DBLoom storage, max configurable. |
| FR-CFG-075 | DROP | PHP entry guards | LEGACYADMIN constant guard is PHP-specific. |
| FR-CFG-076 | DROP | PHP version check | PHP version enforcement; DBLoom checks Node runtime instead if needed. |
| FR-CFG-077 | DROP | PHP runtime detection | PHP OS, IIS, GD, browser sniffing; obsolete. |
| FR-CFG-078 | ADAPT | base URL path | Support deployment under a sub-path/reverse proxy via configured base URL setting. |
| FR-CFG-079 | ADAPT | temp directories | Configurable temp/upload directory created on demand with restrictive permissions; Node tmp fallback. |
| FR-CFG-080 | DROP | PHP runtime detection | PHP ini environment defaults. |
| FR-CFG-081 | DROP | PHP runtime detection | PHP_SELF PATH_INFO sanitizing. |
| FR-CFG-088 | DROP | PHP bootstrap | Describes PHP Common::run() startup order. |
| FR-CFG-095 | ADAPT | user preferences storage | Preferences persisted in DBLoom store per user as JSON with timestamp; no session fallback. |
| FR-CFG-096 | ADAPT | preferences pages | Preference pages per category (features, SQL, navigation, export, import, security); drop ConfigFile/form mechanics. |
| FR-CFG-097 | ADAPT | preferences import export | Export/import preferences as JSON with merge option; drop PHP snippet export and hardened upload via validated schema. |
| FR-CFG-098 | DROP | PHP config file | Config class get/set internals. |
| FR-CFG-099 | DROP | setup wizard | Setup wizard flow; replaced by first-run setup in 12-settings.md and profiles. |
| FR-CFG-101 | DROP | version check | LegacyAdmin project update check against legacyadmin.net; not applicable to DBLoom. |
| FR-CFG-110 | SUPERSEDED | pmadb setup | DBLoom uses its own application storage, not LegacyAdmin la_ tables; see 12-settings and 11-target-security. |
| FR-CFG-112 | SUPERSEDED | pmadb setup | Storage database discovery/ZeroConf is a pmadb mechanism; DBLoom has own app storage. |
| FR-CFG-115 | SUPERSEDED | user preferences | Per-user preferences are stored with DBLoom user accounts, no PHP session fallback. |
| FR-CFG-118 | ADAPT | ui state persistence | Persist layout and UI choices per DBLoom user in own storage instead of la_ tables. |
| INT-CFG-083 | DROP | user preferences | localStorage import banner is a legacy PHP session-prefs mechanism. |
| INT-CFG-084 | DROP | PHP bootstrap | Describes PHP entry-point bootstrapping and DI container. |
| INT-CFG-089 | ADAPT | connection parameters | Connection profiles carry host, port, socket, TLS options; no controluser/control_ key mapping. |
| INT-CFG-102 | DROP | outbound proxy | Only used for version check; no outbound HTTP planned. PHP cURL/stream details irrelevant. |
| INT-CFG-113 | SUPERSEDED | control connection | No pmadb control connection; DBLoom storage is separate from target database access. |
| INT-CFG-116 | DROP | browser storage | Legacy prefs import/export through localStorage and config.js. |
| NFR-CFG-082 | DROP | session caching | PHP session cache of prefs and relations; DBLoom has own caching design. |
| NFR-CFG-105 | ADAPT | config error handling | Invalid settings must fail startup with clear message; PHP include/shutdown mechanics dropped. |
| NFR-CFG-117 | DROP | pmadb degradation | Per-table degradation without pmadb is irrelevant with DBLoom own storage. |
| SEC-CFG-058 | SUPERSEDED | cookie encryption key | blowfish_secret/sodium key replaced by DBLoom secret handling in 11-target-security and 12-settings. |
| SEC-CFG-059 | SUPERSEDED | arbitrary server | Arbitrary server login replaced by connection profiles and vault. |
| SEC-CFG-060 | ADAPT | setup warnings | Keep advisories for missing TLS and insecure DB connections as settings/health hints; no setup script. |
| SEC-CFG-061 | SUPERSEDED | login session lifetime | Session validity handled by DBLoom own session design, not PHP gc_maxlifetime. |
| SEC-CFG-062 | DROP | setup warnings | PHP SaveDir/TempDir setup notice. |
| SEC-CFG-063 | DROP | PHP compression ext | Checks PHP zip/gzip/bzip functions; Node has own libraries. |
| SEC-CFG-064 | DROP | config error iframe | PHP config file error display page. |
| SEC-CFG-065 | SUPERSEDED | session cookies | Cookie flags and naming defined by DBLoom own session/cookie security design. |
| SEC-CFG-066 | ADAPT | HTTPS detection | Need reliable HTTPS detection behind reverse proxy via explicit setting and trusted proxy headers. |
| SEC-CFG-067 | DROP | custom header footer | PHP include files; not in closed registry design. |
| SEC-CFG-103 | ADAPT | trusted proxies | Keep trusted-proxy client IP resolution for audit/rate limiting; configure via settings, not PHP array. |
| SEC-CFG-104 | SUPERSEDED | cookie encryption key | PHP sodium/blowfish key fallback replaced by DBLoom secret management. |
| SEC-CFG-114 | SUPERSEDED | arbitrary server | Default-off arbitrary server field replaced by connection profiles. |
| UI-CFG-057 | DROP | PHP message list | Session-backed message buckets are a PHP implementation detail. |
| UI-CFG-100 | DROP | setup forms | Setup form tab definitions for PHP setup script. |
| CON-SRV-001 | KEEP | variable access | Read server variables robustly under ANSI_QUOTES sql_mode; use single-quoted literals. |
| CPT-SRV-001 | KEEP | server pages | Server-level pages operate against the currently selected server. |
| CPT-SRV-002 | DROP | host sysinfo | Web host OS load/memory probing is unrelated to database server; platform-specific PHP code. |
| CPT-SRV-003 | DEFER | replication UI | Replication role detection and multi-primary selection is a feature-scope choice. (owner decision 2026-10-23, feature: replication ui) |
| CPT-SRV-004 | ADAPT | server version branching | Support MySQL 8.4+/MariaDB 10.11+ only; drop thresholds below those and use Strategy. |
| DATA-SRV-001 | KEEP | server status | Load global status and variables; show error state if status fails. |
| DATA-SRV-002 | KEEP | server status | Derived key/thread cache indicators; deprecated duplicates stripped. |
| DATA-SRV-003 | KEEP | server status | Group status variables into sections with Com usage list. |
| DATA-SRV-004 | KEEP | server status | Section dictionary for grouping all status variables. |
| DATA-SRV-005 | KEEP | server status | Truncate long log entries for display. |
| DATA-SRV-006 | KEEP | process list | Process row fields including MariaDB progress. |
| DATA-SRV-007 | KEEP | server variables | Distinguish static from editable variables. |
| DATA-SRV-008 | KEEP | server variables | Accept byte units for byte-typed variables; escape other values. |
| DATA-SRV-009 | DEFER | replication UI | Replication status display is part of the replication feature decision. (owner decision 2026-10-23, feature: replication ui) |
| DATA-SRV-010 | ADAPT | databases list | Keep name, collation, statistics, totals; drop pmadb flag; replication flags follow replication decision. |
| DATA-SRV-011 | ADAPT | DB user accounts | Users overview of MySQL/MariaDB accounts from grant tables; only 8.4/10.11 layouts, no legacy password column. |
| DATA-SRV-012 | ADAPT | DB user accounts | Parse grants into privilege lists with ALL PRIVILEGES/USAGE; use modern grant sources. |
| DATA-SRV-013 | ADAPT | DB user accounts | Translate auth plugin names; drop Old MySQL-4.0 authentication. |
| DATA-SRV-014 | KEEP | status alerts | Status variable alert thresholds. |
| DATA-SRV-015 | KEEP | server status | Same derived indicator formulas. |
| DATA-SRV-016 | KEEP | process list | MariaDB progress computation and normalised keys. |
| DEP-SRV-001 | DEFER | replication syntax | Replication version branching belongs purely to the deferred replication UI. (consistency pass 2026-10-23, was ADAPT) |
| DEP-SRV-002 | DROP | user groups menus | Depends on pma configurable menus table; obsolete. |
| DEP-SRV-003 | DROP | PHP privilege checks | Internal PHP call-order dependency. |
| FR-SRV-001 | KEEP | server status | Overview with traffic, uptime, start time. |
| FR-SRV-002 | KEEP | server status | Traffic rows with absolute and per-hour values. |
| FR-SRV-003 | ADAPT | server status | Keep connection statistics; drop legacy formatting quirks ('---' columns), use consistent locale-aware formatting. |
| FR-SRV-004 | DEFER | replication UI | Replication status display is a whole feature; owner decides scope. (owner decision 2026-10-23, feature: replication ui) |
| FR-SRV-005 | ADAPT | server status | Keep useful quick links; drop query cache flush (removed in 8.x); actions via normal authenticated requests, not data-post script. |
| FR-SRV-006 | KEEP | server status | Status variable list with sections, descriptions and doc links. |
| FR-SRV-007 | ADAPT | server status | Keep threshold alerts and alert filter; drop query-cache based rules, make thresholds data-driven. |
| FR-SRV-008 | ADAPT | server status | Keep flush allowlist but drop QUERY CACHE (removed in MySQL 8.0, MariaDB differs); require confirmation and privilege. |
| FR-SRV-009 | DEFER | server monitor | Second review (Haiku, 10 reviewers, 2026-10-23): real-time monitor charts are deferred with charts (FU-010); the reduced monitor keeps status variables and process list. |
| FR-SRV-010 | ADAPT | server monitor | Slow log analysis within monitor; owner decides feature scope. (owner decision 2026-10-23, feature: server monitor) |
| FR-SRV-011 | ADAPT | server monitor | General log analysis within monitor; owner decides feature scope. (owner decision 2026-10-23, feature: server monitor) |
| FR-SRV-012 | ADAPT | server monitor | Monitor log settings; if kept, restrict to allowlisted variables (legacy accepts any name). (owner decision 2026-10-23, feature: server monitor) |
| FR-SRV-013 | ADAPT | server monitor | Query analyzer in monitor executes arbitrary statements; owner decides scope, EXPLAIN-only would be safer. (owner decision 2026-10-23, feature: server monitor) |
| FR-SRV-014 | KEEP | query statistics | Com_* statistics with rates and percentages. |
| FR-SRV-015 | KEEP | process list | Show process list with full query option. |
| FR-SRV-016 | ADAPT | process list | Keep active-only filter; implement via Adapter, not legacy SHOW/IS branching. |
| FR-SRV-017 | ADAPT | process list | Keep sortable columns; allowlist columns and ASC/DESC, never concatenate user input (legacy defect). |
| FR-SRV-018 | ADAPT | process list | Keep refresh preserving filters; implement as client polling/refetch, not AJAX-only route. |
| FR-SRV-019 | ADAPT | process list | Keep kill thread with confirmation; check DBLoom permission, parameterised id, drop RDS special case unless needed. |
| FR-SRV-020 | KEEP | server variables | Global variables list with session override and doc links. |
| FR-SRV-021 | ADAPT | server variables | Keep editing global variables; validate name against known variable list, require privilege and confirmation. |
| FR-SRV-022 | ADAPT | server variables | Re-read and show effective value after set; use parameterised query, no ANSI_QUOTES defect, escape on render. |
| FR-SRV-023 | DROP | server variables | Internal AJAX getter endpoint with HTML response; implementation detail. |
| FR-SRV-024 | DEFER | replication UI | Replication page (primary/replica config) is a whole feature. (owner decision 2026-10-23, feature: replication ui) |
| FR-SRV-025 | DEFER | replication UI | Add replication user dialog; part of replication feature. (owner decision 2026-10-23, feature: replication ui) |
| FR-SRV-026 | DEFER | replication UI | Change primary workflow; part of replication feature (session credential storage must not be copied). (owner decision 2026-10-23, feature: replication ui) |
| FR-SRV-027 | DEFER | replication UI | Replica thread controls; only modern syntax needed if kept. (owner decision 2026-10-23, feature: replication ui) |
| FR-SRV-028 | DEFER | replication UI | MariaDB multi-source replica status; part of replication feature. (owner decision 2026-10-23, feature: replication ui) |
| FR-SRV-029 | ADAPT | binary log | Keep binlog list and event browsing with pagination; page size from DBLoom settings, not cfg MaxRows. |
| FR-SRV-030 | KEEP | database list | Database list with statistics and allowlisted sorting. |
| FR-SRV-031 | ADAPT | database list | Keep batch drop with privilege check and confirmation; drop LegacyAdmin config storage cleanup and AllowUserDropDatabase setting. |
| FR-SRV-032 | ADAPT | database list | Keep create database with collation; report unknown charset/collation as error instead of silently ignoring. |
| FR-SRV-033 | ADAPT | user accounts | Keep account list and graceful errors; use authentication_string only, no old Password column or mysql_upgrade advice. |
| FR-SRV-034 | ADAPT | user accounts | Keep privilege gate for user administration, based on DBLoom role plus MySQL grants. |
| FR-SRV-035 | KEEP | user accounts | Filter accounts by initial letter and show-all behaviour. |
| FR-SRV-036 | ADAPT | user accounts | Keep FLUSH PRIVILEGES action when needed; hint only relevant for direct grant-table edits. |
| FR-SRV-037 | KEEP | user accounts | Privilege checkboxes at global, db, table, column and routine level. |
| FR-SRV-038 | ADAPT | user accounts | Keep add user with auth plugin choice and strength meter; modern CREATE USER only, no PASSWORD() branches. |
| FR-SRV-039 | ADAPT | user accounts | Keep change password via ALTER USER only; drop legacy version branches and direct mysql.user updates. |
| FR-SRV-040 | KEEP | user accounts | Edit privileges per scope via GRANT/REVOKE. |
| FR-SRV-041 | KEEP | user accounts | Revoke all privileges with displayed queries. |
| FR-SRV-042 | ADAPT | user accounts | Keep delete users and optional drop of same-named database; drop configuration-storage cleanup, FLUSH not needed after DROP USER. |
| FR-SRV-043 | ADAPT | user accounts | Keep copy user and rename; use SHOW GRANTS rather than reading grant tables directly. |
| FR-SRV-044 | DROP | user groups | ConfigurableMenus and configuration storage are LegacyAdmin specific; DBLoom has own user management. |
| FR-SRV-045 | KEEP | user accounts | Lock and unlock account supported on MySQL 8.4 and MariaDB 10.11. |
| FR-SRV-046 | KEEP | user accounts | Export GRANT statements for selected users. |
| FR-SRV-047 | KEEP | user accounts | Offer add user only to users with CREATE USER privilege. |
| FR-SRV-048 | KEEP | user accounts | Database-level and routine-level privilege viewing and editing. |
| FR-SRV-049 | DROP | user groups | LegacyAdmin menu user groups; replaced by DBLoom own accounts and roles. |
| FR-SRV-050 | DROP | user groups | Edit-form endpoint for LegacyAdmin menu user groups; not needed. |
| FR-SRV-051 | KEEP | storage engines | List supported storage engines. |
| FR-SRV-052 | KEEP | storage engines | Per-engine details and variables. |
| FR-SRV-053 | KEEP | storage engines | InnoDB status and variables page. |
| FR-SRV-054 | KEEP | server plugins | Plugin list grouped by type; sorting done in UI. |
| FR-SRV-055 | KEEP | charsets collations | Charsets and collations with defaults flagged. |
| FR-SRV-056 | SUPERSEDED | server selection | Single instance with personal connection profiles and vault replaces configured server list. |
| FR-SRV-057 | DROP | server routes | Legacy route table; PHP route structure, DBLoom defines its own routes. |
| FR-SRV-058 | ADAPT | server SQL export import | Keep server-level SQL, export and import entry points; PHP script lists, plugin-load errors and offset/timeout form params go; use DBLoom registry. |
| FR-SRV-059 | ADAPT | server monitor | Keep live status charting inputs (numeric status variables, server time); OS name via PHP SysInfo and config host check replaced by adapter capability. |
| FR-SRV-060 | ADAPT | server monitor | Keep slow/general log time-range queries and aggregation; validate time bounds properly and use log_output table sources via adapter. |
| FR-SRV-061 | KEEP | query statistics | Per-hour/minute/second rates and percentage per Com_ counter remain useful. |
| FR-SRV-062 | DROP | server advisor | Advisor rule engine is a whole feature; owner must decide (possibly overlaps AI sidebar). (owner decision 2026-10-23, feature: server advisor) |
| FR-SRV-063 | DROP | server advisor | Advisor rule set loading; query-cache rules for MySQL < 8.0.3 are obsolete anyway. Decide with advisor feature. (owner decision 2026-10-23, feature: server advisor) |
| FR-SRV-064 | ADAPT | server variables | Keep global/session variable list, filter and edit; drop PHP static editable list and legacy error strings, guard SET GLOBAL by privilege. |
| FR-SRV-065 | ADAPT | database list | Keep replication flag and size statistics per database; use Strategy for status statements and drop legacy pos/sort handling. |
| FR-SRV-066 | ADAPT | storage engines | Keep engine list and InnoDB status/buffer pool pages; drop PBMS special case and unknown-engine rendering quirks. |
| FR-SRV-067 | ADAPT | server plugins | Keep plugin list grouped by type; drop PHP anchor/tablesorter details and DisableIS handling. |
| FR-SRV-068 | SUPERSEDED | server selection | Single instance with personal connection profiles and vault; no config servers list (see 11-target-security, FUTURE shared profiles). |
| FR-SRV-069 | ADAPT | privilege editor | Keep privilege flags per level; derive set from MySQL 8.4/MariaDB 10.11 capabilities via Strategy, include dynamic privileges. |
| FR-SRV-070 | ADAPT | privilege editor | Keep editing privileges via REVOKE/GRANT per scope; avoid tolerated-failure sequence, GRANT OPTION via WITH only on MariaDB, escape all identifiers. |
| FR-SRV-071 | ADAPT | privilege editor | Keep REQUIRE and resource limit options; drop pre-8.0.11 GRANT OPTION in WITH variant. |
| FR-SRV-072 | KEEP | privilege editor | Revoke all privileges at a scope remains needed; escape handling stays. |
| FR-SRV-073 | ADAPT | user management | Keep add-user with host choices and duplicate check; drop old_passwords and PASSWORD() logic, per-profile account vs DB account distinction. |
| FR-SRV-074 | ADAPT | user management | Keep copy/rename user incl. privileges; fix column-privilege defect, use SHOW CREATE USER style, drop user-group copy unless groups kept. |
| FR-SRV-075 | ADAPT | user management | Keep initial filter and show-all user list; query via adapter, not pma-specific user table assumptions. |
| FR-SRV-076 | DEFER | replication UI | Replication role detection is part of the replication UI feature; owner decides scope. (owner decision 2026-10-23, feature: replication ui) |
| FR-SRV-077 | DEFER | replication UI | Change-primary flow belongs to replication UI feature; owner decides. Arbitrary-server connection also conflicts with security design. (owner decision 2026-10-23, feature: replication ui) |
| INT-SRV-001 | DROP | PHP internals | Describes read-only PHP object with magic setter. |
| INT-SRV-002 | ADAPT | server monitor | Keep batched typed data points with name allowlist; implement as JSON API, OS metrics only where available. |
| INT-SRV-003 | KEEP | server status | Show a not-loaded state instead of computing on missing data. |
| INT-SRV-004 | ADAPT | pagination | Keep paged lists with has previous/next; page size from DBLoom settings instead of MaxRows config. |
| INT-SRV-005 | KEEP | database drop | Reject empty selection and report pluralized success count. |
| INT-SRV-006 | KEEP | user management | Warn about anonymous localhost account blocking other hosts. |
| INT-SRV-007 | DROP | user management | DBLoom edits via GRANT/CREATE USER, so manual grant-table edit and flush warning is obsolete. |
| INT-SRV-008 | DROP | server advisor | Advisor expression language only exists with the advisor feature; decide with it. (owner decision 2026-10-23, feature: server advisor) |
| INT-SRV-009 | ADAPT | input validation | Keep allowlisting of identifiers, sort columns and flush targets; use schema validation and fix unvalidated binlog log and sort_order. |
| NFR-SRV-001 | ADAPT | binary log | Keep binlog event viewer; TableNavigationLinksMode preference dropped, use standard pagination UI. |
| NFR-SRV-002 | ADAPT | database create | Keep success message with SQL and navigation to new database; no global $db clearing, return error cleanly. |
| NFR-SRV-003 | KEEP | user management | Optional create-database-per-user and wildcard grants remain useful, only after successful account creation. |
| NFR-SRV-004 | DROP | PHP AJAX | Legacy getExtraDataForAjaxBehavior mechanism; DBLoom uses typed API responses. |
| NFR-SRV-005 | DROP | PHP internals | Selecting mysql database at request start is a legacy side effect; qualify mysql.* explicitly. |
| NFR-SRV-006 | DROP | PHP localization | __() usage is PHP specific; DBLoom i18n and number formatting decided elsewhere. |
| NFR-SRV-007 | SUPERSEDED | authorization | DBLoom own authorization design (SEC-TGT-*) replaces per-route superuser checks; server privileges enforce database actions. |
| SEC-SRV-001 | SUPERSEDED | authorization | AJAX-only gating is a PHP request convention; DBLoom API auth and CSRF in 11-target-security. |
| SEC-SRV-002 | DEFER | server selection | Changing replication primary via GUI is replication UI, deferred. (consistency pass 2026-10-23, was SUPERSEDED) |
| SEC-SRV-003 | DEFER | replication UI | Replication control with superuser check and POST action; decide with replication UI feature. (owner decision 2026-10-23, feature: replication ui) |
| SEC-SRV-004 | ADAPT | binary log | Keep log-name allowlist and additionally validate/escape name in SQL; fix legacy defect. |
| SEC-SRV-005 | DROP | legacy password hashing | old_passwords and mysql_old_password/sha256 switching are obsolete on MySQL 8.4/MariaDB 10.11. |
| SEC-SRV-006 | ADAPT | password handling | Use IDENTIFIED BY / WITH plugin with escaped value on all supported servers; drop SELECT PASSWORD() and version branches. |
| SEC-SRV-007 | KEEP | password handling | Mask passwords in displayed and logged SQL while executing real value. |
| SEC-SRV-008 | DROP | PHP internals | setPostAsGlobal is PHP specific; use typed input schema. |
| SEC-SRV-009 | ADAPT | privilege detection | Keep capability detection (can read mysql.user, grant, create user) but via adapter and not session cache; informs UI only. |
| SEC-SRV-010 | DROP | server advisor | Advisor result link rewriting; decide with advisor feature. (owner decision 2026-10-23, feature: server advisor) |
| SEC-SRV-011 | ADAPT | password handling | Keep keep/none/userdefined choices, confirmation and masked display; passwords via parameterized/escaped APIs, never logged. |
| SEC-SRV-012 | ADAPT | known defects | Do not copy listed weaknesses; validate plugin names, sort order, binlog name, skip count as integer, protect replication credentials. |
| UI-SRV-001 | ADAPT | server status | Keep section, text, alerts-only and no-format filters on status variables; categories only if populated. |
| UI-SRV-002 | KEEP | process list | Progress column only on MariaDB, via adapter capability. |
| UI-SRV-003 | KEEP | server variables | Byte variables shown raw and humanized; escape non-numeric values. |
| UI-SRV-004 | KEEP | user management | Lock and unlock accounts with success/error feedback; MySQL 8.4 and MariaDB 10.11 support ACCOUNT LOCK. |
| UI-SRV-005 | KEEP | privilege export | Export of user privileges as GRANT statements from list and user page. |
| UI-SRV-006 | DROP | PHP UI | Sub-navigation active-state tracking is a template detail; DBLoom routing handles it. |
| UI-SRV-007 | ADAPT | database create | Keep create form with charset/collation choice and default marked; permission-gated by server privileges, ShowCreateDb/MaxDbList config dropped. |
| UI-SRV-008 | ADAPT | server monitor | Live monitor chart grid is a whole feature; owner decides. If kept, refresh rates and grid defaults would be redesigned. (owner decision 2026-10-23, feature: server monitor) |
| UI-SRV-009 | ADAPT | process list | Keep optional auto-refresh of process list with selectable interval; implement with client polling, no PHP-style POST/abort mechanics. |
| CON-DTB-001 | ADAPT | table browse count | Keep: never show view totals as exact; make the view count cap a DBLoom setting instead of MaxExactCountViews. |
| CON-DTB-002 | DROP | config storage tables | Reserved column names exist only for LegacyAdmin config-storage tables; DBLoom has its own storage. |
| CON-DTB-003 | ADAPT | table copy | Keep data-only copy not creating target table; drop the config-storage duplication part. |
| CPT-DTB-001 | KEEP | bookmarks and history | Persisted bookmarks, SQL history and saved searches are a feature choice; la_ tables replaced by DBLoom own storage. (owner decision 2026-10-23, feature: bookmarks and history) |
| CPT-DTB-002 | DEFER | tracking | Schema/data change tracking with auto-create is a whole feature the owner must decide. (owner decision 2026-10-23, feature: tracking) |
| DATA-DTB-001 | KEEP | index management | Index type model (primary, unique, index, spatial, fulltext) and loading from information_schema still needed. |
| DATA-DTB-002 | DROP | central columns | Central column dictionary is a standalone feature; owner decides once. (owner decision 2026-10-23, feature: central columns) |
| DATA-DTB-003 | DROP | config storage tables | LegacyAdmin la_ config-storage table list; DBLoom uses its own storage design. |
| DATA-DTB-004 | DEFER | tracking | Tracking data model only matters if tracking is adopted. (owner decision 2026-10-23, feature: tracking) |
| DATA-DTB-005 | DEFER | designer | Designer page storage only matters if the designer is adopted. (owner decision 2026-10-23, feature: designer) |
| DEP-DTB-001 | ADAPT | server family strategy | Keep MySQL vs MariaDB branching via Strategy (ARCH-TGT-002); drop checks for versions below MySQL 8.4 / MariaDB 10.11. |
| DEP-DTB-002 | DROP | legacy server versions | Events exist on all supported servers; version 5.1 check is obsolete. |
| DEP-DTB-003 | KEEP | identifier case handling | Respect lower_case_table_names when creating or renaming databases and tables. |
| FR-DTB-001 | ADAPT | SQL execution | Keep parse, limit, run, count, render flow as an adapter-based pipeline; not PHP controller structure. |
| FR-DTB-002 | ADAPT | table browse | Keep default SELECT * browse with optional primary key order; drop bookmark-as-default-query behaviour. |
| FR-DTB-003 | ADAPT | table browse paging | Keep automatic paging LIMIT only for safe SELECTs; page sizes become DBLoom settings. |
| FR-DTB-004 | KEEP | table browse count | Total row count via COUNT over the unlimited query, skipped when page is not full. |
| FR-DTB-005 | KEEP | table browse count | Use approximate table count and exact count only below threshold; threshold configurable. |
| FR-DTB-006 | ADAPT | table browse paging | Clamp page position after deletes and also for out-of-range browse requests; avoid error-suppression defect. |
| FR-DTB-007 | ADAPT | table browse sorting | Remember per-table sort order, stored in DBLoom user preferences instead of config-storage table properties. |
| FR-DTB-008 | KEEP | query results | Show SHOW WARNINGS output after executed statements. |
| FR-DTB-009 | KEEP | table browse count | Distinguish views from tables; view counts unknown or capped with a lower-bound notice; no data copy for views. |
| FR-DTB-010 | ADAPT | result display | Keep rows per page, long-text truncation and repeated headers as DBLoom preferences, not PHP session tmpval. |
| FR-DTB-011 | KEEP | foreign key editing | Relational column dropdown with browse fallback for large referenced tables in inline edit. |
| FR-DTB-012 | ADAPT | query profiling | Keep query timing; profiling via SHOW PROFILE is deprecated, use performance_schema or EXPLAIN ANALYZE where available. |
| FR-DTB-020 | DROP | PHP request parameters | POST/GET sql_query sources and signed GET are PHP request mechanics; bookmark source handled elsewhere. |
| FR-DTB-021 | ADAPT | SQL multi-statement | Keep running multiple statements with custom delimiter; implement in DBLoom SQL runner and import, not via PHP import route. |
| FR-DTB-022 | ADAPT | SQL rollback | Keep optional transaction wrapper for DML on transactional tables with rollback; implement via explicit transaction in a connection. |
| FR-DTB-023 | ADAPT | query errors | Show server error with failing SQL; optional continue-on-error for multi-statement runs; no mysqlDie page. |
| FR-DTB-024 | DROP | PHP session | PHP session locking does not exist in Node. |
| FR-DTB-025 | KEEP | bookmarks and history | Saving executed queries as bookmarks (replace, all-users) is part of the bookmark feature decision. (owner decision 2026-10-23, feature: bookmarks and history) |
| FR-DTB-026 | KEEP | bookmarks and history | Bookmark placeholder variables only matter if bookmarks are adopted. (owner decision 2026-10-23, feature: bookmarks and history) |
| FR-DTB-027 | ADAPT | bookmarks and history | SQL history stays useful; store per user in DBLoom storage with a configurable cap, not PHP session or la_history. |
| FR-DTB-028 | KEEP | SQL multi-result | Render all result sets from routine calls and report affected rows. |
| FR-DTB-030 | KEEP | database copy rename | Database rename and copy including routines, views, events, triggers and FK handling; no DELIMITER client syntax. |
| FR-DTB-031 | KEEP | database copy rename | Reject empty or identical target names; apply lower_case_table_names rule. |
| FR-DTB-032 | ADAPT | database copy rename | Offer switching to the new database after copy as an in-app navigation choice, not a persisted session flag. |
| FR-DTB-033 | ADAPT | database copy rename | Optional privilege adjustment on copy/rename remains useful; use MySQL 8.4 / MariaDB 10.11 grant tables only. |
| FR-DTB-034 | DROP | config storage tables | Database comment stored in LegacyAdmin relation config storage; MySQL has no native database comment. |
| FR-DTB-040 | KEEP | table creation | Generate and execute CREATE TABLE from columns, keys, partitions and options. |
| FR-DTB-041 | ADAPT | table creation | Keep name syntax validation but also enforce the 64-character identifier limit client-side. |
| FR-DTB-042 | ADAPT | table rename | Second review (Haiku, 10 reviewers, 2026-10-23): RENAME TABLE for tables and views stays; the configuration-storage updates are dropped. |
| FR-DTB-043 | KEEP | table rename | Try native RENAME TABLE first, fall back to copy only on failure. |
| FR-DTB-044 | ADAPT | table copy | Keep structure, constraint, index and auto-increment copy steps; drop export-plugin based implementation. |
| FR-DTB-045 | KEEP | table copy | Copy data with NO_AUTO_VALUE_ON_ZERO, non-generated columns only, nothing for views or structure-only. |
| FR-DTB-046 | ADAPT | config storage tables | Second review (Haiku, 10 reviewers, 2026-10-23): copying column transformations with a copied table stays (DBLoom store); internal relations are deferred with the designer. |
| FR-DTB-047 | ADAPT | table drop | Keep DROP VIEW vs DROP TABLE per object type; drop config-storage cleanup. |
| FR-DTB-048 | KEEP | table truncate | Truncate selected tables, skip views, with confirmation. |
| FR-DTB-049 | KEEP | foreign key checks | Optionally disable FOREIGN_KEY_CHECKS for destructive operations and restore the prior value. |
| FR-DTB-060 | KEEP | column management | Add one or more columns via ALTER TABLE ADD, combined with creation flows. |
| FR-DTB-061 | ADAPT | table options | Keep alter-table options (engine, collation, row format, auto-increment, comment); engine-specific options gated by server product. |
| FR-DTB-062 | ADAPT | column management | Keep column metadata for forms from information_schema; reserved-name reporting for pma tables dropped. |
| FR-DTB-063 | KEEP | index management | Create, edit and drop indexes with validation errors (PRIMARY naming rules); edit drops old index in same ALTER. |
| FR-DTB-064 | KEEP | duplicate indexes | Report redundant duplicate indexes as notices. |
| FR-DTB-065 | KEEP | foreign keys | Native InnoDB FK add/change/drop with RESTRICT default. |
| FR-DTB-066 | DEFER | internal relations | Virtual relations in config storage; product-scope choice, DBLoom has own storage. (owner decision 2026-10-23, feature: designer) |
| FR-DTB-070 | KEEP | views | Create/alter views with algorithm, definer, security, check option. |
| FR-DTB-071 | KEEP | views | Drop/alter views; no backup step needed. |
| FR-DTB-080 | KEEP | routines | Routine browse/create/edit/execute/drop; DBLoom uses own form/SQL building. |
| FR-DTB-081 | KEEP | routines | Routine execute dialog with parameters and result sets. |
| FR-DTB-082 | KEEP | triggers | Trigger create/edit/drop with validation. |
| FR-DTB-083 | KEEP | events | Event management with schedule validation and scheduler status. |
| FR-DTB-084 | ADAPT | routines events triggers | Keep best-effort backup/restore on failed redefinition; wording and implementation become DBLoom's own. |
| FR-DTB-090 | KEEP | database search | Database-wide search with five match types. |
| FR-DTB-091 | KEEP | table search | Table search form with per-column operators. |
| FR-DTB-092 | DROP | zoom search | Scatter-plot zoom search is a separate feature; legacy has injection defect SEC-DTB-005. (owner decision 2026-10-23, feature: zoom search) |
| FR-DTB-093 | KEEP | find and replace | Column find/replace with preview and regex mode. |
| FR-DTB-094 | DROP | query by example | QBE multi-table query builder is a separate feature. (owner decision 2026-10-23, feature: query by example) |
| FR-DTB-095 | DROP | query by example | QBE form and saved searches. (owner decision 2026-10-23, feature: query by example) |
| FR-DTB-100 | ADAPT | table maintenance | Keep CHECK/ANALYZE/CHECKSUM/OPTIMIZE/REPAIR; drop DisableMultiTableMaintenance config key. |
| FR-DTB-101 | DEFER | internal relations | Integrity check only for config-storage relations; depends on virtual relations decision. (owner decision 2026-10-23, feature: designer) |
| FR-DTB-102 | ADAPT | table options | Row format per engine; drop PBXT, Barracuda/legacy InnoDB file format logic. |
| FR-DTB-103 | ADAPT | table options | Keep AUTO_INCREMENT and engine options; gate by server/engine, not legacy detection. |
| FR-DTB-104 | KEEP | table operations | Move/rename/copy table incl. cross-db. |
| FR-DTB-105 | KEEP | table operations | Batch table prefix add/replace. |
| FR-DTB-110 | DEFER | tracking | Tracking versions feature. (owner decision 2026-10-23, feature: tracking) |
| FR-DTB-111 | DEFER | tracking | Tracking statement set. (owner decision 2026-10-23, feature: tracking) |
| FR-DTB-112 | DEFER | tracking | Tracking state management. (owner decision 2026-10-23, feature: tracking) |
| FR-DTB-113 | DEFER | tracking | Tracking report and export. (owner decision 2026-10-23, feature: tracking) |
| FR-DTB-114 | DEFER | tracking | Tracking toggle in UI. (owner decision 2026-10-23, feature: tracking) |
| FR-DTB-120 | DEFER | designer | Designer pages. (owner decision 2026-10-23, feature: designer) |
| FR-DTB-121 | DEFER | designer | Designer relation creation. (owner decision 2026-10-23, feature: designer) |
| FR-DTB-122 | DEFER | designer | Designer FK support inspection. (owner decision 2026-10-23, feature: designer) |
| FR-DTB-123 | DEFER | designer | Designer settings persistence. (owner decision 2026-10-23, feature: designer) |
| FR-DTB-124 | DEFER | designer | Schema export from designer. (owner decision 2026-10-23, feature: designer) |
| FR-DTB-130 | ADAPT | row insert | Keep multi-row insert form; row count default becomes DBLoom setting rather than $cfg. |
| FR-DTB-131 | KEEP | row edit | Per-row UPDATE with unique WHERE and LIMIT 1. |
| FR-DTB-132 | KEEP | row delete | Per-row delete with safe unique condition. |
| FR-DTB-133 | KEEP | row edit | Unique-row condition from PK/unique key or full-row fallback. |
| FR-DTB-134 | ADAPT | row value encoding | Keep per-type value encoding; ProtectBinary becomes a DBLoom setting. |
| FR-DTB-135 | ADAPT | row edit | Inline edit and edit-next flow; no PHP session state, client/URL state instead. |
| FR-DTB-136 | ADAPT | row insert | Report insert id and affected rows, but compute ids correctly (legacy multi-row id adjustment is inexact). |
| FR-DTB-137 | ADAPT | column transformations | Column transformation feature depends on config storage; decide once. (owner decision 2026-10-23, feature: column transformations) |
| FR-DTB-138 | KEEP | SQL preview | Preview generated SQL without executing. |
| FR-DTB-140 | DROP | normalization wizard | Normalization wizard is a separate feature. (owner decision 2026-10-23, feature: normalization wizard) |
| FR-DTB-150 | DEFER | tracking | Tracking capture hook. (owner decision 2026-10-23, feature: tracking) |
| FR-DTB-151 | DEFER | tracking | Tracking statement classification. (owner decision 2026-10-23, feature: tracking) |
| FR-DTB-152 | ADAPT | result pagination | Keep paging/page size/full-partial text/relational display; state in client/user settings not PHP session or $cfg. |
| FR-DTB-153 | ADAPT | result sorting | Keep click-to-sort with multi-column and smart direction; default order becomes a setting. |
| FR-DTB-154 | KEEP | table creation | Create-table guards and column count cap of 4096. |
| FR-DTB-155 | ADAPT | navigation tree | Keep paged tree loading; page sizes become DBLoom settings, no DisableIS variants. |
| FR-DTB-156 | ADAPT | navigation tree | Keep prefix grouping of databases/tables; separators and depth become DBLoom settings. |
| FR-DTB-157 | ADAPT | navigation tree | Keep filter box, natural ordering, hidden items; thresholds become DBLoom settings. |
| FR-DTB-158 | DROP | query by example | QBE form parameters. (owner decision 2026-10-23, feature: query by example) |
| FR-DTB-159 | DROP | query by example | Saved QBE searches. (owner decision 2026-10-23, feature: query by example) |
| FR-DTB-160 | ADAPT | foreign key pickers | Keep related-value dropdown/popup picker; limit and order become DBLoom settings. |
| INT-DTB-001 | SUPERSEDED | database adapter | Replaced by ARCH-TGT-001 Adapter; mysqli DbiExtension is PHP specific. |
| NFR-DTB-001 | KEEP | result pagination | Avoid redundant COUNT queries when page already shows full result. |
| NFR-DTB-002 | KEEP | query error display | Show the true query and true server error; do not apply automatic LIMIT to failing queries. |
| SEC-DTB-001 | ADAPT | signed SQL URLs | Signed GET SQL no longer needed if SQL is not passed in URLs; use server-side state and CSRF protection instead. |
| SEC-DTB-002 | ADAPT | drop database gating | Keep a guard on DROP DATABASE via DBLoom permissions and mandatory confirmation, not a PHP config flag or client-supplied confirm field. |
| SEC-DTB-003 | ADAPT | signed row identifiers | Row identification passed between views must be tamper-proof; use server-side state or signed row keys, not Core::signSqlQuery; fix silent discard. |
| SEC-DTB-004 | ADAPT | raw SQL fragments | Custom WHERE/ORDER power-user input stays but is validated or parsed; run under user's own privileges, parameterize where possible. |
| SEC-DTB-005 | DROP | zoom search limit | Zoom search is dropped; its maxPlotLimit defect goes with it. (consistency pass 2026-10-23, was ADAPT) |
| UI-DTB-001 | DROP | show as PHP | PHP-array code view of queries is PHP-specific; DBLoom may offer copy-as-code differently if wanted. |
| UI-DTB-010 | KEEP | insert/edit pickers | Enum, set and foreign-key value pickers remain useful in insert/edit/search forms. |
| UI-DTB-020 | ADAPT | destructive confirmation | Keep explicit confirmation for destructive actions; implement as UI dialog with server-side check, not localized "Yes" POST value. |
| CPT-IOX-014 | DROP | CodeGen export | Legacy stub C# output; obsolete. |
| DATA-IOX-036 | ADAPT | export templates | Saved named export presets per user stored in DBLoom own app storage, not la_export_templates or Configuration Storage. |
| DATA-IOX-074 | ADAPT | export defaults | Keep sensible SQL export defaults; defaults live in settings design, not PHP cfg keys. |
| DATA-IOX-083 | ADAPT | export defaults | Keep sensible general export defaults; drop PHP ZipDump/GZipDump config; defaults set via DBLoom settings. |
| DATA-IOX-089 | ADAPT | import defaults | Keep sensible import option defaults; defaults set via DBLoom settings, not PHP cfg. |
| FR-IOX-001 | ADAPT | export formats | Offer SQL, CSV, JSON, XML and chosen others; drop CodeGen, PHP array, Texy, Word 2000; remaining formats are an owner scope choice via format registry. |
| FR-IOX-003 | DROP | PHP plugin factory | PHP class-name factory and securePath mechanics; DBLoom uses a closed built-in registry. |
| FR-IOX-004 | DROP | PHP plugin options tree | PHP property-tree rendering; DBLoom defines options in its own registry and UI. |
| FR-IOX-005 | KEEP | export structure or data | Per-format choice of structure, data, or both remains; invalid values rejected rather than silently falling back. |
| FR-IOX-006 | ADAPT | export download mode | Formats without text view are download-only; keep as format capability flag in registry. |
| FR-IOX-007 | ADAPT | SQL export options | Keep SQL dump options (DDL, drop, triggers, routines, FK disable, transaction); drop legacy compatibility modes for old servers and PHP version comment. |
| FR-IOX-008 | KEEP | CSV export | Configurable separator, enclosure, escape, line terminator, NULL string, header row remain. |
| FR-IOX-009 | ADAPT | CSV for Excel | Keep Excel-friendly CSV preset (separator, BOM/encoding); drop legacy Mac Excel 2003/2008 variants. |
| FR-IOX-010 | KEEP | JSON export | Pretty-print and unicode options remain; implemented via native JSON serialization. |
| FR-IOX-011 | DROP | XML export | Second review (Haiku, 10 reviewers, 2026-10-23): XML export dropped (owner decision 2026-10-23). |
| FR-IOX-012 | DROP | document export formats | Second review (Haiku, 10 reviewers, 2026-10-23): LaTeX, ODT, HTML, MediaWiki, Texy, PHP array, YAML, ODS and PDF export dropped; only SQL, CSV and JSON stay. |
| FR-IOX-013 | KEEP | raw query export | Exporting result of a free-typed query remains; unsupported formats report a clear error; filename export.<ext>. |
| FR-IOX-015 | KEEP | export scopes | Server, database, table and query-result export scopes remain; invalid parameter combinations rejected with proper error. |
| FR-IOX-016 | KEEP | database export tables | Database export filters by selected tables; show message when none selected. |
| FR-IOX-017 | KEEP | export locking | Forced structure/data override and optional table read lock with guaranteed unlock remain. |
| FR-IOX-022 | ADAPT | export text view | View export output in read-only viewer with copy; Back/Refresh POST replay is PHP form mechanics and dropped. |
| FR-IOX-024 | DROP | export output handler | Internal PHP buffering/echo/escape structure; DBLoom should stream exports via Node streams. |
| FR-IOX-025 | ADAPT | export compression | Keep zip and gzip output; availability no longer depends on PHP functions or cfg flags. |
| FR-IOX-026 | ADAPT | streaming compression | Compress-on-the-fly becomes native streaming gzip with bounded memory, not a PHP memory budget option. |
| FR-IOX-029 | DROP | export timeout check | PHP max_execution_time workaround; Node streaming has no such timeout endpoint. |
| FR-IOX-030 | ADAPT | save export on server | Optional server-side save to configured directory remains if enabled; keep filename sanitization, overwrite guard, write errors; setting in 12-settings. |
| FR-IOX-031 | KEEP | export file naming | Compressed export gains .zip/.gz extension and matching MIME type; format extension appended when absent. |
| FR-IOX-032 | ADAPT | zip separate files | Keep multi-file zip export with one file per table; implement with Node archive library. |
| FR-IOX-034 | ADAPT | filename templates | Keep filename templates with date and server/db/table/columns placeholders; drop PHP strftime and legacy aliases and LEGACYADMIN token. |
| FR-IOX-035 | ADAPT | remember filename template | Remember template per export scope in per-user settings stored in DBLoom storage, not pma user values. |
| FR-IOX-037 | ADAPT | import sources | Keep pasted SQL and uploaded file sources; bookmarks depend on owner bookmark decision; oversized upload message adapted, no FAQ reference. |
| FR-IOX-038 | ADAPT | import format whitelist | Closed set of import formats stays as registry; final format list is owner scope choice; reject unknown formats. |
| FR-IOX-039 | DROP | PHP import plugin contract | PHP class/factory/global promotion mechanics; replaced by closed built-in importer registry. |
| FR-IOX-040 | ADAPT | SQL import | Keep streaming statement-by-statement SQL import with skip-errors and skip-first-N; use own SQL splitter; resumable timeout handling not needed. |
| FR-IOX-041 | KEEP | CSV import | Delimiters, enclosure, escape, line ending, replace/ignore, partial import, header row, column list, new table/db creation remain. |
| FR-IOX-042 | KEEP | CSV type detection | Column type inference and CREATE TABLE plus INSERT generation for new-table import remains useful. |
| FR-IOX-043 | DROP | ODS import | Second review (Haiku, 10 reviewers, 2026-10-23): ODS import dropped (owner decision 2026-10-23). |
| FR-IOX-044 | DROP | XML import | Second review (Haiku, 10 reviewers, 2026-10-23): XML import dropped with XML export (owner decision 2026-10-23). |
| FR-IOX-045 | DROP | MediaWiki import | Niche format; rarely needed for DB administration. |
| FR-IOX-046 | ADAPT | LOAD DATA import | Keep LOAD DATA INFILE option with LOCAL capability probing; MySQL 8.4 has local_infile off by default, handle accordingly. |
| FR-IOX-047 | DROP | ESRI shapefile import | Niche format depending on PHP dbase extension; obsolete for first release. |
| FR-IOX-048 | ADAPT | import file source | Browser upload plus optional server-side upload directory; keep path traversal and symlink protection; directory configured via settings. |
| FR-IOX-049 | ADAPT | import decompression | Transparent gzip, bzip2 and zip import stays; no PHP extension or cfg gating; bzip2 optional. |
| FR-IOX-050 | KEEP | import BOM handling | Strip UTF-8 and UTF-16 byte-order marks on first chunk; may also use BOM for charset detection. |
| FR-IOX-051 | ADAPT | import file charset | Convert file charset to UTF-8 on read using Node encoding libraries; SET NAMES fallback for missing iconv not needed. |
| FR-IOX-056 | ADAPT | import error handling | Report failing statement with server error and abort unless ignore-errors set; transactional rollback only for transactional tables; no mysqlDie. |
| FR-IOX-057 | KEEP | SQL import | Disable FK checks during import and always restore, including on errors. |
| FR-IOX-058 | ADAPT | SQL import | Keep success summary with count and filename; UI refresh after DDL via client state invalidation, not panel reload. |
| FR-IOX-060 | DROP | upload progress | PECL uploadprogress/PHP session backends are PHP specific; DBLoom uses its own upload progress. |
| FR-IOX-061 | ADAPT | upload progress | Progress feedback for long uploads stays, implemented with browser upload events or streaming, not PHP polling route. |
| FR-IOX-064 | DEFER | GIS visualization | Visualisation fetching spatial columns as WKT belongs to deferred GIS visualisation. (consistency pass 2026-10-23, was ADAPT) |
| FR-IOX-066 | DEFER | GIS visualization | Visualisation canvas size belongs to deferred GIS visualisation. (consistency pass 2026-10-23, was DROP) |
| FR-IOX-067 | DEFER | GIS editor | Spatial data editor with live preview is a feature-scope choice. (owner decision 2026-10-23, feature: gis editor) |
| FR-IOX-068 | DEFER | GIS editor | Visualize GIS data action and spatial cell editing depend on the GIS feature decision. (owner decision 2026-10-23, feature: gis editor) |
| FR-IOX-069 | DROP | export plugin internals | PHP plugin property-tree structure; closed built-in registry replaces it. |
| FR-IOX-070 | ADAPT | export format choice | Default format remembered per user in settings, overridable by URL parameter; no cfg array. |
| FR-IOX-071 | KEEP | CSV export | CSV options: header row, NULL text, separator, enclosure, escape, line terminator, CRLF removal; drop PHP_EOL detail. |
| FR-IOX-072 | ADAPT | CSV export | Excel-compatible CSV variant stays (separator, CRLF, BOM-aware); drop Mac Excel 2003/2008 editions. |
| FR-IOX-073 | KEEP | SQL export | Correct value formatting for NULL, numeric, binary hex, BIT, geometry, strings; INSERT/REPLACE/UPDATE statement types. |
| FR-IOX-075 | ADAPT | JSON export | JSON export stays; header should name DBLoom and version; binary and geometry handling kept. |
| FR-IOX-076 | DROP | XML export | Format dropped: only SQL, CSV and JSON stay (owner decision 2026-10-23): XML export. |
| FR-IOX-077 | DROP | YAML export | Format dropped: only SQL, CSV and JSON stay (owner decision 2026-10-23): YAML export. |
| FR-IOX-078 | DROP | PHP array export | PHP array export is PHP specific. |
| FR-IOX-079 | DROP | LaTeX export | Format dropped: only SQL, CSV and JSON stay (owner decision 2026-10-23): LaTeX export. |
| FR-IOX-080 | DROP | ODS spreadsheet | Format dropped: only SQL, CSV and JSON stay (owner decision 2026-10-23): ODS export. |
| FR-IOX-081 | DROP | Word Texy MediaWiki export | Format dropped: only SQL, CSV and JSON stay (owner decision 2026-10-23): Word, Texy and MediaWiki export. |
| FR-IOX-082 | DROP | PDF export | Format dropped: only SQL, CSV and JSON stay (owner decision 2026-10-23): PDF export. |
| FR-IOX-084 | KEEP | export size filter | Skip tables larger than a given size on database export. |
| FR-IOX-085 | ADAPT | ZIP export | Separate-files ZIP stays with sane entry naming; drop first-dot extension quirk. |
| FR-IOX-086 | ADAPT | export filename template | Filename template with db/table/date tokens stays; replace strftime and legacyadmin tokens with safe own token set. |
| FR-IOX-087 | KEEP | export scope | Server, database and table scope export with selection of databases, tables, structure/data; views after tables. |
| FR-IOX-088 | KEEP | CSV import | Parse CSV with configurable terminator, enclosure, escape, line end, with parameter validation; shown inline not mysqlDie. |
| FR-IOX-090 | DROP | MediaWiki import | Format dropped: only SQL, CSV and JSON stay (owner decision 2026-10-23): MediaWiki import. |
| FR-IOX-091 | DROP | ODS spreadsheet | Format dropped: only SQL, CSV and JSON stay (owner decision 2026-10-23): ODS import. |
| FR-IOX-092 | ADAPT | LOAD DATA import | LOAD DATA import optional, table scope; escape all interpolated values; refuse compressed input unless decompressed first. |
| FR-IOX-095 | ADAPT | upload errors | Clear upload error messages stay for size, partial, missing file; no php.ini references. |
| FR-IOX-097 | DROP | schema export | Format dropped: only SQL, CSV and JSON stay (owner decision 2026-10-23): schema export. |
| FR-IOX-098 | DEFER | GIS editor | GIS editor geometry types and SRID follow the GIS feature decision. (owner decision 2026-10-23, feature: gis editor) |
| FR-IOX-099 | DEFER | GIS visualization | GIS visualization output formats follow the GIS feature decision; GD/PDF are PHP specific. (owner decision 2026-10-23, feature: gis editor) |
| FR-IOX-100 | KEEP | DML simulation | Dry-run affected row count for single-table UPDATE/DELETE. |
| FR-IOX-101 | ADAPT | SQL query box | SQL editor runs queries via its own API, not an import route; keep bookmark/parameter support per other decisions. |
| INT-IOX-002 | DROP | export plugin internals | PHP plugin class contract; internal registry design replaces it. |
| INT-IOX-062 | DEFER | GIS internals | Geometry factory is part of the deferred GIS layer. (consistency pass 2026-10-23, was DROP) |
| INT-IOX-063 | DEFER | GIS internals | Per-geometry rendering and WKT methods belong to deferred GIS editor/visualisation. (consistency pass 2026-10-23, was DROP) |
| INT-IOX-065 | DEFER | GIS internals | GisVisualization rendering is the deferred GIS visualisation feature. (consistency pass 2026-10-23, was DROP) |
| NFR-IOX-023 | ADAPT | export keepalive | Long buffered exports need keepalive or streaming to avoid proxy timeouts; use streaming instead of X-pmaPing. |
| NFR-IOX-027 | DROP | PHP memory limit | Derived from PHP memory_limit; Node uses streaming. |
| NFR-IOX-028 | DROP | PHP time limit | PHP execution time and session error stamp are PHP specific. |
| NFR-IOX-052 | ADAPT | import streaming | Import must stream in chunks with bounded memory; chunk sizes are implementation choice. |
| NFR-IOX-053 | DROP | PHP memory limit | read_limit derived from PHP memory_limit. |
| NFR-IOX-054 | DROP | PHP time limit | max_execution_time based timeout handling is PHP specific. |
| NFR-IOX-055 | ADAPT | import resume | Resumable large imports stay as need; use job-based import with offset, not resubmitting the file. |
| NFR-IOX-059 | DROP | PHP time limit | PHP time and memory limits do not apply. |
| NFR-IOX-093 | DROP | import streaming | Second review (Haiku, 10 reviewers, 2026-10-23): buffering rule for the XML and ODS importers, both dropped. |
| NFR-IOX-094 | ADAPT | upload size limit | Configurable max upload size shown in UI, enforced server-side; not php.ini based. |
| SEC-IOX-033 | ADAPT | download filename | Sanitize download filenames against traversal and header injection; drop url_rewriter. |
| SEC-IOX-096 | KEEP | import injection | Do not interpolate unescaped LDI terminators, charset names or USE detection; validate or quote all. |
| UI-IOX-018 | ADAPT | export UI | Quick versus Custom export modes stay; preference stored in user settings. |
| UI-IOX-019 | KEEP | export UI | Format dropdown with option panel per selected format. |
| UI-IOX-020 | KEEP | export UI | Single-table export row range selection with record count and LIMIT. |
| UI-IOX-021 | ADAPT | export UI | Save-as-file/view-as-text, charset, compression, filename template, separate files, size filter stay; drop kanji and server-save unless decided. |
| CON-SAU-087 | DROP | PHP version support | PHP version branches irrelevant to Node stack. |
| CPT-SAU-090 | DROP | PHP version support | PHP version and session-extension checks do not apply. |
| DATA-SAU-047 | SUPERSEDED | 2FA storage | 2FA data storage is covered by SEC-TGT-011/012; la_ tables never used. (consistency pass 2026-10-23, was ADAPT) |
| DATA-SAU-083 | SUPERSEDED | session secrets | PHP session keys replaced by DBLoom key ring, CSRF and session design (SEC-TGT-081/082). |
| DEP-SAU-079 | DROP | PHP header dispatch | PHP header() mechanics; DBLoom sets security and no-cache headers in its own server layer. |
| DEP-SAU-084 | DROP | blowfish secret | Blowfish secret is PHP config; replaced by master secret (ST-052, SEC-TGT-081). |
| DEP-SAU-091 | DROP | PHP 2FA libraries | Composer packages irrelevant; TypeScript libraries chosen separately. |
| FR-SAU-001 | SUPERSEDED | auth plugin types | DBLoom uses own accounts plus connection profiles (SEC-TGT-018/019), no auth_type plugins. |
| FR-SAU-002 | DROP | auth plugin types | Plugin class lookup error is a PHP mechanic. |
| FR-SAU-004 | ADAPT | login restrictions | Keep ability to deny root and empty-password DB logins as settings; drop AllowDeny host rules mechanism. |
| FR-SAU-005 | ADAPT | login errors | Keep friendly failure messages and idle-timeout notice; escape output via framework, no cfg names. |
| FR-SAU-006 | ADAPT | login audit | Failed logins go to DBLoom audit log with username and reason code. |
| FR-SAU-007 | SUPERSEDED | config auth | Config-file credentials replaced by profiles with vault or account login (SEC-TGT-018/019). |
| FR-SAU-008 | DROP | config auth | Config-auth connection failure page; DBLoom shows its own connection error UI. |
| FR-SAU-009 | DROP | HTTP basic auth | HTTP auth type not offered; reverse-proxy auth not in scope. |
| FR-SAU-010 | DROP | HTTP basic auth | PHP server variable fallback chain for HTTP auth. |
| FR-SAU-012 | DROP | HTTP basic auth | HTTP auth logout trick not needed. |
| FR-SAU-013 | DEFER | single sign-on | Signon via shared PHP session; whether DBLoom offers SSO/OIDC is an owner scope choice. (owner decision 2026-10-23, feature: single sign-on) |
| FR-SAU-014 | DROP | single sign-on | PHP session HMAC secret handling for signon. |
| FR-SAU-015 | DROP | single sign-on | PHP session cookie parameter defaults for signon session. |
| FR-SAU-016 | DEFER | single sign-on | Signon application switching rule depends on whether SSO is offered. (owner decision 2026-10-23, feature: single sign-on) |
| FR-SAU-017 | DROP | single sign-on | Including arbitrary PHP script is incompatible with closed registry and no plugin loading. |
| FR-SAU-018 | DEFER | single sign-on | Signon error echo and redirect depends on SSO decision. (owner decision 2026-10-23, feature: single sign-on) |
| FR-SAU-019 | SUPERSEDED | login cookie auth | Encrypted credential cookies replaced by DBLoom sessions and vault (SEC-TGT-*). |
| FR-SAU-021 | DROP | login cookie auth | Cookie encryption key derivation from blowfish_secret; replaced by key ring. |
| FR-SAU-022 | DROP | login cookie auth | Per-session sodium key in PHP session. |
| FR-SAU-023 | SUPERSEDED | login cookie auth | Password cookie payload not used; DB passwords held in vault or server-side session. |
| FR-SAU-026 | ADAPT | login failure | Keep no-store caching headers on failed login and discarding any session credentials; no cookie. |
| FR-SAU-027 | ADAPT | logout | Logout destroys server session and credentials; per-server cookie deletion dropped. |
| FR-SAU-028 | SUPERSEDED | arbitrary server login | Free host entry replaced by connection profiles; ad-hoc connection per profile design. |
| FR-SAU-029 | ADAPT | password change | After changing own DB or account password, refresh stored session or vault credential. |
| FR-SAU-032 | DROP | PHP sessions | PHP session bootstrap and cookie naming; DBLoom has own session design. |
| FR-SAU-035 | DROP | idle timeout | Per-window access time in PHP session; replaced by server-side session activity tracking. |
| FR-SAU-036 | ADAPT | idle timeout | Keep inactivity logout and clearing cached privileges; use DBLoom session idle timeout setting. |
| FR-SAU-037 | ADAPT | idle timeout | Idle timeout may be configurable within environment bounds, not per-user cfg override. |
| FR-SAU-039 | KEEP | logout | Logout must be POST with CSRF protection. |
| FR-SAU-042 | ADAPT | session expiry relogin | Re-login after expiry without losing page state; CSRF token refresh handled by framework. |
| FR-SAU-043 | DROP | CSRF URL token | Token in every URL is a PHP pattern; DBLoom uses header or cookie based CSRF. |
| FR-SAU-044 | DROP | PHP sessions | PHP session cookie warning; replaced by DBLoom HTTPS and origin checks (ST-006). |
| FR-SAU-045 | SUPERSEDED | two-factor auth | 2FA login gate is specified by SEC-TGT-011..014. (consistency pass 2026-10-23, was ADAPT) |
| FR-SAU-046 | SUPERSEDED | two-factor auth | 2FA configuration storage is covered by SEC-TGT-011..014. (consistency pass 2026-10-23, was ADAPT) |
| FR-SAU-048 | SUPERSEDED | two-factor auth | 2FA backends replaced by passkeys and TOTP per SEC-TGT-011..014. (consistency pass 2026-10-23, was ADAPT) |
| FR-SAU-049 | SUPERSEDED | two-factor auth | Fail-closed 2FA is covered by the target security requirements. (consistency pass 2026-10-23, was KEEP) |
| FR-SAU-050 | ADAPT | two-factor auth | Caching of a successful second-factor check for the session is not yet in SEC-TGT-011 to 014; rewrite for DBLoom sessions. (consistency pass 2026-10-23) |
| FR-SAU-051 | SUPERSEDED | two-factor auth | Passkey and TOTP enrolment are specified in SEC-TGT-011 to 014. Changed from ADAPT after the sample review. |
| FR-SAU-052 | SUPERSEDED | two-factor auth | 2FA enrolment flow is covered by SEC-TGT-011..014. (consistency pass 2026-10-23, was KEEP) |
| FR-SAU-054 | SUPERSEDED | TOTP | TOTP enrolment and QR code are specified in SEC-TGT-012. Changed from KEEP after the sample review. |
| FR-SAU-055 | SUPERSEDED | FIDO U2F | U2F is covered by passkeys and TOTP in SEC-TGT-011..014. (consistency pass 2026-10-23, was DROP) |
| FR-SAU-058 | SUPERSEDED | WebAuthn passkeys | Authenticator selection is fully decided by the DBLoom passkey spec SEC-TGT-011. (consistency pass 2026-10-23, was ADAPT) |
| FR-SAU-059 | SUPERSEDED | WebAuthn passkeys | Assertion validation is covered by SEC-TGT-011 passkey spec. (consistency pass 2026-10-23, was KEEP) |
| FR-SAU-060 | SUPERSEDED | WebAuthn passkeys | Registration handling is covered by SEC-TGT-011 passkey spec. (consistency pass 2026-10-23, was ADAPT) |
| FR-SAU-061 | ADAPT | WebAuthn passkeys | Single-use passkey challenges are not yet stated in SEC-TGT-011; rewrite for DBLoom. (consistency pass 2026-10-23) |
| FR-SAU-062 | SUPERSEDED | WebAuthn passkeys | Credential storage is defined by the new passkey spec. (consistency pass 2026-10-23, was ADAPT) |
| FR-SAU-063 | SUPERSEDED | WebAuthn passkeys | Passkey user handle and enrolment screens are defined by SEC-TGT-011. (consistency pass 2026-10-23, was ADAPT) |
| FR-SAU-064 | SUPERSEDED | WebAuthn passkeys | 2FA failure messaging belongs to the new passkey and TOTP spec. (consistency pass 2026-10-23, was ADAPT) |
| FR-SAU-065 | SUPERSEDED | WebAuthn passkeys | RP id and TOTP issuer are defined by SEC-TGT-011/012. (consistency pass 2026-10-23, was ADAPT) |
| FR-SAU-066 | DROP | URL query encryption | PHP sodium/session key mechanism; DBLoom keeps state server-side instead (SEC-TGT-114). |
| FR-SAU-072 | ADAPT | external links | Keep Referer-leak protection for external links via Referrer-Policy/noreferrer; no url.php redirector needed. See SEC-TGT-043. |
| FR-SAU-073 | ADAPT | SQL file import | Keep import format allow-list and server-side file handling; drop PHP upload variable mechanics. |
| FR-SAU-074 | ADAPT | upload limit message | Show clear error when upload exceeds configured size limit; no PHP empty-request heuristic or session message. |
| FR-SAU-082 | SUPERSEDED | PHP PSR-7 request | WebAuthn request handling is covered by the new passkey spec. (consistency pass 2026-10-23, was DROP) |
| FR-SAU-088 | ADAPT | language and theme prefs | Persist language/theme per user profile or browser; no pma_lang cookie naming. |
| FR-SAU-089 | ADAPT | client IP trusted proxies | Client IP resolved only via configured trusted proxies, validated; CIDR support. See DEP-TGT-122 and .env settings. |
| FR-SAU-200 | SUPERSEDED | session inactivity | Idle timeout and absolute lifetime configurable per SEC-TGT-041; client expiry handling shows re-login. |
| FR-SAU-203 | SUPERSEDED | IP allow deny | Replaced by allow/deny lists in inbound exposure requirements (DEP-TGT-122 context, SEC-TGT section 13); fixes CIDR defect. |
| FR-SAU-204 | DROP | HTTP auth | HTTP basic auth mode not in DBLoom; own login per SEC-TGT-010. |
| FR-SAU-209 | SUPERSEDED | 2FA enablement | Replaced by SEC-TGT-012/013/014 with administrator enforcement policy. |
| FR-SAU-210 | SUPERSEDED | WebAuthn server variants | No unverified fallback; DEP-TGT-091 requires failing startup, full signature verification. |
| INT-SAU-003 | DROP | auth plugin contract | PHP class structure; DBLoom has own auth design in SEC-TGT-010. |
| INT-SAU-038 | DROP | url.php minimal controller | PHP front-controller detail. |
| INT-SAU-057 | SUPERSEDED | WebAuthn PHP interface | WebAuthn server interface is part of the superseded 2FA design; SEC-TGT-011 specifies passkeys. (consistency pass 2026-10-23, was DROP) |
| INT-SAU-080 | DROP | PSR-7 requests | PHP library selection detail. |
| INT-SAU-081 | DROP | PHP URI reconstruction | PHP superglobal handling; public origin comes from settings and trusted proxy config. |
| NFR-SAU-085 | ADAPT | error disclosure | Keep: login failures never leak internals, DB error text escaped, server paths not shown. |
| NFR-SAU-086 | DROP | PHP testsuite exits | PHP TESTSUITE constant detail; testability handled by normal test design. |
| NFR-SAU-318 | ADAPT | CSPRNG tokens | Keep CSPRNG for tokens, challenges and secrets via Node crypto; drop printable-ASCII masking. |
| SEC-SAU-011 | DROP | PHP_AUTH_PW removal | PHP phpinfo and superglobal specific. |
| SEC-SAU-020 | ADAPT | encrypted cookie payload | Keep authenticated encryption for any stored secrets (vault, session); use AEAD in Node, no cookie-held credentials. See SEC-TGT-020. |
| SEC-SAU-024 | ADAPT | password length limit | Keep a maximum password length against DoS; value chosen by DBLoom, applied to all login forms, reasonable limit with hashing. |
| SEC-SAU-025 | ADAPT | username host sanitising | Keep NUL stripping and target host validation against allowed target list (SSRF); no p: prefix or regex setting. |
| SEC-SAU-031 | DROP | login captcha | Optional captcha on login is a product-scope choice; rate limiting exists in SEC-TGT-017. (owner decision 2026-10-23, feature: login captcha) |
| SEC-SAU-033 | SUPERSEDED | session cookie flags | Replaced by SEC-TGT-040 (HttpOnly, Secure, SameSite, __Host- prefix). |
| SEC-SAU-034 | SUPERSEDED | session fixation | Session regenerated at login and privilege change per SEC-TGT-040. |
| SEC-SAU-040 | SUPERSEDED | CSRF token | Replaced by SEC-TGT-042 CSRF protection for all state-changing requests. |
| SEC-SAU-041 | SUPERSEDED | CSRF validation POST only | SEC-TGT-042 covers every method; fixes POST-only defect. |
| SEC-SAU-067 | ADAPT | decryption failure handling | Keep: any failed decrypt or verify yields invalid input, never throws to user; applies to vault and tokens. |
| SEC-SAU-068 | DROP | PHP direct-execution guards | PHP include guards; not applicable. |
| SEC-SAU-069 | DROP | PATH_INFO stripping | PHP front-controller path inflation; router handles paths. |
| SEC-SAU-070 | ADAPT | redirect target validation | Keep: goto/back/return targets validated against internal route allow-list to prevent open redirects. |
| SEC-SAU-071 | ADAPT | external redirect allow-list | External links open with noreferrer to https allow-listed docs hosts at most; no url.php redirector needed. |
| SEC-SAU-075 | DROP | LOAD DATA LOCAL gating | Local-infile PHP define; local infile handling decided by import design and adapter settings. |
| SEC-SAU-076 | SUPERSEDED | anti-clickjacking | SEC-TGT-043 frame protection headers; framing opt-out via settings. |
| SEC-SAU-077 | SUPERSEDED | security headers | SEC-TGT-043 header set (Referrer-Policy, nosniff, no-store); X-XSS-Protection obsolete. |
| SEC-SAU-078 | SUPERSEDED | Content-Security-Policy | SEC-TGT-043 strict nonce-based CSP, no inline or eval; legacy CSP variants dropped. |
| SEC-SAU-201 | SUPERSEDED | cookie attributes | SEC-TGT-040 session cookie rules; only session cookie plus optional prefs, no 30-day username cookies. |
| SEC-SAU-202 | ADAPT | login failure messages | Keep generic denial messages not revealing rules and idle-logout notice; drop AllowNoPassword wording. |
| SEC-SAU-205 | DROP | signon script | PHP include of signon script; external SSO handled by OIDC/other auth decisions, not PHP scripts. |
| SEC-SAU-206 | SUPERSEDED | no brute-force protection | Replaced by SEC-TGT-017 rate limiting with backoff and logging; defect not carried over. |
| SEC-SAU-207 | DROP | cookie crypto parameters | PHP sodium/blowfish_secret detail; DBLoom uses own secret handling in .env/settings. |
| SEC-SAU-208 | DROP | captcha null defect | Known PHP defect; not to be preserved. |
| SEC-SAU-300 | DROP | URL query encryption | Replaced by server-side state and opaque identifiers (SEC-TGT-114). |
| SEC-SAU-301 | ADAPT | message sanitising | Keep safe rendering of messages: escape by default, no raw HTML; limited formatting and safe links only. |
| SEC-SAU-302 | SUPERSEDED | IP allow deny rules | Replaced by inbound allow/deny lists in SEC-TGT section 13.3; see SEC-SAU-203. |
| SEC-SAU-303 | SUPERSEDED | CIDR mask defect | Defect not carried over; use verified CIDR library (NFR-TGT-122). |
| SEC-SAU-304 | ADAPT | path traversal protection | Keep: user-influenced file names never reach filesystem unsanitised; use identifiers and resolved-path containment instead of dot replacing. |
| SEC-SAU-305 | ADAPT | import file security | Keep upload validation, symlink rejection, readability checks, server-dir containment; drop PHP is_uploaded_file mechanics. |
| SEC-SAU-306 | SUPERSEDED | U2F key backend | U2F backend replaced by passkeys; single-use challenges covered in SEC-TGT-011. (consistency pass 2026-10-23, was DROP) |
| SEC-SAU-307 | ADAPT | download headers | Keep sanitised filename, Content-Disposition attachment, correct type, no-cache for downloads; drop obsolete headers. |
| SEC-SAU-308 | ADAPT | JS output encoding | Keep context-aware output encoding; React escapes by default, JSON embedding must escape script-breaking sequences. |
| SEC-SAU-309 | DROP | safeUnserialize | PHP serialization specific; DBLoom stores JSON. |
| SEC-SAU-310 | DROP | SQL query signing | PHP session HMAC mechanism; DBLoom does not pass SQL text through URLs, uses its own session and CSRF design. |
| SEC-SAU-311 | ADAPT | identifier escaping | Keep backtick quoting with doubled backticks; drop MSSQL compat mode. Implement in the MySQL/MariaDB adapter. |
| SEC-SAU-312 | SUPERSEDED | login cookie auth | Cookie attributes (Secure, HttpOnly, SameSite) covered by DBLoom session design in 11-target-security.md (SEC-TGT-*). |
| SEC-SAU-313 | ADAPT | routing | Keep 404 for unknown route and 405 for wrong method semantics; implemented by TanStack Start router, no PHP route table. |
| SEC-SAU-314 | KEEP | outbound HTTP TLS | Outbound requests (updates, AI provider calls) must verify TLS certificates and hostnames. |
| SEC-SAU-315 | DROP | error reporting | Sends reports to LegacyAdmin project server; irrelevant. Any DBLoom diagnostics would be separate. |
| SEC-SAU-316 | ADAPT | redirect hygiene | Redirect only to internal targets, never user-supplied external URLs; PHP session close and IIS details dropped. |
| SEC-SAU-317 | DROP | request var cleanup | PHP $_REQUEST/$_GET handling; DBLoom validates input with typed schemas. |
| SEC-SAU-319 | ADAPT | binlog viewer | Defect: raw log name concatenated. Validate log name against SHOW BINARY LOGS list and bind/quote it; cast position to integer. |
| SEC-SAU-320 | ADAPT | input validation | Defect: unvalidated LIMIT. Parse limits as non-negative integers server-side and never append raw text to generated SQL. |
| SEC-SAU-321 | SUPERSEDED | authorization model | Legacy has no route authorization; DBLoom defines authn/authz for all routes in 11-target-security.md (SEC-TGT-*). |
| SEC-SAU-322 | ADAPT | privilege detection | Defect: mysql.user readability is not SUPER. Determine capabilities via SHOW GRANTS or per-feature probes, with cache invalidation. |
| SEC-SAU-323 | ADAPT | process list | Defect: unvalidated sort direction. Allow only ASC/DESC and a whitelist of columns. |
| SEC-SAU-324 | SUPERSEDED | CSRF protection | DBLoom CSRF design in 11-target-security.md; state changes must never happen via GET. |
| SEC-SAU-325 | SUPERSEDED | two-factor auth | Whether DBLoom offers TOTP 2FA is a product choice; if yes, narrow window and add replay and attempt limits. (owner decision 2026-10-23, feature: two-factor auth) |
| UI-SAU-030 | ADAPT | login form | Login with connection profile selection and session-expired re-login modal; no reCAPTCHA, PHP session id field or server selector. |
| UI-SAU-053 | SUPERSEDED | two-factor auth | Applies only if 2FA is offered; confirmation screen with backend-specific submit button. (owner decision 2026-10-23, feature: two-factor auth) |
| UI-SAU-056 | SUPERSEDED | two-factor auth | U2F screens replaced by WebAuthn passkeys. (consistency pass 2026-10-23, was DROP) |
| CON-PLG-001 | DROP | plugin authoring | Authoring recipe for PHP plugin classes; DBLoom has a closed built-in registry (FU-006). |
| CON-PLG-002 | DROP | plugin authoring | PHP transformation class authoring contract; no third-party plugin system. |
| CPT-PLG-001 | DROP | plugin taxonomy | Describes PHP directory and base class structure of plugin families. |
| CPT-PLG-002 | DROP | plugin taxonomy | PHP interface describing plugin internals. |
| CPT-PLG-003 | DROP | plugin taxonomy | PHP property object internals; DBLoom uses its own typed registry. |
| CPT-PLG-004 | DROP | plugin taxonomy | PHP options tree class model; internal structure only. |
| CPT-PLG-005 | DROP | column transformations | PHP file-name naming convention for transformation classes; internal detail. |
| CPT-PLG-006 | ADAPT | column transformations | MIME Type/Subtype naming only matters if browser transformations are offered; file-name part is PHP specific. (owner decision 2026-10-23, feature: column transformations) |
| DATA-PLG-001 | ADAPT | export import defaults | Per-format option defaults remain useful but live in DBLoom settings (12-settings.md), not config.inc.php sections. |
| DATA-PLG-002 | ADAPT | column transformations | Bundled transformation set depends on whether the transformations feature is adopted. (owner decision 2026-10-23, feature: column transformations) |
| DATA-PLG-003 | ADAPT | export formats | Export formats list stays a product scope decision per format; closed built-in registry, no PHP classes; drop PHP array/Excel legacy as needed. |
| DATA-PLG-004 | ADAPT | import formats | Bundled import formats via closed registry; SHP, LDI and upload-progress plugin variants are scope decisions, no PHP upload backends. |
| DATA-PLG-005 | DEFER | schema diagram export | Relational schema export (Dia/EPS/PDF/SVG) is part of the designer/schema feature choice. (owner decision 2026-10-23, feature: designer) |
| DATA-PLG-006 | SUPERSEDED | login cookie auth | Auth and 2FA plugins replaced by DBLoom own accounts and auth design in 11-target-security.md. |
| DATA-PLG-007 | DROP | plugin option API | PHP property class API; internal detail. |
| DATA-PLG-008 | ADAPT | column transformations | Per-column MIME/transformation persistence belongs to the transformations feature; would need DBLoom own storage, not LegacyAdmin column_info. (owner decision 2026-10-23, feature: column transformations) |
| DEP-PLG-001 | DROP | PDF export runtime | TCPDF and curl PHP dependencies; PDF export tooling would be chosen separately. |
| DEP-PLG-002 | DROP | config storage dependency | Depends on LegacyAdmin configuration storage; DBLoom has own app storage. |
| DEP-PLG-003 | DROP | upload progress | PHP uploadprogress extension backends; browser provides upload progress natively. |
| FR-PLG-001 | DROP | plugin loader | PHP class-name convention instantiation. |
| FR-PLG-002 | DROP | plugin loader | PHP global $plugin_param context injection. |
| FR-PLG-003 | DROP | plugin loader | Directory scan discovery; DBLoom uses a closed registry. |
| FR-PLG-004 | DROP | plugin loader | PHP class and subclass admittance check. |
| FR-PLG-005 | ADAPT | export import availability | Keep scope rules: XML export only for db/table scope, LDI-style import only in table scope; no TCPDF/curl checks. |
| FR-PLG-006 | ADAPT | export import formats | Format lists shown in UI sorted by localized label; trivial UI ordering. |
| FR-PLG-007 | DROP | plugin loader | PHP manager entry points. |
| FR-PLG-008 | DROP | plugin lifecycle | PHP DI container and constructor lifecycle. |
| FR-PLG-009 | DROP | plugin lifecycle | Abstract PHP method list; implementation structure only. |
| FR-PLG-010 | DROP | plugin lifecycle | PHP optional method defaults; implementation structure only. |
| FR-PLG-011 | ADAPT | export aliases | User need to rename db/table/column in exports stays if aliases are kept; relation string helper is internal. |
| FR-PLG-012 | ADAPT | import formats | Keep: when a database is already selected, import must not emit CREATE DATABASE; PHP doImport contract dropped. |
| FR-PLG-013 | DEFER | schema diagram export | Schema export contract belongs to the designer/schema export feature decision. (owner decision 2026-10-23, feature: designer) |
| FR-PLG-014 | ADAPT | export option validation | Accept only known, typed export options via server-side schema validation instead of copying POST keys into globals. |
| FR-PLG-015 | DROP | plugin option form | PHP POST key naming and global read-back; DBLoom uses typed form state. |
| FR-PLG-016 | ADAPT | export import defaults | Keep defaults precedence idea (saved settings, repopulate after timeout) using 12-settings.md; drop str* placeholder substitution. |
| FR-PLG-017 | DROP | plugin option form | PHP checkbox state resolution via request globals. |
| FR-PLG-018 | DROP | plugin chooser | PHP chooser data structure; UI format selector built from typed registry. |
| FR-PLG-019 | ADAPT | export format default | Default export format preselected (SQL), overridable by request parameter; stored as DBLoom setting rather than PHP config key. |
| FR-PLG-020 | ADAPT | import format default | Default import format SQL, overridable per page; setting via DBLoom settings, not cfg Import format. |
| FR-PLG-021 | ADAPT | format options UI | Per-format options panel stays, rendered by React components from a registry; no Twig div ids; empty-options message kept. |
| FR-PLG-022 | DROP | plugin option rendering | Recursive PHP property-tree HTML rendering; DBLoom uses typed React option schemas. |
| FR-PLG-023 | ADAPT | format options UI | Option types (bool, text, number, select, radio, hidden) map to form widgets; implemented via schema-driven React form. |
| FR-PLG-024 | ADAPT | format options UI | Inline help links per option kept as tooltips/doc links; no PHP doc array formats. |
| FR-PLG-025 | ADAPT | column transformations | Display/input transformations on columns is a whole feature (needs config storage); owner decides once. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-026 | ADAPT | column transformations | Input transformation state contract; part of the transformations feature decision. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-027 | DROP | PHP plugin loading | Maps stored pseudo-path to PHP class names; PHP-specific. |
| FR-PLG-028 | ADAPT | column transformations | Transformation options string parsing; relevant only if transformations feature is adopted (would use structured JSON). (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-029 | DROP | PHP plugin loading | Directory scan of PHP files for discovery; DBLoom uses closed built-in registry. |
| FR-PLG-030 | ADAPT | column transformations | Per-column transformation persistence read from column_info; depends on transformations feature decision. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-031 | ADAPT | column transformations | Per-column transformation persistence write; depends on transformations feature decision. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-032 | ADAPT | column transformations | Cascade cleanup of stored transformations on drop; depends on transformations feature decision. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-033 | DROP | PHP plugin loading | Legacy MIME name case fixup for old stored names; no legacy data in new app. |
| FR-PLG-034 | ADAPT | column transformations | Apply transformations to browse cells; depends on transformations feature decision. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-035 | ADAPT | column transformations | Input transformation and validation on row save; depends on transformations feature decision. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-036 | ADAPT | column transformations | Per-family default transformation options; depends on transformations feature decision. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-037 | ADAPT | column transformations | Bool2Text display transformation; depends on transformations feature decision. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-038 | ADAPT | column transformations | DateFormat display transformation; depends on transformations feature decision. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-039 | ADAPT | column transformations | Download display transformation; depends on transformations feature decision. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-040 | DROP | external program transform | Runs external programs on server; unsafe and disabled by default in legacy. Not carried over. |
| FR-PLG-041 | ADAPT | column transformations | Formatted HTML in sandboxed iframe transformation; depends on transformations feature decision. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-042 | ADAPT | column transformations | Hex display transformation; depends on transformations feature decision. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-043 | ADAPT | column transformations | Image BLOB link transformation; depends on transformations feature decision. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-044 | ADAPT | column transformations | Inline image thumbnail transformation; depends on transformations feature decision (GD check droppable). (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-045 | ADAPT | column transformations | IP address conversion transformations; depends on transformations feature decision. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-046 | ADAPT | column transformations | PreApPend display transformation; depends on transformations feature decision. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-047 | ADAPT | column transformations | Substring display transformation; depends on transformations feature decision. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-048 | ADAPT | column transformations | Image link transformation; depends on transformations feature decision. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-049 | ADAPT | column transformations | Text link transformation; depends on transformations feature decision. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-050 | ADAPT | column transformations | SQL highlighting transformation; depends on transformations feature decision. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-051 | ADAPT | column transformations | JSON/XML pretty display transformation; depends on transformations feature decision. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-052 | ADAPT | column transformations | Regex validation input transformation; depends on transformations feature decision. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-053 | ADAPT | column transformations | Code editor input transformations; depends on transformations feature decision. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-054 | ADAPT | column transformations | File and image upload input widgets; depends on transformations feature decision. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-055 | DROP | PHP plugin loading | Table mapping PHP class names to MIME/name; PHP class naming detail. |
| FR-PLG-056 | ADAPT | column transformations | Wrapper route serving binary/derived content with signed where clause; depends on transformations feature decision. (owner decision 2026-10-23, feature: column transformations) |
| FR-PLG-057 | ADAPT | format availability | Format availability rules by scope kept (XML needs a database, LDI at table scope); drop TCPDF/PDF and legacy schema formats. |
| FR-PLG-058 | DROP | PHP plugin loading | Stored-name case round trip quirk of legacy lowercase storage; defect-like, not needed. |
| INT-PLG-001 | ADAPT | export option page | Export page composes format chooser and options for server/db/table scopes; implemented in React/server functions. |
| INT-PLG-002 | ADAPT | format binding | Server re-resolves the chosen format from registry and rejects unknown formats with an error; no PHP includes. |
| INT-PLG-003 | ADAPT | format binding | Import resolves importer from closed registry by validated format; unknown format gives clear error. |
| INT-PLG-004 | ADAPT | format binding | Query box, SQL file and saved query runs force SQL format; otherwise posted format used. |
| INT-PLG-005 | ADAPT | format binding | Format options vary by scope (server/database/table, export type); keep scope context in registry typing. |
| INT-PLG-006 | ADAPT | format options UI | Shared option panels for export, import pages; option names namespaced per format. Designer dialog depends on designer decision. |
| NFR-PLG-001 | DROP | PHP plugin loading | File-name convention for auto-enumerated PHP transformation files. |
| NFR-PLG-002 | DROP | PHP plugin loading | Per-request static cache of directory scan; no scan in DBLoom. |
| NFR-PLG-003 | DROP | PHP plugin loading | Static PHP availability methods; internal code structure. |
| NFR-PLG-004 | ADAPT | column transformations | Bound requested thumbnail size (2000px clamp) if image preview exists; apply to any image resize endpoint. |
| SEC-PLG-001 | ADAPT | format binding | Validate format keys against closed registry allowlist; no path sanitization needed since no dynamic includes. |
| SEC-PLG-002 | ADAPT | import file safety | Server-side import file selection must be confined to a configured directory without traversal or symlink escape; see FR-IOX-048. |
| SEC-PLG-003 | ADAPT | export option allowlist | Only declared registry options accepted from requests; validate against schema instead of PHP POST allow-list. |
| SEC-PLG-004 | DROP | PHP plugin loading | Physical file existence check before instantiating PHP class; closed registry replaces it. |
| SEC-PLG-005 | DROP | external program transform | External-program transformation not carried over; no server-side command execution from stored options. |
| SEC-PLG-006 | SUPERSEDED | auth plugin dispatch | PHP class-name dispatch; DBLoom uses own account/vault authentication design in 11-target-security.md (SEC-TGT-*). |
| SEC-PLG-007 | ADAPT | column transformations | Need to HTML-escape transformed values stays; realise via framework escaping, and render raw HTML only in a sandboxed iframe. |
| SEC-PLG-008 | ADAPT | column transformations | Keep signed row addressing, clamped image sizes, sanitized links with noopener; implement in Node endpoint, not PHP wrapper controller. |
| UI-PLG-001 | DROP | plugin option forms | PHP form-element id naming for plugin options; DBLoom builds forms in its own components. |
| UI-PLG-002 | DEFER | plugin option forms | Schema plugin options are used by the Designer export dialog, which is deferred. (consistency pass 2026-10-23, was DROP) |
| UI-PLG-003 | DROP | plugin option forms | Legacy widget rendering details including known defects; not carried over. |
| CON-UIX-051 | DROP | SQL console | Second review (Haiku, 10 reviewers, 2026-10-23): persistent bottom console in every page header dropped; one SQL editor (owner decision 2026-10-23). |
| CON-UIX-064 | DROP | AJAX page loading | Selflink rewrite for AJAX responses is a legacy page-loading mechanism; SPA routing gives re-enterable URLs. |
| CON-UIX-092 | DROP | themes build | SCSS RTL transform is a legacy build detail; RTL handled by the new frontend styling. |
| CON-UIX-103 | DROP | legacy browsers | IE/Opera legacy branch; old browsers unsupported. |
| CPT-UIX-040 | ADAPT | navigation tree | Keep user-controlled tree behaviours (sync with page, highlight, auto-expand) as settings; no CSS-class mechanism required. |
| CPT-UIX-105 | DROP | legacy JS libraries | Observation about third-party library internals; no requirement. |
| DATA-UIX-041 | ADAPT | navigation tree | Keep resizable and collapsible navigation panel with persisted width, RTL-aware; store in user preferences. |
| DATA-UIX-086 | DROP | themes build | Legacy SCSS variable and partial list; DBLoom styling defined by its own design system. |
| DATA-UIX-106 | ADAPT | user preferences | Preferences persist per account on server; browser storage only for per-viewer conveniences, no import/delete detection UI. |
| DEP-UIX-070 | DROP | frontend bundling | Bundling CodeMirror in the page head is a build detail; SQL editor need covered elsewhere. |
| DEP-UIX-084 | DROP | themes | Whether DBLoom offers selectable themes is an owner product choice; directory/theme.json format is legacy. (owner decision 2026-10-23, feature: themes) |
| DEP-UIX-088 | DROP | themes | Per-theme icon/text footer settings tied to legacy TabsMode and new-window selflink. |
| DEP-UIX-112 | DROP | themes | Same theme feature decision; legacy theme.json and version-series validation would not carry over. (owner decision 2026-10-23, feature: themes) |
| FR-UIX-001 | ADAPT | page shell | Keep consistent shell with navigation, top bar, content area and sidebar; built with React layout, not Twig. |
| FR-UIX-002 | ADAPT | page shell | Keep lang and dir set from active interface language; set by app root. |
| FR-UIX-003 | ADAPT | page shell | Keep viewport, noindex, same-origin referrer policy and cache-busted assets; jQuery-UI and CodeMirror CSS dropped. |
| FR-UIX-004 | ADAPT | navigation tree | Keep navigation excluded from print and persisted width; mechanism is frontend state. |
| FR-UIX-005 | ADAPT | navigation header | Keep home, logout, docs links (MySQL vs MariaDB aware) and reload tree; LegacyAdmin logo/docs and config-auth wording dropped. |
| FR-UIX-006 | ADAPT | connection switcher | Show connection/profile switcher based on available connection profiles rather than configured server list. |
| FR-UIX-007 | ADAPT | navigation tree | Keep a visible error state with retry when tree fails to load. |
| FR-UIX-008 | ADAPT | top menu | Keep tabbed top menu with active marker and accessible collapse on small screens; Bootstrap 5 not mandated. |
| FR-UIX-009 | DROP | page toolbar | Page-lock icon, cog and goto-top cluster is legacy chrome; unsaved-change guard covered by FR-UIX-021. |
| FR-UIX-010 | DROP | page footer | Self-link opening a new LegacyAdmin window and PHP error container are legacy; browser handles new tabs. |
| FR-UIX-011 | ADAPT | home screen | Keep a home dashboard with connection, server status and general settings; demo notice, themes list and collation select as decided. |
| FR-UIX-012 | DROP | themes | Theme chooser depends on the theme feature decision. (owner decision 2026-10-23, feature: themes) |
| FR-UIX-013 | SUPERSEDED | login | DBLoom has own account login and vault design in 11-target-security.md; keep autocomplete hints as implementation detail there. |
| FR-UIX-014 | DROP | noscript handling | Noscript and framing-hide trick are legacy; app requires JavaScript and sets framing policy via headers. |
| FR-UIX-015 | DROP | AJAX page loading | Describes legacy is_ajax flag; DBLoom is a JavaScript-dependent app by design. |
| FR-UIX-016 | DROP | AJAX page loading | Generic link/form interception is replaced by client-side routing of TanStack Start. |
| FR-UIX-017 | DROP | AJAX page loading | Exceptions to AJAX interception; router handles native link behaviour (modifier clicks, targets) natively. |
| FR-UIX-018 | ADAPT | request handling | Keep cancelling superseded navigation requests and preventing duplicate form submissions with a progress indicator. |
| FR-UIX-019 | DROP | AJAX page loading | Script teardown, body purging and page_content swap are legacy page-swap mechanics. |
| FR-UIX-020 | ADAPT | error display | Keep clear error display and highlighting of the offending field; server redirects handled by router. |
| FR-UIX-021 | ADAPT | unsaved changes guard | Keep warning before leaving a form with unsaved changes, including SQL editor content; implement via router blocker. |
| FR-UIX-022 | ADAPT | session expiry | Keep re-login in place without losing work when session expires; token handling per DBLoom security design. |
| FR-UIX-023 | DROP | script loader | Custom script loader with cache and onload events replaced by bundler code splitting. |
| FR-UIX-024 | DROP | script loader | Legacy script lifecycle registration; framework components handle lifecycle. |
| FR-UIX-025 | ADAPT | browser history | Keep working back/forward and deep-linkable URLs via router; no manual popstate handling. |
| FR-UIX-026 | ADAPT | error display | Keep readable error with status and connection hint for network or server failures. |
| FR-UIX-027 | ADAPT | notifications | Keep toast/notification system with loading, success, error types and auto-dismiss; exact timeouts and jQuery API not required. |
| FR-UIX-028 | KEEP | destructive confirmation | Confirmation dialog before ruinous operations remains; use accessible modal, not jQuery-UI dialog. |
| FR-UIX-029 | DROP | page shell | Describes Twig include placement of messages and errors; covered by notifications and error display. |
| FR-UIX-030 | DROP | retired | Retired reserved gap, no requirement. |
| FR-UIX-031 | DROP | retired | Retired reserved gap, no requirement. |
| FR-UIX-032 | ADAPT | page settings | Keep per-page settings dialog with apply and cancel restoring state; dimensions free. |
| FR-UIX-033 | ADAPT | keyboard shortcuts | Keep keyboard shortcuts with input-field suppression rules; Ctrl+K command palette is the primary entry point. |
| FR-UIX-034 | KEEP | grid keyboard navigation | Ctrl+Arrow movement between fields in insert and column grids is useful productivity behaviour. |
| FR-UIX-035 | KEEP | result sorting | Modifier-click to remove or add columns in multi-column ORDER BY stays. |
| FR-UIX-036 | KEEP | row selection | Shift-click range selection of rows stays. |
| FR-UIX-037 | ADAPT | navigation tree | Keep lazy-loaded tree with persisted expand/filter state, but via TanStack server functions and client storage, not /navigation POST and PHP token keys. |
| FR-UIX-038 | KEEP | navigation tree | Per-database and per-table live substring filter in the tree is useful. |
| FR-UIX-039 | ADAPT | navigation tree | Keep collapse-all, reload, and highlighting current db/table; drop jQuery/CommonParams mechanics. |
| FR-UIX-042 | KEEP | hidden nav items | Hiding tree items and an unhide dialog is a feature choice; owner decides. (owner decision 2026-10-23, feature: hidden nav items) |
| FR-UIX-043 | ADAPT | responsive layout | Keep top navigation overflowing into a menu on narrow widths using modern CSS/React, not menuResizer plugin. |
| FR-UIX-044 | ADAPT | responsive layout | Keep usable mobile layout for the tree; reimplement without jQuery breakpoints code. |
| FR-UIX-047 | ADAPT | query console | Second review (Haiku, 10 reviewers, 2026-10-23): no separate console; history and bookmarks move into the SQL editor (UI-TGT-001). |
| FR-UIX-048 | DROP | query console | Hidden form POST to /import is a PHP/jQuery implementation detail. |
| FR-UIX-049 | ADAPT | query console | If console exists, options go through DBLoom settings/user preferences, not config get via JS. |
| FR-UIX-050 | DROP | query console | Singleton and AJAX purging are internals of the legacy page lifecycle. |
| FR-UIX-052 | KEEP | result grid | Resizable, reorderable, hideable result columns are useful. |
| FR-UIX-053 | ADAPT | result grid | Keep column reorder and in-place cell editing; reimplement in React, no copy/pointer DOM hacks. |
| FR-UIX-054 | KEEP | bulk row selection | Check-all, per-group select, indeterminate state and row highlighting are needed for bulk operations. |
| FR-UIX-055 | KEEP | list filtering | Client-side row filtering with live match count is useful. |
| FR-UIX-056 | DROP | legacy jQuery plugins | jQuery sortable-table plugin is implementation detail. |
| FR-UIX-057 | DROP | result grid | Tooltip hint configuration is a legacy detail; sort indication handled by the new grid. |
| FR-UIX-058 | ADAPT | result grid | Row hover/selection highlight stays via design tokens and CSS, not theme SCSS variables. |
| FR-UIX-059 | DEFER | charts | Charting of result data is a feature choice; owner decides. (owner decision 2026-10-23, feature: charts) |
| FR-UIX-060 | DROP | zoom search | Zoom search scatter plot is a distinct feature; owner decides. (owner decision 2026-10-23, feature: zoom search) |
| FR-UIX-061 | DROP | charts | jqPlot byte-formatter plugin is a library detail. |
| FR-UIX-062 | DROP | query by example | QBE interface is a distinct feature; owner decides. (owner decision 2026-10-23, feature: query by example) |
| FR-UIX-063 | DEFER | designer | Visual designer feature; legacy IE workarounds dropped regardless. (owner decision 2026-10-23, feature: designer) |
| FR-UIX-065 | ADAPT | SQL editor | Keep SQL editor with autocomplete and linting using a modern editor component, not CodeMirror 5 jQuery wiring. |
| FR-UIX-066 | KEEP | SQL editor | Syntax highlighting of displayed queries is needed. |
| FR-UIX-067 | ADAPT | SQL editor | Keep schema-aware table/column autocomplete; fetch via server functions with caching. |
| FR-UIX-068 | ADAPT | documentation links | Keep links from keywords to MySQL/MariaDB docs, chosen per product and version via Strategy. |
| FR-UIX-069 | KEEP | SQL editor | Auto-saving unsent query drafts is useful. |
| FR-UIX-071 | DROP | legacy jQuery plugins | jQuery-UI tooltip helper is implementation detail. |
| FR-UIX-072 | DROP | legacy jQuery plugins | Hint on/off switch tied to jQuery tooltips; not needed. |
| FR-UIX-073 | ADAPT | localization | Date and time pickers stay locale-aware via browser Intl/modern components, not server-injected jQuery config. |
| FR-UIX-074 | ADAPT | value editors | Keep enum/set editor for cell edits as normal React dialog, not pre-rendered modals. |
| FR-UIX-075 | ADAPT | drag-drop import | Keep drag and drop file import with upload status panel, rebuilt in React. |
| FR-UIX-076 | ADAPT | drag-drop import | Keep async upload with progress; accepted types follow DBLoom import formats, not the legacy list. |
| FR-UIX-077 | KEEP | drag-drop import | Cancelling in-flight uploads with status feedback is needed. |
| FR-UIX-078 | ADAPT | settings forms | Keep client-side validation of settings forms, using schema validation per 12-settings.md. |
| FR-UIX-079 | DROP | legacy jQuery plugins | jQuery-Validate extension and PHP-injected validators are implementation detail. |
| FR-UIX-080 | ADAPT | password strength | Keep strength meter on password forms for DBLoom accounts and MySQL users; reimplement. |
| FR-UIX-081 | DROP | PHP limits | PHP max_input_vars guard does not apply to Node. |
| FR-UIX-082 | DROP | error reporting | Reporting to LegacyAdmin project via TraceKit is project infrastructure; no telemetry. |
| FR-UIX-083 | DROP | error reporting | PHP error report ignore/send flow is PHP specific. |
| FR-UIX-085 | DROP | themes | Theme switching and per-server themes; owner decides themes scope. (owner decision 2026-10-23, feature: themes) |
| FR-UIX-087 | DROP | themes | Theme CSS paths and jQuery-UI CSS are legacy asset mechanics. |
| FR-UIX-089 | ADAPT | RTL support | Keep correct text direction per locale if RTL languages are shipped; implement with CSS logical properties. |
| FR-UIX-090 | ADAPT | RTL support | Direction-aware layout stays, derived from document dir, using CSS logical properties. |
| FR-UIX-091 | DROP | RTL support | Direction-specific icon image files are legacy assets; use mirrored icons via CSS. |
| FR-UIX-096 | DROP | external links | url.php redirector is PHP-specific; use rel=noreferrer on external links. |
| FR-UIX-097 | ADAPT | MySQL user management | Keep no-password toggle, password generation, confirmations in DBLoom user management UI. |
| FR-UIX-098 | DROP | JS lifecycle | AJAX onload/teardown re-init is legacy page lifecycle; features decided separately. |
| FR-UIX-107 | DROP | AJAX contract | PHP ajax_request protocol is replaced by TanStack Start server functions and routing. |
| FR-UIX-108 | DROP | AJAX contract | Legacy JSON response envelope is replaced by typed server functions. |
| FR-UIX-110 | DROP | no-JS behaviour | DBLoom is a JS-required SPA/SSR app; no no-JS support claimed. |
| FR-UIX-111 | ADAPT | keyboard shortcuts | Keep keyboard shortcuts but centered on Ctrl+K palette; drop key-code handling and console toggles. |
| FR-UIX-113 | ADAPT | UI languages | Keep selectable UI languages with browser-language fallback; no gettext .mo files or LegacyAdmin language table. |
| FR-UIX-118 | ADAPT | documentation links | Keep contextual help links to DBLoom and MySQL/MariaDB docs; no url.php or local LegacyAdmin manual. |
| NFR-UIX-046 | ADAPT | responsive layout | Keep responsive behaviour and print hiding; implemented with modern CSS, not Bootstrap 5 classes. |
| NFR-UIX-099 | DROP | asset loading | Legacy script handler cache; bundler code-splitting handles per-route loading. |
| NFR-UIX-100 | DROP | asset loading | PHP messages.php and version query strings; build tooling uses content-hashed assets. |
| NFR-UIX-101 | DROP | UI implementation | Legacy jQuery navigation resize handler detail. |
| NFR-UIX-102 | ADAPT | browser support | Support current evergreen browsers; define the matrix explicitly; no Bootstrap 5.3.8 or cookie requirement as such. |
| NFR-UIX-104 | ADAPT | print styling | Keep a simple print stylesheet hiding chrome for result and structure views; no SCSS partial. |
| NFR-UIX-115 | DROP | browser support | Babel ES5 downlevel and legacy feature list; modern browsers assumed. |
| NFR-UIX-116 | ADAPT | accessibility | Keep ARIA and keyboard accessibility; set explicit WCAG target and automated checks instead of open decision. |
| NFR-UIX-117 | DROP | Twig templating | Twig environment and compiled cache are PHP-specific. |
| SEC-UIX-093 | ADAPT | clickjacking protection | Use CSP frame-ancestors and X-Frame-Options headers, not JS frame busting. |
| SEC-UIX-094 | KEEP | external links | Use noopener noreferrer on external links. |
| SEC-UIX-095 | KEEP | robots meta | Suppress indexing with noindex and X-Robots-Tag; translation metas optional. |
| SEC-UIX-109 | ADAPT | session timeout | Keep idle-timeout warning and expiry handling in UI, driven by DBLoom session settings; no PHP gc or cookie validity. |
| UI-UIX-045 | DROP | UI implementation | Fixed menubar padding sync via MutationObserver is legacy layout detail; CSS layout handles it. |
| UI-UIX-114 | ADAPT | RTL languages | Keep RTL support, derive direction from locale script so regional codes like ar_LY work. |
| CON-DEP-054 | SUPERSEDED | config auth | DBLoom has own accounts and personal connection profiles with vault; no config-file credentials. See 11-target-security.md. |
| CON-DEP-110 | SUPERSEDED | licensing | DBLoom is released under a permissive licence, proposed Apache-2.0 (CON-TGT-001); GPL-2.0-only obligations do not apply to a new implementation (owner decision 2026-10-23). |
| CON-DEP-111 | ADAPT | licensing | Show own licence and third-party notices in an About page; no /license or /changelog routes. |
| CON-DEP-112 | DROP | licensing | Composer vendor and vendor_config redistribution details are PHP-specific. |
| CON-DEP-113 | SUPERSEDED | licensing | Replaced by CON-TGT-001 (permissive licence, no copied LegacyAdmin material) (owner decision 2026-10-23). |
| CON-DEP-167 | DROP | snapshot caveat | Describes the analysed legacy snapshot, not a product requirement. |
| CPT-DEP-001 | DROP | project identity | LegacyAdmin identity and package name. |
| CPT-DEP-003 | DROP | release scripts | LegacyAdmin release kit script. |
| CPT-DEP-004 | DROP | changelog | LegacyAdmin changelog housekeeping. |
| CPT-DEP-024 | SUPERSEDED | multi-server | Replaced by personal connection profiles with vault; single instance, no server chooser from config array. |
| CPT-DEP-073 | DROP | docs housekeeping | Retired; Sphinx annotations. |
| CPT-DEP-074 | DROP | docs housekeeping | Y2K38 docs note; documentation upkeep, not product. |
| CPT-DEP-105 | DROP | vendored JS | Vendor sync script for legacy JS libraries. |
| CPT-DEP-114 | DROP | project housekeeping | LegacyAdmin support and security channels. |
| CPT-DEP-120 | ADAPT | doc links | Keep contextual links to MySQL and MariaDB manuals for supported versions; no local doc/html or url.php redirect. |
| CPT-DEP-121 | DROP | product scope list | Route-table scope listing; scope decided per feature elsewhere. |
| CPT-DEP-122 | DROP | PHP platform | PHP and extension consistency checks. |
| CPT-DEP-123 | DROP | PHP config | Four-place config directive definition; see 12-settings.md. |
| CPT-DEP-124 | DROP | docs housekeeping | Retired installation manual structure. |
| CPT-DEP-125 | DROP | docs housekeeping | Retired; security policy text moved elsewhere. |
| CPT-DEP-126 | DROP | docs housekeeping | Retired glossary. |
| CPT-DEP-127 | DROP | project housekeeping | LegacyAdmin README requirements. |
| CPT-DEP-128 | DROP | docs housekeeping | FAQ link rewriting in changelog viewer. |
| CPT-DEP-129 | DROP | docs housekeeping | Retired manual structure. |
| CPT-DEP-130 | DROP | docs housekeeping | Retired known issues list. |
| CPT-DEP-131 | DROP | signon examples | Example PHP signon and openid scripts; DBLoom has own auth design. |
| DATA-DEP-022 | DROP | config storage DB | Legacy utf8 MySQL 5 DDL syntax; DBLoom uses its own app storage. |
| DATA-DEP-050 | SUPERSEDED | PHP config file | config.inc.php replaced by .env and settings per 12-settings.md. |
| DATA-DEP-057 | DROP | PHP config file | show_config_errors.php PHP script. |
| DATA-DEP-061 | ADAPT | config storage DB | DBLoom keeps its own app store; per-feature tables (bookmarks, history etc.) follow feature decisions, not the legacyadmin database. |
| DATA-DEP-062 | DROP | config storage DB | Controluser grant comment in SQL script; no pma controluser. |
| DATA-DEP-064 | DROP | control connection | Controluser and control connection concept; DBLoom uses its own app store and profile connections. |
| DATA-DEP-066 | ADAPT | column transformations | Column transformations feature scope is an owner decision; plugin generator scripts dropped. (owner decision 2026-10-23, feature: column transformations) |
| DATA-DEP-075 | ADAPT | storage migrations | Keep idempotent, forward-only schema migrations for DBLoom's own store, via migration tool not SQL scripts. |
| DEP-DEP-090 | DROP | Composer deps | PHP Composer dependency baseline. |
| DEP-DEP-091 | DROP | Composer deps | Composer repositories and branch alias. |
| DEP-DEP-092 | DROP | Composer deps | PHP dev toolchain. |
| DEP-DEP-093 | DROP | Composer deps | Composer plugin allowlist. |
| DEP-DEP-094 | DROP | Composer deps | Composer autoload classmap settings. |
| DEP-DEP-096 | DROP | Composer deps | Bundled Composer vendor licences in kits. |
| DEP-DEP-100 | DROP | client build | Node 12 and Yarn classic build for legacy JS; DBLoom has its own toolchain. |
| DEP-DEP-102 | DROP | legacy client deps | Pinned jQuery/Bootstrap/OpenLayers legacy front-end dependency list; DBLoom has its own TypeScript stack and lockfile. |
| DEP-DEP-103 | DROP | legacy build tooling | jest/eslint/stylelint versions for LegacyAdmin JS tree; DBLoom chooses its own tooling. |
| DEP-DEP-162 | DROP | PHP vendor overrides | PHP vendor_config.php packager mechanism; irrelevant to Node app. |
| FR-DEP-002 | ADAPT | version identity | Keep a single authoritative app version surfaced in UI; PHP Version class, ChangeLog and script mechanics dropped. |
| FR-DEP-010 | DROP | PHP runtime gate | PHP version requirement; DBLoom runs on Node.js. |
| FR-DEP-011 | DROP | PHP extensions | PHP extension requirements do not apply to Node. |
| FR-DEP-012 | DROP | PHP optional extensions | PHP extension suggestions; compression handled by Node libraries if import/export needs them. |
| FR-DEP-020 | ADAPT | server minimum version | Enforce minimum MySQL 8.4 / MariaDB 10.11 (proposed) instead of 5.5; refuse older servers with clear error. |
| FR-DEP-021 | DROP | PHP mysqli driver | mysqli/mysqlnd specific; DBLoom uses a Node driver behind the Adapter (ARCH-TGT-001). |
| FR-DEP-023 | ADAPT | auth plugin descriptions | Show only plugins valid on minimum servers (caching_sha2, sha256, unix_socket, ed25519 etc.); drop mysql_old_password and native-only assumptions. |
| FR-DEP-030 | DROP | PHP entry points | PHP front controller and file entry points; TanStack Start routing replaces them. |
| FR-DEP-033 | ADAPT | browser requirements | Require a current evergreen browser with JavaScript; no cookie-only or Bootstrap 5.3.8 pin. |
| FR-DEP-040 | DROP | release kits | LegacyAdmin release archives and config.inc.php setup; DBLoom deployment is defined in DEP-TGT. |
| FR-DEP-042 | DROP | Composer project | Composer packaging is PHP specific. |
| FR-DEP-043 | DROP | Git install pipeline | Git/Composer/Yarn install pipeline specific to LegacyAdmin. |
| FR-DEP-044 | DROP | Composer autoloader hint | Composer autoloader failure message is PHP specific. |
| FR-DEP-045 | ADAPT | setup wizard | First-run setup in DBLoom via settings/.env (12-settings.md); no config.inc.php generator or download-and-upload flow. |
| FR-DEP-051 | SUPERSEDED | config file template | Replaced by .env/settings design and secret handling in 12-settings.md and SEC-TGT; no blowfish_secret or config.inc.php. |
| FR-DEP-055 | SUPERSEDED | login cookie auth | DBLoom has its own session/cookie design in 11-target-security.md; sodium cookies and PHP directives not carried. |
| FR-DEP-056 | DROP | error reporting | Opt-in client error reporting to a vendor/project; owner decides whether DBLoom has any telemetry or error reports. (owner decision 2026-10-23, feature: error reporting) |
| FR-DEP-060 | DROP | configuration storage | Per-feature la_ storage tables; DBLoom stores own state in its own store. Owner decides which features (bookmarks, tracking, central columns) exist. (owner decision 2026-10-23, feature: configuration storage) |
| FR-DEP-063 | DROP | pmadb table wiring | 19 config.inc.php table directives for la_ tables; DBLoom uses its own internal store. |
| FR-DEP-070 | ADAPT | upgrade and version check | Keep upgrade path and optional update notification (owner may disable for air-gapped); PHP file replacement mechanics dropped. |
| FR-DEP-071 | ADAPT | asset cache busting | Hashed build assets invalidate stale client state automatically; version query strings and PHP shims dropped. |
| FR-DEP-072 | DROP | pmadb upgrade scripts | create_tables.sql parsing and la_column_info upgrade are LegacyAdmin storage internals. |
| FR-DEP-095 | DROP | PHP QA scripts | Composer phpcs/phpstan/psalm workflow; PHP tooling. |
| FR-DEP-101 | DROP | legacy build scripts | SassDart, rtlcss, Babel build of LegacyAdmin themes; DBLoom has its own build. |
| FR-DEP-104 | DROP | prebuilt artifacts | Prebuilt js/dist and theme CSS in PHP tree; DBLoom ships its own build output or image. |
| FR-DEP-150 | DROP | PHP unit testing | phpunit configuration is PHP specific. |
| FR-DEP-151 | DROP | PHP test bootstrap | PHP test bootstrap settings. |
| FR-DEP-152 | DROP | LegacyAdmin test tree | Describes LegacyAdmin test layout; DBLoom defines its own tests. |
| FR-DEP-153 | DROP | Selenium E2E config | LegacyAdmin Selenium env vars; DBLoom picks its own E2E tooling. |
| FR-DEP-155 | DROP | legacy CI gates | LegacyAdmin PHP/JS lint and test gates; DBLoom defines own CI. |
| FR-DEP-157 | DROP | release scripts | LegacyAdmin release engineering and translation scripts; project housekeeping. |
| FR-DEP-160 | DROP | PHP runtime gate | PHP version and extension gate at entry points; not applicable to Node. |
| FR-DEP-163 | DROP | legacy build commands | LegacyAdmin yarn/jest build and test commands. |
| FR-DEP-164 | DROP | gettext pipeline | po/mo translation build with msgfmt; DBLoom has its own i18n approach. |
| FR-DEP-165 | DROP | release packaging | LegacyAdmin Composer/Yarn release packaging steps. |
| FR-DEP-166 | DROP | PHP test fixtures | PHP test bootstrap and fixtures. |
| INT-DEP-013 | DROP | login CAPTCHA | reCAPTCHA on login is a product choice; DBLoom login hardening may instead use rate limiting (SEC-TGT). Owner decides on CAPTCHA. (owner decision 2026-10-23, feature: login captcha) |
| INT-DEP-014 | SUPERSEDED | two-factor auth | DBLoom own accounts and 2FA design are in 11-target-security.md; PHP packages not carried. TOTP/WebAuthn need stays. |
| INT-DEP-015 | DROP | PDF output | Format dropped: only SQL, CSV and JSON stay (owner decision 2026-10-23): PDF output library. |
| INT-DEP-025 | KEEP | TLS to database | TLS connections to the DB server with CA, cert, key, verify options remain required; adapt to Node driver options. |
| INT-DEP-047 | ADAPT | OS support | Run on Linux and Windows (and containers) via Node; PMA_IS_WINDOWS and PHP permission checks dropped. |
| INT-DEP-058 | SUPERSEDED | auth plugins | Config/cookie/http/signon auth types replaced by DBLoom accounts and connection profiles with vault (11-target-security.md). |
| INT-DEP-065 | DROP | zeroconf pmadb | Auto-probing for la_ control storage; DBLoom has its own store. |
| INT-DEP-080 | ADAPT | reverse proxy support | Keep base URL override, X-Forwarded-Proto and trusted-proxy client IP handling as settings in 12-settings.md. |
| INT-DEP-081 | SUPERSEDED | Docker env config | Retired legacy item; DBLoom defines its own env contract in 12-settings.md. |
| INT-DEP-082 | SUPERSEDED | Docker volumes | Retired legacy item; DBLoom deployment defined in DEP-TGT and 12-settings.md. |
| NFR-DEP-016 | DROP | PHP xml extension | ext-xml dependency; DBLoom XML handling uses Node libraries if XML import/export is kept. |
| NFR-DEP-156 | DROP | PHP maintainability assets | phpcs standard, stubs and baselines are PHP specific. |
| NFR-DEP-161 | ADAPT | file permissions | Keep restrictive permissions on secrets/settings and writable data dir; PHP config.inc.php check and TempDir mechanics dropped. |
| SEC-DEP-031 | ADAPT | protect internal files | Ensure no source, settings or temp files are web-served; handled by app architecture and container, not .htaccess. |
| SEC-DEP-032 | KEEP | robots exclusion | Serve robots.txt disallowing all crawlers; trivial for a self-hosted admin tool. |
| SEC-DEP-041 | ADAPT | release signing | Publish checksums and signed releases/images for DBLoom artifacts; GPG details and LegacyAdmin keys dropped. |
| SEC-DEP-046 | DROP | PHP vendor config | PHP-specific packager path relocation via vendor_config.php; no equivalent in a Node deployment. |
| SEC-DEP-052 | SUPERSEDED | login cookie encryption | Legacy PHP sodium cookie encryption replaced by DBLoom's own session and vault credential protection in 11-target-security.md. |
| SEC-DEP-053 | DROP | URL query encryption | PHP-specific URL query encryption option; not needed in DBLoom's routing design. |
| SEC-DEP-140 | DROP | PHP setup script | LegacyAdmin setup script generating config.inc.php; DBLoom uses .env/settings instead. |
| SEC-DEP-141 | SUPERSEDED | config auth type | DBLoom has own user accounts and connection profiles; no auth_type=config open-access mode. |
| SEC-DEP-142 | ADAPT | auth event logging | Keep logging of login success/denial with user and IP for fail2ban-style use; emit via Node logger/stdout, configured in settings. |
| SEC-DEP-143 | DROP | reCAPTCHA login | Third-party captcha on login not needed; DBLoom has its own account and login protection. |
| SEC-DEP-144 | ADAPT | login access control | Keep optional IP allow/deny and rejecting root/empty-password logins as DBLoom settings, not AllowDeny config arrays. |
| SEC-DEP-145 | DROP | PHP session path | PHP session_save_path and save_handler setting; Node session storage is DBLoom-specific. |
| SEC-DEP-146 | ADAPT | CSRF protection | Keep CSRF defence for state-changing requests, using TanStack Start/Node mechanisms (SameSite, origin check, token), regenerate session at login. |
| SEC-DEP-154 | DROP | test directory protection | PHP test/ directory .htaccess note; project housekeeping, not applicable. |

## 5. Open points

- The owner shall decide the features of section 3 and confirm or correct the notes; until then `OPEN.md` item 1 stays open.
- ADAPT rows still need DBLoom wording. SUPERSEDED rows should be checked against the replacing requirement.
- Requirements of files 13 to 17 are not part of this triage; they have their own review status.
