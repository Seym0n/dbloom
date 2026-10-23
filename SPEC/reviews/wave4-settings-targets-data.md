# Wave 4 - Settings classification: target connections and data handling

Scope: `.env` (deployment) vs administrator UI vs user preference, for target-server connections and data handling. Basis: `11-target-security.md` sections 3, 4, 6, 8, 11-14; `OPEN.md` item 18; `10-conflicts.md`; `FUTURE.md`; legacy defaults in `libraries/config.default.php` (MaxRows 25:1278, ExecTimeLimit 300:718, MemoryLimit -1:741, MaxCharactersInDisplayedSQL 1000:697, LimitChars 50:2557, QueryHistoryMax 25 and QueryHistoryDB false:2616-2623, MaxExactCount 50000:2637, UploadDir/SaveDir empty:2805-2814, Confirm true:790, ProtectBinary 'blob':1334, Zip/GZip/BZip/CompressOnFly true:1414-1436, ssl_verify true:200, AllowArbitraryServer false:867).

Status: PROPOSED by the reviewing engineer. All numbers are labelled PROPOSED. Env-variable names are illustrative only. Nothing is verified against a running implementation.

## 0. Conventions

- **ENV-only**: `.env`, restart, no UI field, not callable by API.
- **UI-admin**: administrator UI (account mode); in direct mode the value comes from `.env`.
- **UI within ENV bounds**: `.env` gives floor/ceiling (SEC-TGT-142) and an initial default; the admin UI moves the value inside. Server rejects outside values.
- **User pref within admin limits**: user chooses, but only inside what the admin policy allows; the user can always go tighter.
- "Envelope" = for boolean/list settings, the analogue of floor/ceiling: `.env` states what the UI is *permitted* to switch on or which entries it may select from (SEC-TGT-142 names only numeric and list values; booleans need the same idea, see disagreement D2).
- Loosening = widens exposure or raises a limit. Tightening = the opposite. Proposal: only loosening needs step-up (D10).
- Direct mode: no UI, no admin, no admin plane. Every row's "direct" answer is therefore "from `.env`"; a user preference in direct mode is limited to what the login page and the keyed store (DATA-TGT-094) offer, and the "user" there is the key (target+username), which several humans may share (see Q5).

## 1. Settings table (verdict)

| ID | Setting | Spec / legacy source | Verdict | Decisive what-if |
|---|---|---|---|---|
| TD-01 | Hard-blocked address classes: loopback, link-local (169.254/16, fe80::/10 incl. 169.254.169.254, fd00:ec2::254), unspecified, multicast, broadcast, reserved, IPv4-mapped/NAT64/6to4 forms of these | SEC-TGT-030 | **ENV-only (and not removable by switch in the default build; opt-out only by a deliberately named env flag)** | (1) Admin session stolen, class removed in UI, then DBLoom is an SSRF/metadata-credential pivot and the attacker needs only a DBLoom login. |
| TD-02 | Private ranges (RFC1918, ULA fc00::/7, CGNAT 100.64/10) permitted as targets | SEC-TGT-030 "unless enabled" | **UI within ENV envelope**: `.env` permits (default not permitted); UI can then narrow to named CIDRs, never widen beyond `.env` | (1) A stolen admin session could not open the internal network unless `.env` already allows it; (8) internal DBs are the normal case, so the non-technical admin needs a selector among pre-approved CIDRs. |
| TD-03 | Target allow-list / deny-list entries (host patterns, CIDR, ports) | SEC-TGT-030, FR-TGT-141 | **UI within ENV envelope** (`.env`: maximum envelope as CIDR/host-suffix list; UI: subset, tighten-only; deny entries in UI always allowed) | (1)+(8): admin must add/remove hosts often, but each add is a widening and bounded by the envelope; empty envelope = nothing beyond the TD-01/02 rules. |
| TD-04 | Free-form targets (user types any host) vs only entries matching TD-03 | CF-001, CF-006, SEC-TGT-030 | **ENV-only switch for "free-form possible at all"; UI-admin may switch to allow-list-only (tighten)** | (3) Direct mode needs it before any store exists; (9) in the first release options A and B (no shared profiles) make every target user-typed, so this switch plus TD-03 is the only target gate. |
| TD-05 | Unix-socket / local-socket targets | legacy `socket` | **ENV-only, default off** | (1) socket path bypasses every IP rule (TD-01); an admin must not be able to enable it. |
| TD-06 | Allowed target ports | SEC-TGT-030 | **UI within ENV envelope** (part of TD-03). PROPOSED default 3306, 3307-3309 | (1) Port widening is SSRF port scanning against allowed hosts. |
| TD-07 | TLS to targets: mode `required / preferred / off` and default verify=on | SEC-TGT-032, legacy ssl_verify true | **ENV-only default and floor** (default `required`); UI-admin may only tighten (e.g. `required` for all, not below `.env`) | (1) Admin sets `off`, then every new credential travels in clear to the target and a network attacker reads it; (6) these are the user's passwords. |
| TD-08 | Permit disabling certificate verification (per-connection override) | SEC-TGT-032 "explicit per-profile setting" | **ENV-only permit flag (default false)**; where permitted, the per-connection/per-profile choice is a user choice, shown in the UI and audited | (9) A user with a self-signed lab server wants the override; admin must not be able to enable it for them (1), so the permit is `.env`, the use is the user's. |
| TD-09 | Extra CA bundle / CA file path (global) | SEC-TGT-032 | **ENV-only** (file path); per-profile pasted CA certificate is a **user value in the vault** | (1) A UI-set CA path or an uploaded CA lets a stolen admin session trust an attacker CA; (4) trust store is loaded at startup. |
| TD-10 | Minimum TLS version to targets | none | **ENV-only**, PROPOSED 1.2 | (2) Mistyped value in the UI could break all connections; there is no benefit in changing it often. |
| TD-11 | Connect timeout | SEC-TGT-033 | **UI within ENV bounds**. PROPOSED default 10 s, floor 2 s, ceiling 30 s | (2) Too low: no connections (recoverable, revert). Too high: sockets pile up on blackholed hosts (resource DoS), so ceiling in `.env`. |
| TD-12 | Statement (query) timeout | SEC-TGT-052/033; legacy ExecTimeLimit 300 | **UI within ENV bounds + user pref (lower only; raise up to admin max per statement)**. PROPOSED default 60 s, floor 1 s, ceiling 600 s | (9) Analysts need long reports, others want a fast safety net; admin sets default and max, user lowers freely. |
| TD-13 | Import/export job wall-clock limit (replaces ExecTimeLimit for jobs) | legacy ExecTimeLimit | **UI within ENV bounds**. PROPOSED default 900 s, floor 60 s, ceiling 7200 s | (4) Applies to jobs started after the change; running jobs keep their value. |
| TD-14 | Idle timeout of a target connection | SEC-TGT-041 | **UI within ENV bounds**, never above session idle timeout. PROPOSED default 15 min, floor 1 min, ceiling = session idle timeout | (1) Longer idle = longer-lived decrypted credentials in memory; ceiling stops that. |
| TD-15 | Rows per page default (legacy MaxRows 25) and the admin cap on it | legacy MaxRows | **Both**: user preference within admin cap; admin cap UI within ENV bounds. PROPOSED default 25, choices 10/25/50/100/250/500/1000, admin cap default 500, `.env` ceiling 5000 | (9) Page size is a personal taste, load is a deployment concern. |
| TD-16 | Max rows returned for one SQL result / table browse (hard result cap) | SEC-TGT-052 | **UI within ENV bounds** (user may lower). PROPOSED default 10 000, floor 100, ceiling 100 000 | (1)+(2) Raising it makes one request hold large memory; ceiling in `.env`. Server must say "truncated at N" (SEC-TGT-033). |
| TD-17 | Max response bytes and max bytes per cell fetched/displayed (BLOB/TEXT) | SEC-TGT-052 | **UI within ENV bounds**. PROPOSED response 16 MiB (ceiling 64 MiB); cell 64 KiB (ceiling 1 MiB); larger cells via explicit download | (4) A cell cap protects Node heap regardless of row cap. |
| TD-18 | Max SQL text length typed/pasted | none | **ENV-only**, PROPOSED 1 MiB (larger scripts use import) | (2) Technical, rarely changed, interacts with the body-size limit of the proxy (DEP-TGT-121). |
| TD-19 | Display truncation: LimitChars (50), MaxCharactersInDisplayedSQL (1000), ProtectBinary mode | legacy | **User preference** within hard code limits (display only); admin default optional | (9) Cosmetic and no security effect; ProtectBinary must never mean "render raw bytes as HTML" (SEC-TGT-112). |
| TD-20 | Exact row count threshold (MaxExactCount 50000) | legacy | **UI-admin default + user pref (lower only)**; bounds PROPOSED 1 000-1 000 000 | (9) Exact `COUNT(*)` on a huge table loads the target; admin guards the target, user can opt out. |
| TD-21 | Read-only mode | SEC-TGT-052, OPEN decision 4 | **Three levels**: (a) ENV-only `force read-only` for the whole deployment; (b) UI-admin default for new connections (may tighten, cannot undo (a)); (c) user switch per connection (anyone may go read-only; going read-write only if (a),(b) allow). Direct mode: (a) from `.env` + user checkbox at login | (1) Admin cannot remove an env-forced read-only; (2) forgetting to turn it off is harmless, so recovery is easy; (9) users want to protect themselves. Guard rail only, not a boundary (SEC-TGT-050): see D4. |
| TD-22 | Destructive-statement confirmation (DROP, TRUNCATE, DELETE/UPDATE without restricting condition, DROP DATABASE) | SEC-TGT-052, legacy Confirm true | **ENV-only floor "on" (no UI or user switch turns the hard class off)**; admin UI may add classes; user may add confirmations, and may switch off only soft ones (e.g. single-row delete via UI button) | (1) A stolen session could disable it before a mass delete; (9) hard class is protective of the user too; confirmation must be a server-side two-step token, not a JS dialog (SEC-TGT-114). |
| TD-23 | Blocked statement classes / multi-statement execution | SEC-TGT-050 | **UI within ENV envelope** (e.g. block `SET GLOBAL`, `KILL` of other sessions, multi-statement in SQL box). Best effort; label as such | (1) Admin cannot enable what `.env` blocks; (2) over-blocking is a visible, revertible error. |
| TD-24 | Disable `LOAD DATA LOCAL INFILE` (client side), refuse cleartext-password auth plugins without TLS, set `multipleStatements` deliberately | project analysis | **Not a setting: fixed code behaviour** | (1) A malicious target server can ask the client to send local files; if any switch exists, a stolen session or a rogue server gets arbitrary file read on the DBLoom host. |
| TD-25 | Max upload size (import file) | SEC-TGT-071 | **UI within ENV bounds**, effective = min(UI, `.env` hard max, proxy body limit). PROPOSED default 64 MiB, floor 1 MiB, ceiling 2 GiB | (5) Proxy body limit and DBLoom limit must agree or users see opaque 413 errors; (1) ceiling bounds disk DoS. |
| TD-26 | Decompressed size cap and compression ratio cap | SEC-TGT-071 | **ENV-only** (ratio, entries per archive, nesting); decompressed-size cap **UI within ENV bounds**. PROPOSED ratio 100:1, 1 entry per archive (reject multi-entry zip), no nested archives; size default 1 GiB, ceiling 4 GiB | (1) Raising the ratio is exactly the zip-bomb DoS; non-technical admin never needs to touch the ratio. |
| TD-27 | Allowed import file types / formats (SQL, CSV, and others of file 04) | SEC-TGT-071, 113 | **UI within ENV envelope**: `.env` lists formats built in and enabled; admin UI may disable (tighten) or re-enable inside the envelope; detection by content, not by client MIME or extension | (1) Admin cannot enable a format the build excludes (closed registry, SEC-TGT-113). |
| TD-28 | Server-side upload directory (legacy UploadDir; "read files from server filesystem") | SEC-TGT-071 | **ENV-only, default off (empty)** | (1) Admin sets `/etc` or a home directory, then reads any file the process can read through the import dialog. Per-user subdirectory if ever enabled. |
| TD-29 | Server-side save directory for exports (legacy SaveDir) | legacy SaveDir | **ENV-only, default off. Recommend dropping from the first release** (download only) | (1) Writing files on the server from a stolen session; (7) direct mode would let any target user write there. |
| TD-30 | Temp directory and temp-disk quota; concurrent imports per user | FR-CFG-079 legacy | **ENV-only** path and total quota; concurrent imports per user **UI within ENV bounds**, PROPOSED default 1, ceiling 3 | (5) Local disk per instance; temp space cannot be shared silently. |
| TD-31 | Export defaults: format, compression, charset, filename template | legacy Export section | **User pref** (default from admin UI); filename always sanitised (SEC-TGT-072), not configurable | (9) Personal; filename template with path parts is a path-traversal vector, so only a safe token set is allowed. |
| TD-32 | Formula-injection neutralisation for CSV and spreadsheet exports | SEC-TGT-112 | **Default on; per-export user checkbox; admin UI may remove the user's ability to disable (tighten)**. Cell prefix set PROPOSED: `= + - @ TAB CR` | (9) Spec lets the user disable; but a low-privilege DB user can plant `=HYPERLINK(...)`, and the exporting admin is the victim. |
| TD-33 | Max export size (rows / bytes) | SEC-TGT-052 | **UI within ENV bounds**. PROPOSED default 1 GiB, ceiling 8 GiB; exports must stream | (4) Applies to exports started later. |
| TD-34 | Process memory limit (legacy MemoryLimit -1) | legacy MemoryLimit | **ENV-only** (runtime heap flag / container limit); no UI. Stack-dependent | (3)+(4) Needed before the app starts and needs a restart. |
| TD-35 | Import option defaults (e.g. foreign-key checks, charset, partial import) | legacy DefaultForeignKeyChecks, Import.* | **User pref**; admin may force "foreign key checks on" by UI (tighten) | (9) Per-import choice; a default of "checks off" is a data-integrity risk. |
| TD-36 | SQL history: enabled, max entries per user, max age, max stored length | legacy QueryHistoryMax 25, QueryHistoryDB false | **UI within ENV bounds + user pref (lower only; user can delete own entries or turn off recording)**. PROPOSED default 100 entries, 30 days, 64 KiB per entry; floor 0 (off), ceiling 1000 entries / 365 days | (6) History holds statements with literals (passwords in `SET PASSWORD`, `CREATE USER`, PII in INSERT); (9) user must be able to wipe, admin must be able to bound. Audit log (NFR-TGT-090) is separate and not user-deletable. |
| TD-37 | History/audit redaction of literals in password-setting statements | SEC-TGT-023 | **Not a setting: fixed code behaviour** | (6) Switchable redaction would leak credentials into store and backups. |
| TD-38 | Max concurrent target connections per session | SEC-TGT-010 | **UI within ENV bounds**. PROPOSED default 5, floor 1, ceiling 20 | (1) Attacker raising it multiplies connections to targets. |
| TD-39 | Max concurrent target connections per DBLoom user (all sessions); per target host | SEC-TGT-131 | **UI within ENV bounds**. PROPOSED user default 10, ceiling 50; per target host default 20, ceiling 100 | (5) Counter is per instance unless the store is shared (D9). |
| TD-40 | Instance-wide connection cap, max concurrently running statements per session | none | **ENV-only** (resource sizing of the instance). PROPOSED cap 200 connections; 2 statements per session | (5) Sized per instance, so it belongs with the instance's `.env`. |
| TD-41 | Pooling: never share a connection between users or credential sets; pool only inside one session+credential+target; reset state on reuse | CF-010, SEC-TGT-020 | **Not a setting: fixed behaviour.** Pool size = TD-38, idle = TD-14 | (6) Shared pools mix credentials, `USE db`, user variables, temp tables, open transactions. |

Out of this domain (cross-refs only): audit-log retention (NFR-TGT-090, belongs to the audit/security reviewer), session lifetimes (SEC-TGT-041), rate-limit thresholds (SEC-TGT-017/131).

## 2. What-if matrix

Cells are terse. Numbers (1)-(9) are the cases from the brief. "n/a" = does not apply. "=U" = same as the previous setting in the group. Direct mode (7) is "from `.env`, no UI" everywhere unless stated.

### 2.1 Target host policy

| ID | (1) attacker holds admin session | (2) admin mistypes | (3) needed before store/login | (4) restart / open connections | (5) several instances | (6) secret? | (7) direct mode | (8) non-technical admin, often | (9) user wants different |
|---|---|---|---|---|---|---|---|---|---|
| TD-01 | Removing block opens SSRF/metadata pivot. So UI cannot touch it. | n/a (no UI) | Needed at first start (setup page also makes outbound tests) -> env. | Restart; on tighten, existing connections to newly blocked addresses are closed at next statement. | Must agree: otherwise bypass by hitting the lax instance. Startup check compares an env-policy hash stored in the store (PROPOSED). | No | Env | Not needed | No: users cannot relax. |
| TD-02 | Bounded by `.env` envelope; cannot exceed. | Narrowing wrongly breaks reach to internal DBs; recover by widening within envelope. | Env supplies the initial value. | UI changes apply to new connections; narrowing kills open ones to now-denied CIDRs. | Store-shared UI value gives agreement; `.env` must be identical (hash check). | No | Env | Rare change; selector from pre-approved list. | No |
| TD-03 | Can only select inside envelope; each change is a loosening -> step-up + audit old/new. | Typo makes a pattern match too much (`*.com`)? Validate pattern syntax, reject wildcards broader than envelope, preview "N existing profiles would match". Wrong deny breaks users; revert via versioned settings. | Env envelope + initial list. | New connections only; narrowing drops open ones. | Shared store or divergence; document single store (OPEN 12). | No | Env list only | Frequent: needs add/remove with preview and one-click rollback. | Users may only pick among allowed. |
| TD-04 | Cannot turn free-form on (env), can only turn it off. | Turning it off too early locks everyone out of targets; recoverable (UI re-enable within env). | Env decides at startup (direct login page layout). | Open connections stay until closed; policy re-checked on reconnect. | Must agree. | No | Env (the owner's main scenario; default must be explicit) | Rare | n/a |
| TD-05 | Env-only, so n/a. | n/a | Env | Restart | Per instance socket paths differ; ok | Path is not secret | Env | n/a | No |
| TD-06 | Port widening = port scan; step-up. | Wrong port blocks target; revert. | Env | New connections | Agree | No | Env | Occasional | No |

### 2.2 TLS to targets

| ID | (1) | (2) | (3) | (4) | (5) | (6) | (7) direct | (8) | (9) |
|---|---|---|---|---|---|---|---|---|---|
| TD-07 | Downgrade -> credential theft on path. Not in UI. | n/a | Env | Restart; no effect on open connections. | Must agree | Protects secrets | Env | n/a | User may not weaken. |
| TD-08 | Cannot enable (env). | n/a | Env | Restart; existing connections not re-verified. | Agree | Weakening exposes the password | Env permit; login page shows checkbox only if permitted | n/a | Yes, the use is a user choice when permitted; shown + audited. |
| TD-09 | Would plant CA; avoided. | Wrong path stops startup (fail closed, good). | Env (file read at start) | Restart | Each instance needs same file | CA is public data; private keys never here | Env | n/a | User may add a per-profile CA in vault. |
| TD-10 | n/a | Env typo stops startup. | Env | Restart | Agree | No | Env | n/a | No |

### 2.3 Timeouts and limits

| ID | (1) | (2) | (3) | (4) | (5) | (6) | (7) direct | (8) | (9) |
|---|---|---|---|---|---|---|---|---|---|
| TD-11 | Raise to ceiling: slow-connect resource DoS bounded. Low: breaks connects. | Too low: all connects fail; UI reachable (no target needed) -> fix. Auto-revert not needed. | Env default | New connections only | Not required but should (store-shared) | No | Env | Rare | No |
| TD-12 | Raise to ceiling: target load bounded by 600 s. | 0/blank must be rejected (0 = "no limit" in MySQL), not accepted. | Env default | Next statement; running one keeps old value | Agree through shared store | No | Env (user may lower at login/prefs) | Rare | Lower freely; raise to admin max per statement. |
| TD-13 | Bounded by ceiling | Too low: imports abort mid-way; document partial-import behaviour. | Env default | Jobs started later | Per instance fine | No | Env | Rare | No |
| TD-14 | Raise = longer credential residency; capped by session idle. | Too low: constant reconnect; recoverable. | Env default | Sweeper reads value live (applies to open connections at next sweep) | Per instance (memory) | Credentials in memory | Env | Rare | User may lower. |
| TD-15 | Cap raised: heavier pages, bounded by env ceiling. | Cap lower than user pref: clamp, no error. | Env default | Next request | Agree via store | No | Env cap; user choice kept in keyed store | Frequent complaint ("show more rows") | Yes (the point). |
| TD-16 | Raise to ceiling: memory pressure bounded. | 0 rejected. | Env | Next request | Agree | No | Env | Rare | Lower only. |
| TD-17 | Bounded | Very low cell cap breaks viewing; revert. | Env | Next request | Agree | Cells may contain secrets, never logged | Env | Rare | Lower only; explicit download for larger. |
| TD-18 | n/a | Env typo stops startup or is validated. | Env | Restart | Must agree with proxy body limit | No | Env | n/a | No |
| TD-19 | n/a | Cosmetic | Defaults in code | Immediate on reload | Not needed | No | User pref in keyed store | Never | Yes |
| TD-20 | Bounded | Too high: exact counts stall; revert. | Env/code default | Next request | Agree | No | Env | Rare | Lower only. |

### 2.4 Modes and statement policy

| ID | (1) | (2) | (3) | (4) | (5) | (6) | (7) direct | (8) | (9) |
|---|---|---|---|---|---|---|---|---|---|
| TD-21 | Cannot undo env-forced RO; may set default RO off for new connections (loosening -> step-up). | Setting RO by mistake: harmless, easy UI recovery. Forgetting to set it: damage -> so default RO for new connections is an owner question (Q2). | (a) at start | Open connections keep old mode; tightening should apply at once by session `READ ONLY` + statement gate; loosening only for new connections. | (a) must agree | No | (a) Env + login checkbox | Frequent for non-technical users -> simple per-connection toggle | Yes (tighten freely). |
| TD-22 | Cannot disable hard class. | n/a for hard class. | Code/env default | Immediate | Agree | Statement text may carry secrets: not logged raw | Env + code | Rare | Soft class only. |
| TD-23 | Cannot enable what env blocks; blocking more is tightening. | Over-blocking: users see "blocked by policy", revert. | Env | Next statement | Agree | No | Env | Rare | No |
| TD-24 | A switch would be a file-read hole. No setting. | n/a | Code | n/a | n/a | No | Code | n/a | No |

### 2.5 Files, imports, exports

| ID | (1) | (2) | (3) | (4) | (5) | (6) | (7) direct | (8) | (9) |
|---|---|---|---|---|---|---|---|---|---|
| TD-25 | Bounded by ceiling | Too low: imports fail with clear message; too high above proxy limit: opaque 413. UI must show effective min. | Env hard max | Next upload | Must agree with proxy and between instances | No | Env | Frequent ("my file is too big") -> UI is right, with explanation of the proxy limit | Lower only. |
| TD-26 | Ratio raise = bomb. Not in UI. | n/a for env part; size cap too high bounded by ceiling | Env | Next import | Agree | No | Env | Never | No |
| TD-27 | Cannot add formats. | Disable needed format: revert. | Env | Next import | Agree | No | Env | Occasional | No |
| TD-28 | Arbitrary file read. Env-only. | n/a | Env | Restart | Dir must be same or per-instance. | File names may be sensitive | Env | n/a | No |
| TD-29 | Arbitrary file write. Env-only/drop. | n/a | Env | Restart | Per instance | No | Env | n/a | No |
| TD-30 | Quota bound by env | Low quota: failed imports | Env | Restart for path; live for concurrency | Local disk per instance: cannot agree | Temp files hold user data -> 0600, wiped | Env | Rare | No |
| TD-31 | n/a | Cosmetic | Code defaults | Next export | Agree via store | No | User pref in keyed store | Never | Yes |
| TD-32 | Removing user's opt-out is tightening; enabling opt-out for all needs no env. Attack value low. | Unticked default by mistake: formula-injection exposure; so default stays on. | Code default on | Next export | Agree | No | Env flag "allow opt-out" + user checkbox | Rare | Yes, per export, if admin permits. |
| TD-33 | Bounded | Too low: truncated exports must say so, never silently. | Env | Next export | Agree | No | Env | Rare | Lower only. |
| TD-34 | n/a | Too low: crash/OOM; env typo is operator error | Env/runtime | Restart | Per instance | No | Env | n/a | No |
| TD-35 | Forced FK checks = tightening | Cosmetic | Code | Next import | Agree | No | User pref | Rare | Yes |
| TD-36 | Raise retention = more sensitive data kept; bounded by ceiling. Cannot read others' history unless a role allows (out of scope). | Setting 0 wipes future history only; deletion of existing entries on tightening must need confirmation. | Env defaults before store exists (session-only until store exists, cf. CF-008) | Pruner applies on next run; shorter retention deletes data immediately (irreversible) | Shared store -> consistent; per-instance file store -> divergent | Statements may contain secrets: redact, encrypt-at-rest of store is a store decision (OPEN 12) | Env only (no admin); users delete own | Rare | Yes: lower, delete, opt out. |
| TD-37 | Fixed. | n/a | Code | n/a | n/a | Yes | Code | n/a | No |

### 2.6 Connections and pooling

| ID | (1) | (2) | (3) | (4) | (5) | (6) | (7) direct | (8) | (9) |
|---|---|---|---|---|---|---|---|---|---|
| TD-38 | Raise to ceiling | Too low: user cannot open second target; recoverable | Env default | New connections; lowering does not kill existing, blocks new | Per instance counters unless shared | No | Env | Occasional | No |
| TD-39 | Raise multiplies load on targets | 1 locks out multi-tab use; revert | Env | as above | Counters per instance, so effective limit = N x value (document; or shared counter) | No | Per session/IP only (no stable user, see Q5) | Occasional | No |
| TD-40 | Env-only | Env typo | Env | Restart | Per instance by design | No | Env | n/a | No |
| TD-41 | Fixed | n/a | Code | n/a | Session memory is per instance: sticky routing or reconnect needed (open for multi-instance, links to SEC-TGT-020) | Yes (credentials) | Code | n/a | No |

## 3. PROPOSED values (candidate floor / default / ceiling)

All PROPOSED. Rationale: keep the default safe for a shared, internet-adjacent deployment, make the ceiling the point where one request can plausibly hurt the DBLoom process or a target, and make the floor the point where the feature stops being useful (so a mistyped value cannot brick it).

| Setting | Floor | Default | Ceiling (env) | Rationale |
|---|---|---|---|---|
| Connect timeout | 2 s | 10 s | 30 s | TCP+TLS+auth normally < 3 s; blackholed host must not hold a socket for minutes. |
| Statement timeout | 1 s | 60 s | 600 s | Legacy script limit 300 s is for PHP; report queries need minutes; 0 (unlimited) never allowed. MySQL `max_execution_time` covers only SELECT, MariaDB uses `max_statement_time`: other statements need a client-side `KILL QUERY` watchdog (stack-dependent). |
| Job wall-clock (import/export) | 60 s | 900 s | 7200 s | Large dumps are legitimate; must be bounded. |
| Idle target connection | 1 min | 15 min | session idle timeout | Never outlive the session (SEC-TGT-041). |
| Rows per page | 10 | 25 | admin cap 500 default, env ceiling 5000 | Legacy default 25. |
| Result row cap | 100 | 10 000 | 100 000 | Memory of Node process; cell-level cap complements. |
| Response bytes / cell bytes | 1 MiB / 1 KiB | 16 MiB / 64 KiB | 64 MiB / 1 MiB | BLOB columns defeat row caps. |
| SQL text length | n/a (env) | 1 MiB | n/a | Larger goes to import. |
| Upload size | 1 MiB | 64 MiB | 2 GiB | Must be <= proxy body limit. |
| Decompressed size | 1 MiB | 1 GiB | 4 GiB | |
| Compression ratio | env-only | 100:1 | n/a | Typical SQL compresses 10-30:1. |
| Export size | 1 MiB | 1 GiB | 8 GiB | Stream, never buffer. |
| History | 0 (off) | 100 entries, 30 days | 1000 entries, 365 days | Legacy 25 session entries; DB history was off by default. |
| Connections per session / user / target host | 1 / 1 / 1 | 5 / 10 / 20 | 20 / 50 / 100 | Per-target cap protects the target's `max_connections`. |
| Concurrent imports per user | 1 | 1 | 3 | |
| Step-up window (reference only) | | | | belongs to the security-settings reviewer. |

## 4. Disagreements with the spec text

- **D1 - FR-TGT-141 lists "target-host policy (SEC-TGT-030)" as an administrator UI setting without qualification.** That lets a stolen administrator session remove loopback/metadata blocking, the exact scenario of rule "stolen session cannot widen exposure". Proposed split: TD-01, TD-04 (enable), TD-05 env-only; TD-02, TD-03, TD-06 UI inside an `.env` envelope.
- **D2 - SEC-TGT-142 names "numeric or list-valued" settings.** Boolean permissions (allow private ranges, allow disabling TLS verification, allow server-side file reading, allow opt-out of formula neutralisation) need the same floor/ceiling logic; propose an explicit "permit flag in `.env`, optional narrowing in UI" pattern.
- **D3 - SEC-TGT-032 lets "an explicit per-profile setting" disable verification.** With personal profiles (option B) any user could do it, and sends credentials unverified. Add an `.env` permit flag, default off; visible and audited when used.
- **D4 - SEC-TGT-052 "read-only connection mode".** Define the three levels (TD-21) and state plainly that it is a guard rail: the target account's privileges stay the boundary (SEC-TGT-050). Must block `SET SESSION TRANSACTION READ WRITE`, multi-statement bypass and stored routines that write. Whether it is the default is OPEN decision 4.
- **D5 - SEC-TGT-071 "Reading files from the server filesystem shall be off by default"** says nothing on who can enable it. Propose `.env` only (TD-28) and recommend removing legacy SaveDir (TD-29).
- **D6 - SEC-TGT-112 neutralises only `=`, `+`, `-`, `@` and lets the user disable it.** Propose adding TAB and CR to the set, and an admin option to remove the opt-out (TD-32).
- **D7 - SEC-TGT-033 and SEC-TGT-052 give no values** ("safe defaults"). Section 3 proposes numbers; OPEN item 5 (quantitative targets) is partly answered.
- **D8 - SEC-TGT-031 "resolved once, connect to that address".** Also required: validate every returned A/AAAA address against TD-01 before connecting; normalise IPv4-mapped IPv6, decimal/octal/hex IP spellings; re-validate on every reconnect; verify the TLS certificate against the host name, not the pinned IP. Mechanism depends on the stack (mysql2 allows a custom stream; unverified).
- **D9 - SEC-TGT-143 step-up for every security-relevant change.** Propose step-up only for loosening; tightening (lowering a cap, blocking a host) should be fast in an emergency.
- **D10 - SEC-TGT-144 auto-revert covers only network restrictions of DBLoom access.** A target-host policy mistake does not lock the admin out, so a timer is the wrong tool; propose instead an impact preview ("N profiles, M open connections affected"), versioned settings with one-click rollback, and the CLI reset also covering these settings.
- **D11 - FR-TGT-141 / DEP-TGT-140 say env settings and UI settings are separate; they never say what the UI value does when `.env` bounds change on restart.** Propose: clamp into the new bounds at startup and write an audit entry; if the store is empty or unreachable (before login, first start) the `.env` default applies.
- **D12 - Multi-instance agreement is nowhere stated.** UI values agree only through a shared store; `.env` values must be identical. Propose a startup consistency check (hash of effective `.env` policy kept in the store, warning on mismatch). Counters for TD-38/39 and the rate limit are per instance unless a shared store is used; session-memory credentials (SEC-TGT-020) force sticky routing or lazy re-login. (OPEN 12, SEC-TGT-131 scope remark.)
- **D13 - SEC-TGT-023 and NFR-TGT-090 vs history.** History stores statement text; audit "destructive statements ... without secrets": clarify that redaction of password literals is mandatory and fixed (TD-37), and that audit entries are not deleted by the user's history wipe.
- **D14 - SEC-TGT-018 says direct mode must meet SEC-TGT-030 to 033.** With no admin plane and free-form targets as the owner's main scenario, an empty allow-list means "any public host". Propose that direct mode refuses to start with free-form targets unless the operator names an allow-list or sets an explicit acknowledged flag.
- **D15 - Legacy `Confirm`, `MemoryLimit`, `ExecTimeLimit`, `UploadDir`, `SaveDir` are user- or file-config options in legacy**: `Confirm` as a user switch is replaced by a server-enforced floor (TD-22); MemoryLimit/ExecTimeLimit are PHP concepts with no direct Node equivalent (TD-34, TD-12/13).

## 5. Open questions for the owner

1. **Q1 Envelope pattern.** Accept the pattern "`.env` states the maximum envelope and the initial default; the UI selects inside it; startup clamps stored values into new bounds"? (applies to every row marked UI within ENV bounds.)
2. **Q2 Read-only default.** Is read-only the default for new connections (OPEN decision 4)? If yes, who may switch to read-write: user, or only if admin policy permits?
3. **Q3 Free-form targets.** Since shared profiles are deferred (FU-005), every target in the first release is user-typed. Is an allow-list mandatory in account mode, or is "any public address" an acceptable default? In direct mode (D14)?
4. **Q4 SaveDir and UploadDir.** Keep either in the first release, or download/upload-only? (Recommendation: drop both.)
5. **Q5 Per-user limits in direct mode.** The "user" is target+username (DATA-TGT-094), shared by possibly several people and not authenticated by DBLoom. Are per-user limits (TD-38/39, history, user preferences) accepted as per key and per session only?
6. **Q6 Formula neutralisation.** May a user disable it per export, or only the admin (D6)?
7. **Q7 Statement timeout enforcement.** Is a client-side watchdog (`KILL QUERY`) required for non-SELECT statements? Depends on stack and on which DBMS versions are in scope (OPEN item 2).
8. **Q8 Multi-instance support.** Is more than one instance supported in the first release? If yes: shared store mandatory (OPEN 12), sticky sessions, counters (D12).
9. **Q9 History scope.** Server-stored history at all in account mode (OPEN 13), and may an administrator ever read other users' history?
10. **Q10 Step-up scope.** Confirm D9 (loosening only) and D10 (preview and rollback instead of timer for host policy).
11. **Q11 Socket and SSH-tunnel targets.** Out of the first release (TD-05)?

## 6. Dependencies on undecided scope or stack

- Statement timeout, DNS pinning with correct certificate host name, `LOAD DATA LOCAL` switch off, multi-statement control, memory limit (TD-34), process model and sticky sessions: all depend on the TypeScript/TanStack/Node decision (OPEN item 2) and on the MySQL driver chosen; unverified here.
- Where UI values live and whether instances share them: OPEN items 12 and 13.
- History location, per-user rules in direct mode: OPEN items 11 to 13 and Q5.
- Which import/export formats exist (TD-27) depends on scope (OPEN item 1) and file 04.
- Shared profiles (FU-005) are deferred: when introduced, TD-03/04 gain a third path (admin-defined targets bypass user-typed targets), and TD-08 becomes a profile attribute set by an administrator, so it needs the same `.env` permit flag.
