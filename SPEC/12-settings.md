# 12 — Settings classification

**Status: ACCEPTED except the items listed as open.** Consolidation of the four wave-4 reports in `reviews/` (`wave4-settings-network.md`, `-auth.md`, `-targets-data.md`, `-app-ops.md`) for `OPEN.md` item 18. The owner accepted the recommendations D-01 to D-23 of section 6, with one change: D-02, the default of the inbound outer allow ceiling, is PUBLIC (no network restriction by default). Still open: D-08 (passkey primary credential or second factor; TOTP in the first release) and the items listed after the table in section 6 as depending on undecided scope or stack. Every number remains a proposal taken from the reports (themselves unverified practice values, not from a checked standard) unless marked otherwise; the acceptance covers the classification and rules, not the numbers. The edits of section 5 were applied to `11-target-security.md` (log: `reviews/wave5-apply-settings-decisions.md`); the edits that depend on open items were not applied. Where a row below says "PROPOSED", read it as accepted subject to this paragraph.

## 1. How to read this file

**Decided (not reopened):** deployment settings live in `.env` (restart, not editable from the UI). Administrator settings live in the UI (account mode only; direct mode = `.env` only). Rules of `11-target-security.md` section 14 apply (tighten within floor/ceiling from `.env`, step-up, lockout protection with auto-revert and CLI reset, audit, admin plane). One instance per deployment (DEP-TGT-150), so all multi-instance considerations of the reports are dropped. No second-administrator approval, no shared profiles (FU-005), no plugin system (FU-006), no email.

**Verdict vocabulary** (the five verdicts asked for):

| Verdict | Meaning |
|---|---|
| ENV-only | `.env`/process environment, read at startup, no UI field, API call rejected. |
| UI within ENV bounds | Administrator edits in the UI; `.env` supplies floor, ceiling (numbers), envelope or permit flag (lists, booleans) and the default. In direct mode the value comes from `.env`. |
| User pref within admin limits | The user chooses; the administrator (UI within ENV bounds) sets default and allowed range; the user may always go tighter. In direct mode the user value is stored under the key target+username (DATA-TGT-094). |
| Fixed in code | Not a setting. Listed so nobody builds a switch. |
| Dropped | Not carried into the first release. |

**Columns.** *F / D / C* = PROPOSED floor / default / ceiling (blank = not applicable). For list or boolean settings "envelope" is the analogue: `.env` states the maximum the UI may permit. *Dep*: STACK = depends on the undecided stack (OPEN 2), STORE = store type (OPEN 12/13), SCOPE = scope (OPEN 1), KEY = target-key normalisation (OPEN 11), OWN = needs an owner decision in section 6. *Src* = originating report IDs (N- network, AS- auth, TD- targets/data, APP- application/ops). Env-variable names are not fixed here.

**What-if shorthand** used in the "Decisive what-if" column: *stolen session* = an attacker holds an administrator session; *self-lockout* = the administrator mistypes; *pre-store* = needed before the store or login exists.

## 2. Precedence rule (DECIDED: owner accepted D-01; now SEC-TGT-150)

For every setting, the effective value is the first applicable of:

1. **`.env` limits** (floor, ceiling, envelope, permit flag, optional lock) always win.
2. **UI override** stored in the DBLoom store (account mode only).
3. **`.env` default.**
4. **Built-in default.**

Details proposed together with it:
- **Clamp on every read**, not only on write. A stored value outside the `.env` limits (limits tightened later, store restored from an old backup, store edited directly) is clamped to the nearest permitted value, with a warning and an audit entry (one entry per distinct clamp, not per read). Stored data is not rewritten silently; the settings page shows "stored X, effective Y".
- **Lists and booleans.** A permit flag or envelope in `.env` is the ceiling: the UI can only select inside it. A "force" flag in `.env` is the floor: the UI cannot undo it.
- **Lock.** `.env` may lock a setting: the UI shows it read-only with source `.env (locked)`.
- **Source display.** The settings page shows per value its source (limit / UI override / `.env` default / built-in), the permitted range, and a "reset to default" action (removes the UI override; itself audited, same step-up as a change).
- **Store missing, unreadable or before first start:** layers 1, 3, 4 only. The network middleware then runs on `.env` rules alone, never on "no policy" (see C-11).
- **Direct mode:** layer 2 does not exist; layers 1, 3, 4 collapse to `.env` then built-in.
- A change of an `.env` default does not change an existing UI override (the page marks it "overridden"); a change of an `.env` limit does (by clamping).

## 3. Merged table of settings

The reports contain 34 (network), about 75 (auth), 41 (targets/data) and 45 (app/ops) rows. After merging duplicates, there are the rows below. Rows merged from several reports list all source IDs.

### 3.1 Network, transport, inbound exposure (ST-001 to ST-038)

| ID | Setting | Verdict | Decisive what-if | F / D / C | Dep | Related requirements | Src |
|---|---|---|---|---|---|---|---|
| ST-001 | Bind address | ENV-only | Stolen session rebinds to 0.0.0.0 = instant exposure. | D loopback | | SEC-TGT-124 | N-01 |
| ST-002 | Listen ports; plain-HTTP redirect listener on/off | ENV-only | Listener change needs restart; pre-store. | D redirect listener off | | SEC-TGT-122, 124 | N-02, N-09 |
| ST-003 | TLS mode (own TLS / behind declared proxy / loopback plain) | ENV-only | Stolen session switches to plain = downgrade. Non-loopback plain or proxy mode without trusted proxy: refuse start. | | STACK (TLS in adapter) | SEC-TGT-120 | N-03 |
| ST-004 | Inbound TLS minimum version and cipher profile | ENV-only | Weakening is a pure attacker gain. | D TLS 1.2 min, 1.3 preferred | | SEC-TGT-121 | N-04 |
| ST-005 | Certificate/key paths, key passphrase, reload | ENV-only (secret by file or secret manager) | Key replacement = impersonation; key is a secret. | | STACK (reload without restart) | SEC-TGT-121, 081 | N-05 |
| ST-006 | Public origin | ENV-only | Poisoned origin redirects invite links and WebAuthn RP ID to an attacker host. | http on non-loopback: refuse start | | SEC-TGT-126 | N-06 |
| ST-007 | Allowed host names | ENV-only | Adding a host re-enables Host-header attacks; typo is fixed by file edit. | Wildcard: refused on non-loopback (D-13) | DECIDED D-13 | SEC-TGT-126 | N-07 |
| ST-008 | Trusted proxies (CIDR, hop count) | ENV-only | Widening lets an attacker forge client IP and bypass allow-list, rate limit and setup rule. | D empty | STACK | SEC-TGT-127 | N-08 |
| ST-009 | HSTS max-age, includeSubDomains, preload | ENV-only | Sticky in browsers; UI cannot recover. | D max-age 31536000, preload off | | SEC-TGT-123 | N-10 |
| ST-010 | Outer allow ceiling and permanent deny list for inbound addresses | ENV-only | This is the fence; editable from the UI it is void. | D PUBLIC (no network restriction by default; DECIDED D-02, changed from the report proposal loopback + RFC 1918 + ULA); administrators may narrow; admin plane restricted separately (ST-013); SEC-TGT-124 loopback default bind and SEC-TGT-125 warnings stay | DECIDED D-02 | SEC-TGT-128, 142, 147 | N-13 |
| ST-011 | IP allow list (UI) | UI within ENV bounds | Stolen session can at most narrow (self-harm) or widen up to ST-010. | D empty = whole ceiling (public by default, D-02); max 256 rules; must be subset of ST-010 | STACK (one middleware) | SEC-TGT-128, FR-TGT-141, 144 | N-11 |
| ST-012 | IP deny list (UI, additional) | UI within ENV bounds | Stolen session can deny users (DoS); ST-010 deny cannot be removed. | max 256 rules | | SEC-TGT-128, 144 | N-12 |
| ST-013 | Administration networks | ENV-only | Stolen session adding its own range would open the admin plane. | D loopback | | SEC-TGT-147, 148 | N-14 |
| ST-014 | Per-role / per-user address rules | UI within ENV bounds (non-admin roles); admin role = ST-013 | Can only narrow inside ST-010/011. | per-user rules NOT in scope (D-03); roles only | DECIDED D-03 | SEC-TGT-147 (148 merged) | N-15 |
| ST-015 | mTLS mode, CA bundle, identity header name | ENV-only | Disabling or swapping the CA removes the gate. | | | SEC-TGT-130 | N-16 |
| ST-016 | Rate limiter master switch and counter location | Fixed in code (always on, in-process; single instance) | "Off" must not be one click. | | | SEC-TGT-131, DEP-TGT-150 | N-18, AS-66 |
| ST-017 | General request rate, concurrent connections per address | ENV-only | Raising = DoS exposure; a wrong value locks even the UI. Admin networks exempt from the general (not the login) limit. | | | SEC-TGT-131 | N-19 |
| ST-018 | Request body and header size caps | ENV-only | Raising enables memory DoS; the body cap is the ceiling of ST-150. | D body 1 MiB, import 64 MiB | | SEC-TGT-131, 071 | N-20 |
| ST-019 | HTTP timeouts (header, request, idle, shutdown) | ENV-only | Raising = slow-loris; streaming routes exempt. | | | SEC-TGT-131 | N-21 |
| ST-020 | Liveness endpoint (enable, path, port, probe allow-list) | ENV-only; content fixed in code | Pre-store (probes run at boot); probe sources are outside user ranges (C-14). | | OWN, STACK | SEC-TGT-132, 129 | N-22, APP-37 |
| ST-021 | Readiness detail, metrics, version, diagnostics | ENV-only, default off | Enabling leaks version/topology; content needs admin session or loopback. | D off | | SEC-TGT-132 | N-23 |
| ST-022 | CORS allowed origins | ENV-only, default empty | An added origin gives that site credentialed reach. | D empty | | SEC-TGT-133 | N-24 |
| ST-023 | Origin / Fetch-Metadata check strictness | Fixed in code (strict) | Relaxing = CSRF door. | | | SEC-TGT-134 | N-25 |
| ST-024 | CSP extensions, framing, report-only mode | ENV-only; none in the first release | Widening script-src/frame-ancestors makes XSS/clickjacking persistent. | | | SEC-TGT-043 | N-26, APP-31 |
| ST-025 | CSP report endpoint (location, body cap) | ENV-only | External report URI leaks URLs; unauthenticated flood risk. Same origin, log only. | D body 8 KB, C 16 KB | | SEC-TGT-043, 136 | APP-32 |
| ST-026 | Cookie attributes (`HttpOnly`, `Secure` from public scheme, `Path=/`, no Domain, `__Host-` prefix), session ID entropy | Fixed in code | Header-derived `Secure` is spoofable; configurable attributes only add insecure choices. | ID ≥ 128 bit | | SEC-TGT-040, 135 | N-27, AS-48/49/50, APP-44 |
| ST-027 | Cookie `SameSite` (Strict or Lax) | ENV-only | UI exposure lets a stolen session relax it; `None` rejected. | D Strict | | SEC-TGT-040, 135 | AS-49, N-27 |
| ST-028 | Cookie name suffix / instance id | Dropped (single instance) | Only needed for two instances on one host. | | | DEP-TGT-150 | AS-48, APP-07 |
| ST-029 | Base path (sub-path deployment) | Dropped for the first release (PROPOSED) | Conflicts with `__Host-` (needs path `/`). | | OWN, STACK | SEC-TGT-135 | N-28, APP-26 |
| ST-030 | Response header constants (`X-Robots-Tag`, no-store, nosniff, Referrer-Policy) | Fixed in code | Nothing to gain from configurability. | | | SEC-TGT-137, 043 | N-29 |
| ST-031 | First-run setup network rule (loopback only; remote override) | ENV-only | Exists before any store; routes return 404 after setup. | D loopback only | | DEP-TGT-100, 123 | N-30 |
| ST-032 | Exposure warnings | Fixed in code (computed); administrator acknowledgement audited and re-shown after restart | Silencing must not be permanent. | | | SEC-TGT-125, FR-TGT-146 | N-31 |
| ST-033 | Outbound HTTP proxy (URL, user, password) | ENV-only (secret) | Attacker proxy would see outbound traffic; password is a secret. | | | none yet | N-32, APP-16 |
| ST-034 | Step-up window | ENV-only | Stolen session lengthens the window and chains changes; parameter protects the protection (C-10). | F 1 min / D 5 min / C 15 min | | SEC-TGT-143 | AS-43, N-33, APP-38 |
| ST-035 | Auto-revert period for lockout-prone changes | ENV-only | A UI value of 1 s or 0 removes the safety net. | F 1 min / D 5 min / C 15 min | | SEC-TGT-144 | N-33, AS-99, APP-38 |
| ST-036 | Cooling-off delay for loosening changes | ENV-only (new, PROPOSED) | Limits a hijacked session; 0 = immediate. | D 60 min? C 24 h | OWN (C-01) | SEC-TGT-142, 143 | AS R3 |
| ST-037 | The floors, ceilings, envelopes and locks themselves | ENV-only | Editable limits would be circular. | | | SEC-TGT-142 | APP-39 |
| ST-038 | Multi-instance coordination (config fingerprint, shared limiter, settings cache TTL, store lock) | Dropped (DEP-TGT-150) | Single instance. A second instance against the same store is detected (proposed detail of DEP-TGT-150). | | | DEP-TGT-150, FU-007 | N-34, AS R7, APP cache TTL, TD-D12 |

### 3.2 Authentication, sessions, accounts, vault (ST-050 to ST-099)

| ID | Setting | Verdict | Decisive what-if | F / D / C | Dep | Related requirements | Src |
|---|---|---|---|---|---|---|---|
| ST-050 | Login mode (account / direct) | ENV-only after setup; optional `.env` value preselects the mode in the first-run wizard, which may change it (UI-TGT-002, owner 2026-10-23) | Decides whether a UI exists; stolen session must not open direct mode (no 2FA, no audit identity). Store records the mode; start refuses a mismatch unless a migration command is run (PROPOSED). | D account | OWN | SEC-TGT-019, 018 | AS-01 |
| ST-051 | Setup token (supply or generate) and validity | ENV-only (optional supply) | Pre-store; must not stay in log storage (C-06). | F 5 min / D 60 min / C 24 h; ≥ 128 bit | OWN | DEP-TGT-100, 123 | AS-02, APP-06 |
| ST-052 | Application master secret and key ring (MAC keys, CSRF, signed state, encryption of reversible fields such as TOTP seeds) | ENV-only (secret, `_FILE` variant) | Must not sit in the store it protects; wrong key makes TOTP seeds unreadable, so key ring plus startup canary check. | min 32 bytes (256 bit), refuse placeholder | STACK | SEC-TGT-081, 082, 118 | AS-03, APP-03 |
| ST-053 | "Session secret" | Fixed in code: no such setting (server-side sessions need none) | Legacy `blowfish_secret` has no counterpart. | | | SEC-TGT-040, 081 | APP-04 |
| ST-054 | 2FA enforcement scope (none / roles / all) | UI within ENV bounds (ENV floor, e.g. admins); administrator role always on (C-09) | Stolen session switching 2FA off for all. | F set in `.env` / C "all" | | SEC-TGT-014 | AS-10 |
| ST-055 | Grace period before an enforced user must enrol | UI within ENV bounds | Long grace is a covert weakening. | F 0 / D 0 / C 7 d | | SEC-TGT-014 | AS-11 |
| ST-056 | Allowed second factors (passkey, TOTP; recovery codes always) | UI within ENV bounds (may narrow, never widen; at least one stays) | Stolen session downgrades to TOTP; narrowing can strand users (preview refuses). | C = factors enabled in `.env` | TOTP and passkeys in first release (D-08, owner) | SEC-TGT-011, 012, 013 | AS-12 |
| ST-057 | Allowed primary credential (password and/or passkey) | UI within ENV bounds | Enabling password where only passkey was allowed widens phishing surface. | | OWN, SCOPE | FR-TGT-104, SEC-TGT-011 | AS-13 |
| ST-058 | TOTP verification window | ENV-only | UI exposure widens guess surface. | F 0 / D 1 / C 1 (steps either side) | | SEC-TGT-012 | AS-14 |
| ST-059 | TOTP step/digits/algorithm, replay block, recovery-code count and format, 2FA tries per challenge | Fixed in code | Not tunable without weakening. | 10 codes ≥ 60 bit; 5 tries (PROPOSED) | | SEC-TGT-012, 013 | AS-15, 16, 65 |
| ST-060 | WebAuthn relying-party ID and allowed origins | ENV-only (derived from public origin) | Change orphans every passkey; never from UI. Documented recovery path needed. | | | SEC-TGT-011, 126 | AS-17, 18 |
| ST-061 | Attestation policy | Fixed in code: `none` (PROPOSED simplification; AS-19 proposed a UI band) | Attestation is a fleet-control feature; adds library and policy surface. | | OWN, STACK | SEC-TGT-011 | AS-19 |
| ST-062 | WebAuthn verification rules (signature, origin, RP, user verification, fail closed; sign count with 0/0 rule) | Fixed in code | No weaker mode exists. Synced passkeys report counter 0 (C-13). | | | SEC-TGT-011, DEP-TGT-091 | AS-20 |
| ST-063 | Minimum password length | UI within ENV bounds | Stolen session lowers it, then resets a password. | F 12 (ENV min allowed 10) / D 12 / C 64 | | SEC-TGT-015 | AS-30 |
| ST-064 | Maximum accepted password length | Fixed in code | Bounds hashing DoS; no truncation. | 256 chars | | SEC-TGT-015 | AS-31 |
| ST-065 | Composition rules, calendar expiry, empty DBLoom password, forced change at first login | Fixed in code (no rules, no expiry, never empty, forced change on) | Forced change is decided (CF-011). | | | SEC-TGT-103 | AS-32, 36, 37 |
| ST-066 | Breached-password check (source and on/off) | UI within ENV bounds (ENV selects source off / offline list / online range API; `required` forces on) | Turning it off is a weakening; online API is an outbound call. | D on if source exists | OWN (fail-open vs closed) | OPEN 17, NFR-TGT-093 | AS-33 |
| ST-067 | Argon2id parameters for login passwords | ENV-only with code minimums | Lowering weakens future hashes; raising DoS. | min m 19 MiB, t 2, p 1 / D m 64 MiB, t 3, p 1 | STACK | SEC-TGT-015 | AS-34 |
| ST-068 | Validity of an administrator-set temporary password | UI within ENV bounds | Known password with unbounded life. | F 1 h / D 7 d / C 14 d | | SEC-TGT-103 | AS-35 |
| ST-069 | Session idle timeout | UI within ENV bounds (direct mode: ENV) | Stolen session lengthens its own life. Separate administrator value. | F 5 min / D 30 min / C 8 h; admin D 15 min / C 2 h | | SEC-TGT-041 | AS-40 |
| ST-070 | Session absolute lifetime | UI within ENV bounds (direct mode: ENV) | Bounds a stolen cookie even with activity. | F 30 min / D 12 h / C 24 h; admin D 4 h / C 8 h | | SEC-TGT-041 | AS-41 |
| ST-071 | Maximum concurrent sessions per user | UI within ENV bounds | Hiding own session; eviction of a victim (mitigated by 2FA). | F 1 / D 5 / C 20; admin 2 | | SEC-TGT-040 | AS-44 |
| ST-072 | Behaviour at the session limit (evict oldest / refuse) | UI within ENV bounds (both values safe; no band) | None. | D evict oldest, with notice | | | AS-45 |
| ST-073 | "Remember me" persistent cookie | Dropped | Would plant long-lived access. | | OWN | SEC-TGT-041 | AS-46 |
| ST-074 | Recall of last username/server on the login page (legacy `LoginCookieRecall`) | ENV-only, default off (direct mode); never an encrypted credential cookie | In direct mode the username is part of target credentials. | D off | OWN | SEC-TGT-021 | AS-47 |
| ST-075 | Session invalidation on password/factor/role change and disable | Fixed in code | Not a setting. | | | SEC-TGT-040 | AS-51 |
| ST-076 | Login failures per account before backoff | UI within ENV bounds (direct mode: ENV) | Too loose helps brute force; too tight lets anyone throttle an account. | F 3 / D 5 / C 10 | | SEC-TGT-017, 131 | N-17, AS-60 |
| ST-077 | Backoff start and cap; counter window | UI within ENV bounds | A cap of days would be a DoS against any named account. | start D 1 s (1 to 10 s), factor 2; cap F 1 min / D 15 min / C 60 min; window D 15 min (5 to 60) | | SEC-TGT-017 | N-17, AS-61 |
| ST-078 | Failures per effective client address in window | UI within ENV bounds (direct mode: ENV) | Behind a wrong trusted-proxy setting all users share one address. | F 10 / D 20 per 15 min / C 100 | | SEC-TGT-017, 127, 131 | N-17, AS-62 |
| ST-079 | Hard account lock vs delay only | Fixed in code: delay only, no permanent lock; the last administrator is never locked out of the CLI | A hard lock lets an attacker lock out the administrator. | | OWN | SEC-TGT-017 | AS-63 |
| ST-080 | Direct-mode per-target throttle (key includes normalised target host) | ENV-only | Otherwise DBLoom is a password-spraying proxy against third-party servers (C-08). | | KEY | SEC-TGT-017, 018, 030 | AS-64 |
| ST-081 | Invite link lifetime | UI within ENV bounds (administrator may choose a shorter value per invite) | Stolen session mints long-lived links. | F 15 min / D 7 d / C 7 d (owner, 2026-10-23: 7 days) | | FR-TGT-104 | AS-70 |
| ST-082 | Invite and recovery token strength, hash-only storage, single use, URL fragment | Fixed in code | Bearer secret. | 256-bit (spec: ≥ 128) | STACK (fragment routing) | FR-TGT-104, SEC-TGT-023 | AS-71 |
| ST-083 | Binding an invite to an email address | Dropped (owner, 2026-10-23: no email binding; no email is sent) | | | OWN | FR-TGT-104 | AS-72 |
| ST-084 | Recovery link lifetime | UI within ENV bounds | Recovery grants takeover; shorter than invites. | F 15 min / D 24 h / C 72 h | | FR-TGT-105 | AS-73 |
| ST-085 | What recovery resets | Fixed in code: password reset, all passkeys/TOTP revoked, re-enrolment forced, sessions revoked, vault untouched, in-app notice (C-07) | Otherwise a hijacked administrator takes over any account with one link. | | OWN | FR-TGT-105, SEC-TGT-026 | AS-74 |
| ST-086 | Vault Argon2id parameters | ENV-only with code minimums (stored per vault) | Weakening future vaults; target is an offline attack. | min m 64 MiB, t 3, p 1 / D m 128 MiB if runtime allows | STACK | SEC-TGT-026 | AS-80 |
| ST-087 | Vault passphrase minimum strength | UI within ENV bounds | Weak passphrase = offline attack on a stolen store; nobody can reset it. | F 12 chars / D 14 | | SEC-TGT-026 | AS-81 |
| ST-088 | Recovery key format and entropy | Fixed in code | Not tunable. | ≥ 128 bit | | SEC-TGT-026 | AS-82 |
| ST-089 | Vault auto-lock after idle | UI within ENV bounds (new requirement) | Unlocked vault key sits in server memory. | F 1 min / D 15 min / C = session idle | | SEC-TGT-026 | AS-83 |
| ST-090 | Personal profiles (option B) enabled | UI within ENV bounds (ENV flag is the ceiling; UI may switch off, never on) | Switching on is widening. | | | SEC-TGT-024 | AS-84 |
| ST-091 | reCAPTCHA / captcha keys | Dropped | Third-party call in the login path; throttling replaces it. | | OWN | SEC-SAU-031 (legacy) | AS-92 |
| ST-092 | Which account events are audited | Fixed in code (all on, no UI to disable or delete; a failed audit write aborts a settings change) | Attacker's first move is to switch the log off. | | | NFR-TGT-090, 107, 145 | AS-95 |
| ST-093 | Which settings need step-up | Fixed in code: every setting marked "UI within ENV bounds" or "User pref" in section 3 plus user-management actions (role change, invite/recovery issue, disable, delete) | | | | SEC-TGT-143 | AS-100 |

### 3.3 Target connections (ST-100 to ST-129)

| ID | Setting | Verdict | Decisive what-if | F / D / C | Dep | Related requirements | Src |
|---|---|---|---|---|---|---|---|
| ST-100 | Hard-blocked target address classes (loopback, link-local incl. 169.254.169.254, unspecified, multicast, reserved, mapped/NAT64 forms) | ENV-only; opt-out only by a deliberately named flag | Stolen session removes the block = SSRF/metadata pivot. | | | SEC-TGT-030 | TD-01 |
| ST-101 | Private ranges (RFC 1918, ULA, CGNAT) allowed as targets | UI within ENV bounds (ENV permits; UI narrows to named CIDRs) | Stolen session cannot open the internal network unless `.env` allows. | D not permitted | | SEC-TGT-030 | TD-02 |
| ST-102 | Target allow/deny entries (host patterns, CIDR) and allowed ports | UI within ENV bounds (ENV maximum envelope; UI subset; deny always allowed) | Each add is a widening, bounded by the envelope. Preview "N profiles/connections affected". | D ports 3306, 3307-3309 | | SEC-TGT-030, FR-TGT-141 | TD-03, TD-06 |
| ST-103 | Free-form targets (user types any host) | UI within ENV bounds (ENV enables; UI may restrict to allow-list only) | Pre-store in direct mode; first release has no shared profiles, so this is the only target gate. | | OWN (C-08, Q3) | CF-001, CF-006, SEC-TGT-030 | TD-04 |
| ST-104 | Unix-socket targets | ENV-only, default off (candidate: out of first release) | Bypasses every IP rule. | D off | OWN | | TD-05 |
| ST-105 | TLS to targets: mode (required / preferred / off), default verify on | UI within ENV bounds (ENV default and floor `required`; UI may only tighten) | Downgrade sends passwords in clear. | D required | | SEC-TGT-032 | TD-07 |
| ST-106 | Permit to disable certificate verification | ENV-only permit flag (default false); where permitted, the use is a per-connection user choice, shown and audited | Administrator must not enable it for others. | D false | | SEC-TGT-032 | TD-08 |
| ST-107 | Extra CA file for target TLS | ENV-only (per-profile pasted CA is a vault value of the user) | UI-set CA lets a stolen session trust an attacker CA. | | | SEC-TGT-032 | TD-09 |
| ST-108 | Minimum TLS version to targets | ENV-only | Typo breaks all connections; no benefit in changing often. | D 1.2 | | SEC-TGT-032 | TD-10 |
| ST-109 | Connect timeout | UI within ENV bounds | Too high: sockets pile up on blackholed hosts. | F 2 s / D 10 s / C 30 s | | SEC-TGT-033 | TD-11 |
| ST-110 | Statement timeout (user may lower; raise to admin max per statement) | UI within ENV bounds + user pref (lower only) | 0 means unlimited in MySQL and must be rejected. Non-SELECT enforcement needs a client-side `KILL QUERY` watchdog. | F 1 s / D 60 s / C 600 s | STACK, OWN | SEC-TGT-033, 052 | TD-12 |
| ST-111 | Import/export job wall-clock limit | UI within ENV bounds (applies to jobs started later) | | F 60 s / D 900 s / C 7200 s | | SEC-TGT-052 | TD-13 |
| ST-112 | Idle timeout of a target connection | UI within ENV bounds | Longer idle = longer residency of decrypted credentials. | F 1 min / D 15 min / C session idle | | SEC-TGT-041, 020 | TD-14 |
| ST-113 | Rows per page (legacy `MaxRows` 25) and admin cap | User pref within admin limits; admin cap UI within ENV bounds | Page size is taste, load is deployment. | choices 10/25/50/100/250/500/1000; D 25; admin cap D 500 / C 5000 | | | TD-15 |
| ST-114 | Result row cap for one SQL result / browse | UI within ENV bounds (user may lower) | Raising holds large memory. Truncation must be announced. | F 100 / D 10 000 / C 100 000 | | SEC-TGT-052, 033 | TD-16 |
| ST-115 | Max response bytes; max bytes per cell | UI within ENV bounds | BLOB columns defeat row caps. | response D 16 MiB / C 64 MiB; cell F 1 KiB / D 64 KiB / C 1 MiB | | SEC-TGT-052 | TD-17 |
| ST-116 | Max SQL text length | ENV-only | Interacts with the proxy body limit. | D 1 MiB | | | TD-18 |
| ST-117 | Display truncation (`LimitChars`, `MaxCharactersInDisplayedSQL`, `ProtectBinary`) | User pref within admin limits | Cosmetic; `ProtectBinary` must never mean raw HTML. | legacy 50 / 1000 / 'blob' (verified) | | SEC-TGT-112 | TD-19 |
| ST-118 | Exact row-count threshold (`MaxExactCount`) | UI within ENV bounds + user pref (lower only) | Exact `COUNT(*)` on huge tables loads the target. | F 1 000 / D legacy 50 000 / C 1 000 000 | | | TD-20 |
| ST-119 | Read-only mode: (a) deployment-forced, (b) default for new connections, (c) per-connection user switch | (a) ENV-only; (b) UI within ENV bounds; (c) user pref (anyone may tighten) | Guard rail only, not a boundary (SEC-TGT-050). Must block `SET SESSION TRANSACTION READ WRITE` and multi-statement bypass. | D read-only for new connections (D-15) | DECIDED D-15 | SEC-TGT-052, 050 | TD-21 |
| ST-120 | Confirmation of destructive statements | ENV-only floor on for hard class; administrator may add classes; user may add confirmations and switch off only soft ones | Stolen session disables it before a mass delete. Server-side two-step token, not a JS dialog. | legacy `Confirm` true (verified) | | SEC-TGT-052, 114 | TD-22 |
| ST-121 | Blocked statement classes / multi-statement in SQL box | UI within ENV bounds (best effort, labelled) | Administrator cannot enable what `.env` blocks. | | | SEC-TGT-050 | TD-23 |
| ST-122 | `LOAD DATA LOCAL INFILE` off, no cleartext auth plugin without TLS, deliberate multi-statements | Fixed in code | A switch would be an arbitrary file read on the DBLoom host. | | STACK (driver) | | TD-24 |
| ST-123 | Allow empty password for target accounts (legacy `AllowNoPassword`) | UI within ENV bounds (ENV flag is ceiling; direct mode: ENV) | Allowing passwordless DB accounts is a weakening. | D deny (legacy false, verified) | | FR-SAU-203 (legacy) | AS-90 |
| ST-124 | Deny `root` as target user (legacy `AllowRoot`) | UI within ENV bounds, tightening only; ENV can force deny | Denying root does not lock DBLoom itself. | D allow (legacy true, verified; PROPOSED keep) | OWN | FR-SAU-203 (legacy) | AS-91 |
| ST-125 | Concurrent target connections per session / per user / per target host | UI within ENV bounds | Raising multiplies load on targets. | F 1/1/1; D 5/10/20; C 20/50/100 | | SEC-TGT-010 | TD-38, TD-39 |
| ST-126 | Instance-wide connection cap; concurrent statements per session | ENV-only | Instance sizing. | D 200 connections; 2 statements | | | TD-40 |
| ST-127 | Pooling (never share across users or credential sets; reset on reuse) | Fixed in code | Shared pools mix credentials and session state. | | | SEC-TGT-020, CF-010 | TD-41 |
| ST-128 | Redaction of literals in password-setting statements in history and audit | Fixed in code | Switchable redaction leaks credentials into store and backups. | | | SEC-TGT-023 | TD-37 |

### 3.4 Data, files, imports, exports (ST-150 to ST-169)

| ID | Setting | Verdict | Decisive what-if | F / D / C | Dep | Related requirements | Src |
|---|---|---|---|---|---|---|---|
| ST-150 | Max upload size (import) | UI within ENV bounds; effective = min(UI, ENV max, proxy body limit); UI shows the effective minimum | Disk DoS; opaque 413 if limits disagree. | F 1 MiB / D 64 MiB / C 2 GiB | | SEC-TGT-071 | TD-25, N-20 |
| ST-151 | Compression ratio, entries per archive, nesting; decompressed size cap | ratio etc. ENV-only; decompressed size UI within ENV bounds | Raising the ratio is the zip-bomb DoS. | ratio 100:1, 1 entry, no nesting; size F 1 MiB / D 1 GiB / C 4 GiB | | SEC-TGT-071 | TD-26 |
| ST-152 | Enabled import/export formats and other low-risk built-in modules | UI within ENV bounds (ENV lists what the build allows; UI selects; detection by content) | Stolen session can only disable or enable inside the closed registry. | | SCOPE | SEC-TGT-113, 071 | TD-27, APP-19 |
| ST-153 | High-risk modules: server-side file import (legacy `UploadDir`) and display modes that render HTML/links/images | ENV-only to enable (default off); UI may disable; directory paths ENV-only | Enabling = file disclosure or XSS. | D off | SCOPE | SEC-TGT-071, 112 | TD-28, APP-18 |
| ST-154 | Server-side save directory for exports (legacy `SaveDir`) | Dropped (download only) | Server-side file write from a stolen session. | | OWN | | TD-29 |
| ST-155 | Temp directory, cache directory, temp-disk quota; concurrent imports per user | paths and total quota ENV-only (mode 0700, outside web root and store directory, swept hourly); concurrent imports UI within ENV bounds | A repointed directory writes files where they are served. | imports F 1 / D 1 / C 3; sweep D 60 min (5 min to 24 h) | STACK | SEC-TGT-071, SEC-CFG-062 (legacy) | TD-30, APP-36 |
| ST-156 | Export defaults (format, compression, charset); filename template | User pref within admin limits; filename always sanitised (safe token set only) | Template with path parts is traversal. | | | SEC-TGT-072 | TD-31 |
| ST-157 | Formula-injection neutralisation of CSV/spreadsheet cells | UI within ENV bounds (default on; administrator may remove the user's opt-out); user per-export checkbox if permitted | Low-privilege DB user plants `=HYPERLINK()`; exporting administrator is the victim. | prefix set `= + - @ TAB CR` | OWN | SEC-TGT-112 | TD-32 |
| ST-158 | Max export size | UI within ENV bounds; exports stream; truncation announced | | F 1 MiB / D 1 GiB / C 8 GiB | | SEC-TGT-052 | TD-33 |
| ST-159 | Process memory limit (legacy `MemoryLimit`) | ENV-only (runtime flag or container limit) | Pre-start. | legacy -1 (verified; PHP concept) | STACK | | TD-34 |
| ST-160 | Import option defaults (e.g. foreign-key checks) | User pref within admin limits (administrator may force FK checks on) | Default "off" is an integrity risk. | legacy `DefaultForeignKeyChecks` 'default' (verified) | | | TD-35 |
| ST-161 | SQL history and bookmarks: enabled, entries, age, entry length | UI within ENV bounds + user pref (lower only; user can delete own, audit is not deletable) | History holds literals; shortening deletes immediately (confirm, 7-day grace). | F 0 (off) / D 100 entries, 30 d, 64 KiB / C 1000 entries, 365 d (APP-41 said 90 d, 1000, ceiling 365 d, 5000) | STORE, OWN (C-12) | DATA-TGT-094 | TD-36, APP-41 |
| ST-162 | Export of a user's own state (bookmarks, history, preferences; no credentials) | User pref within admin limits | | | STORE | SEC-TGT-026 | APP-35 |
| ST-163 | Keyboard shortcuts off (legacy `DisableShortcutKeys`), console layout options (legacy `Console`) | User pref within admin limits (administrator sets default only) | Character-key shortcuts must be switchable (WCAG 2.1.4). | legacy false (verified) | | | APP-42, APP-43 |
| ST-164 | SQL console / query window available at all | UI within ENV bounds (ENV permit is the ceiling) | Stolen session enabling it widens SQL surface. | D on within permit | SCOPE | SEC-TGT-052 | APP-20 |

### 3.5 Application, store, logging, audit, presentation, operations (ST-200 to ST-229)

| ID | Setting | Verdict | Decisive what-if | F / D / C | Dep | Related requirements | Src |
|---|---|---|---|---|---|---|---|
| ST-200 | DBLoom store location and type | ENV-only | The store cannot hold its own address; repointing would swap in a hostile store. Setup reopening on an empty store needs token and loopback. | | STORE | DEP-TGT-140, DATA-TGT-094 | APP-01 |
| ST-201 | Store credentials and TLS to the store | ENV-only (secret) | Needed to open the store. | | STORE | SEC-TGT-081 | APP-02 |
| ST-202 | Application log level | UI within ENV bounds (time-boxed raise) | Stolen session sets `debug` to dump data; debug only through `.env`. | DECIDED D-20: log level is `.env` only, no UI raise (the verdict in the left column is superseded) | DECIDED D-20 | SEC-TGT-023 | APP-08 |
| ST-203 | Log destinations, format, rotation | ENV-only | Pre-store; repointed logs exfiltrate or blind the operator. | D stdout, JSON lines; file 0600 | STACK | NFR-TGT-090 | APP-09 |
| ST-204 | Audit retention | UI within ENV bounds | Stolen session shortens retention to erase evidence. | F 90 d / D 365 d / C 1095 d (AS-96 said D 90 d; see C-12) | OWN (legal) | NFR-TGT-090 | AS-96, APP-10 |
| ST-205 | Audit access (view, export) | UI (role based, read only); view = admin plane; export needs step-up and is itself logged; no delete in UI | Stolen session reads everything. | | | SEC-TGT-061, 147 | APP-11 |
| ST-206 | External audit sink (syslog, SIEM, append-only file), IP anonymisation | ENV-only | Tamper-resistant copy only worthwhile if the administrator cannot disable it; the only audit route in direct mode. | | | NFR-TGT-090 | AS-97, APP-12 |
| ST-207 | Notice thresholds (failed-attempt burst) and definition of "new location" | UI within ENV bounds | Raising thresholds hides a brute-force. | burst D 10 per 10 min, range 3 to 20 (AS-98: 5 to 50); new location = /24 IPv4, /48 IPv6 (AS-98: /56) not seen for 90 d | OWN | FR-TGT-149 | AS-98, APP-40 |
| ST-208 | Error reporting to a third party (legacy `SendErrorReports`) | Dropped (local error log plus error id shown to the user) | Exfiltrates URLs, SQL and names. | legacy 'ask' (verified) | OWN | | APP-13 |
| ST-209 | Version check | UI within ENV bounds (ENV permit, default off; fixed URL in code) | Outbound GET only, but egress is an `.env` matter; air-gapped sites. | D off; interval F 6 h / D 24 h / C 7 d | OWN | SEC-TGT-132 | APP-14, N-32 |
| ST-210 | Usage telemetry | Dropped (no feature) | Any switch is an exfil path. | | | | APP-15 |
| ST-211 | Debug flags (legacy `DBG.*`, `environment`, verbose errors, test backends) | ENV-only; refuse start on non-loopback bind unless a second override is set | Debug via UI leaks data or enables a weaker 2FA backend. | legacy `environment` 'production', `DBG.*` false (verified) | | DEP-TGT-092, SEC-TGT-125 | APP-17 |
| ST-212 | Default language | User pref within admin limits (administrator default; pre-login: cookie, `Accept-Language`, default) | Harmless; fallback English. | D `en` (legacy `DefaultLang`, verified) | SCOPE (languages) | UI-CC-005 | APP-21 |
| ST-213 | Available languages (legacy `FilterLanguages`) | UI within ENV bounds (subset of bundled set; `en` always on; empty list rejected) | | legacy '' = all (verified) | SCOPE | | APP-22 |
| ST-214 | Default theme / colour mode | User pref within admin limits | Built-in themes only (no uploaded CSS). | D `auto` | | FR-CFG-016/017 | APP-23 |
| ST-215 | Display time zone, date and number formats | User pref within admin limits (storage and audit always UTC, ISO 8601) | Display only. | D UTC | | | APP-24, APP-25 |
| ST-216 | Login-page notice text | UI within ENV bounds (plain text, step-up, audit old/new; direct mode: ENV) | Pre-login text is a phishing channel. | C 300 chars | | SEC-TGT-143 | APP-27 |
| ST-217 | Logo file; custom CSS, JS, HTML templates | logo path ENV-only (raster only); custom CSS/JS/HTML Dropped | SVG and CSS are XSS and redress vectors; conflict with CSP. | | OWN (UI upload?) | SEC-TGT-043 | APP-28 |
| ST-218 | Maintenance mode | UI within ENV bounds (switch with optional absolute end time; `.env` flag forces on; admin plane and CLI exempt; schema migrations set it automatically) | Stolen session = DoS for users; owner must always be able to switch off. | | OWN (session handling) | | APP-29 |
| ST-219 | Information banner (after login) | UI within ENV bounds (plain text; step-up only if shown pre-login) | Lower phishing risk. | C 500 chars | | | APP-30 |
| ST-220 | Settings export / import | export UI; import UI within ENV bounds (each key validated, same limits, one audit entry per key, secrets masked, versioned JSON) | Import must not bypass limits or step-up. | | OWN (UI or CLI only) | | APP-33 |
| ST-221 | Backup and restore of the whole store | ENV-only (schedule, destination) plus CLI; no UI download | Download gives a stolen session hashes, vaults, seeds and audit. Keys kept separately. | | STORE | NFR-TGT-090 | APP-34 |
| ST-222 | Master key for shared profiles | Dropped (deferred, FU-005) | | | | SEC-TGT-027 | APP-05 |
| ST-223 | AI endpoint base URL | ENV-only (PROPOSED) | Decides where target-derived data is sent; changing it from the UI would let a stolen session redirect it. | empty = assistant off | OWN | FR-TGT-251 | |
| ST-224 | AI API key | ENV-only (secret, `_FILE` variant) (PROPOSED) | A secret; must not be shown or logged. | | OWN | FR-TGT-251, SEC-TGT-081 | |
| ST-225 | AI model name; assistant on/off | UI within ENV bounds (PROPOSED) | Switching it off is always safe; the model name only changes which model of the configured service is used. | off until an endpoint is set | OWN | FR-TGT-251 | |

## 4. Reconciliations

Each entry: conflict, sources, recommended resolution (**PROPOSED**), rationale. "Owner" marks entries that need a decision (collected in section 6). Single-instance (DEP-TGT-150) is assumed throughout. **Status after the owner decisions:** all resolutions below are accepted (D-01 to D-23) except where they depend on D-08 (C-09 factor enrolment details, ST-056/057); wording "PROPOSED" in an entry is historical. **D-02 reconciliation:** the outer allow ceiling (ST-010) is public by default, so ST-011 "empty = whole ceiling" means no network restriction until an administrator narrows it or `.env` sets a narrower ceiling; protection of the administration functions rests on the separate admin plane (ST-013, SEC-TGT-147, default loopback), the loopback default bind (SEC-TGT-124) and the SEC-TGT-125 warning, which fires while no effective allow-list exists.

**C-01 Step-up only for loosening versus any change (SEC-TGT-143; AS R3; TD D9; N Q5).** Spec: any security-relevant change. TD: only loosening. AS: loosening needs step-up and a cooling-off. PROPOSED: keep step-up for every change of a setting marked "UI within ENV bounds" or "user pref" in section 3 (ST-093), because a stolen session cannot pass step-up either way and the five-minute window lets a real administrator chain emergency changes after one confirmation. Add an optional cooling-off delay (ST-036, `.env`, PROPOSED default off or short, owner chooses) for loosening only; loosening shows as "pending" and is cancellable; tightening applies at once. Rationale: spec stays simple and strict; the asymmetry costs a non-technical administrator little because loosening is rare. Owner (D-01).

**C-02 Auto-revert timer versus preview and rollback (SEC-TGT-144; TD D10; AS R6).** PROPOSED split: a timer (auto-revert unless confirmed from the new configuration, ST-035) only for changes that can lock administrators or all users out of DBLoom itself: IP allow/deny (ST-011, 012, 014), 2FA scope and factors (ST-054, 056, 057), login throttling values (ST-076 to 078) and session lifetimes shortened below a threshold (ST-069, 070). For target-host policy and other data-plane settings (ST-101 to 103, 105, 109 to 121, 150 to 158) a timer is the wrong tool (nothing locks the administrator out): use an impact preview ("N profiles, M open connections affected"), versioned settings with one-click rollback, and the CLI reset also covering these settings. The pending change and its deadline are stored as an absolute time in the store (it survives restart), the revert needs no step-up, the revert target is the last confirmed configuration. Rationale: matches the actual failure mode of each group. No owner decision needed beyond approval of the split.

**C-03 Target-host policy split between `.env` and UI (FR-TGT-141, SEC-TGT-030; TD D1, D2).** FR-TGT-141 lists "target-host policy" as UI. PROPOSED: ST-100, 104 ENV-only; ST-101, 102, 103 UI inside an `.env` envelope; ST-106 `.env` permit flag. The same "envelope" pattern is used for inbound lists (ST-010 to 012) and for booleans (ST-054, 090, 123, 153, 157), which closes the gap that SEC-TGT-142 names only "numeric or list-valued" settings (TD D2, N D1). Rationale: a stolen administrator session must not remove loopback or metadata blocking.

**C-04 FR-TGT-141 list and DEP-TGT-140 `.env` list are incomplete (all reports).** PROPOSED: replace both lists by the classification of section 3 (edits E-01, E-02). Rule: a setting is `.env`-only if (a) it is needed before the store is readable, (b) it widens browser or egress attack surface, or (c) it is a secret or a limit/envelope itself.

**C-05 "Tighten only" versus tests that allow loosening inside the band (SEC-TGT-142; AS D1; N D7).** The title says one direction, the text and test allow any move inside the limits. PROPOSED: rename to "Bounded by `.env`" and state that moves inside the limits are allowed in both directions (loosening gated by C-01); outside the limits is rejected on the server and clamped on read (precedence rule). Rationale: true one-way tightening would make the UI useless for non-technical administrators (adding an office IP is a loosening). Owner (D-01).

**C-06 Setup token must not be printed to logs (DEP-TGT-100, 123; APP D2).** PROPOSED: token supplied by env, or generated and written to a 0600 file in the data directory; printed to the console only when stdout is a terminal; a CLI command (`setup-token`) shows it on demand on the host; 128-bit random, hashed at rest, single use, valid 60 minutes from process start (ST-051), then gone and setup returns 404. Rationale: container and systemd output goes to log collectors (SEC-TGT-023). Owner (D-04). **Revised by owner (option 2): printing the token to the console is allowed with the conditions in DEP-TGT-100, and the setup page is reachable from any address (DEP-TGT-123); the loopback-only restriction is dropped.**

**C-07 Recovery link lets a hijacked administrator take over accounts (FR-TGT-104, 105; AS D3).** PROPOSED: (1) issuing an invite with a role or any recovery link needs step-up (a hijacked session does not have the factor); (2) redemption of a recovery link resets the password, revokes all passkeys and TOTP of that user, forces re-enrolment, revokes sessions, never touches the vault, and creates an in-app notice and an administrator notice (FR-TGT-149) (ST-085); (3) invites for the administrator role are treated like recovery. Rationale: takeover then becomes visible and the vault stays safe. Second-administrator approval stays out (decided). Option for the owner: recovery of an administrator account only via CLI on the host. Owner (D-05).

**C-08 Direct mode has no rate limiting, so DBLoom could brute-force third-party servers (SEC-TGT-018; AS D9; TD D14).** SEC-TGT-018 lists SEC-TGT-020 to 023, 030 to 033, 040 to 043 but not 017/131. PROPOSED: add SEC-TGT-017 and 131 to that list; keys are effective client address and the pair (normalised target host:port, username) (ST-080, 076 to 078, from `.env`); add a global cap on failed target logins per time (ST-078 family); direct mode refuses to start with free-form targets unless the operator names an allow-list (ST-102/103) or sets an explicit acknowledged flag. Rationale: otherwise DBLoom is a password-spraying proxy. Depends on KEY (OPEN 11). Owner (D-06).

**C-09 Administrators always require 2FA (SEC-TGT-143 vs 014; AS R5/D2).** Step-up needs a factor but 014 only enforces by policy. PROPOSED: accounts with the administrator role always require 2FA (fixed in code); the policy (ST-054) governs other roles. Until the first administrator has enrolled, security settings are read-only and `.env` defaults apply; setup finishes only after enrolment (PROPOSED). Recovery codes and the CLI reset cover a lost factor. Not applicable in direct mode. Owner (D-07).

**C-10 Step-up window and auto-revert period: UI or ENV? (AS-43 UI-band; N-33, AS-99, APP-38 ENV).** PROPOSED: ENV-only (ST-034, 035), values F 1 min / D 5 min / C 15 min each. Rationale: they protect the protection; four reports agree on the value 5 min except APP (3 min), which is within the range.

**C-11 Network middleware before the store is open (SEC-TGT-129; N D2; N R2).** PROPOSED: before the store is open, or if it is unreadable, the middleware uses `.env` rules only (ST-010, 013), never "allow all"; same for defaults of all other settings (precedence rule). Edit E-16.

**C-12 Numeric disagreements between reports.** Audit retention: AS-96 D 90 d, APP-10 D 365 d F 90 d C 1095 d, PROPOSED APP-10. History: TD-36 D 100 entries / 30 d, C 1000 / 365 d; APP-41 D 90 d / 1000, C 365 d / 5000, PROPOSED TD-36 (more conservative; history holds literals). Notice burst range: AS 5 to 50, APP 3 to 20, PROPOSED 3 to 20 (the ceiling keeps alarms audible); new-location prefix /24 and /48 (AS: /56). Backoff start: N 1 s, AS 2 s, PROPOSED 1 s. Auto-revert: N 300 s, AS 5 min, APP 3 min, PROPOSED 5 min. All are owner-adjustable numbers, not decisions of principle.

**C-13 Sign-count rule (SEC-TGT-011; AS D6).** Synced passkeys always report counter 0. PROPOSED: accept when stored and received counter are both 0; reject and audit any other non-increasing counter (ST-062). Edit E-13.

**C-14 Health endpoint versus global network middleware (SEC-TGT-129, 132; APP D6; N D11).** Probes come from outside user and administration ranges. PROPOSED: liveness answers on the same listener but is checked against a separate `.env` probe allow-list (default loopback), or on a separate loopback port; the CSP report endpoint follows the user allow-list, not the probe list. Owner (D-12).

**C-15 Sub-path deployment versus `__Host-` (SEC-TGT-135; N D6, AS D8, APP D8).** All reports recommend not supporting it in the first release. PROPOSED: unsupported; ST-029 dropped; DBLoom is served at the root of a host name. Owner (D-11).

**C-16 "Session secret" (SEC-TGT-081, APP D1).** PROPOSED: no session secret; one application master secret with key ring and purpose-bound derived keys (ST-052, 053). Edit E-20.

**C-17 Per-profile certificate-verification switch (SEC-TGT-032; TD D3).** PROPOSED: an `.env` permit flag (default false); where permitted, the per-connection choice is the user's, shown and audited (ST-106). Edit E-12.

**C-18 Multi-instance items in the reports.** Cookie suffix, config fingerprint, shared limiter, settings cache TTL, store lock, sticky sessions: dropped (ST-028, 038, 016). Retained consequences: pending changes and timers are stored as absolute times (survive restart); sessions persist in the store and survive a restart (decided D-21, DEP-TGT-150).

**C-19 Audit failure versus availability (AS-95; NFR-TGT-093).** PROPOSED: if the audit entry for a settings change cannot be written, the change is aborted (fail closed); logins continue; a failing external sink buffers locally and alerts on the admin page (ST-092, 206).

**C-20 Version check and outbound calls (APP-14 "BOTH" vs N-32 "ENV-only").** PROPOSED: `.env` permit default off, UI toggle inside it (ST-209); legacy default is on (verified, section 7), so this is a deliberate change. DBLoom makes no other outbound call in the first release (owner confirms, D-14).

## 5. Proposed edits to existing requirements

**APPLIED to `11-target-security.md` after the owner accepted D-01 to D-23, adjusted for D-02 and except where an edit depends on the open D-08 (see `reviews/wave5-apply-settings-decisions.md` for the exact state of each edit). The text below is the original proposal and is kept for traceability; the requirement text in `11-target-security.md` governs.** Quoted IDs are current IDs; "new" IDs use the next free numbers and must be checked against the file when applied.

**E-01 DEP-TGT-140** replace the second sentence ("It covers at least: ...") with: "It covers at least: bind address and ports, TLS mode, certificates, public origin, allowed host names, trusted proxies, HSTS, mTLS, CORS, CSP settings, listener limits and timeouts (SEC-TGT-124 to 127, 131); the login mode (SEC-TGT-019); first-run setup rules and setup token; the location and credentials of the DBLoom store; the application master secret and key ring (SEC-TGT-081); log destinations, audit sink and debug flags; outbound proxy and permits for outbound features (version check); health and diagnostic endpoints; temporary and cache directories; administration networks (SEC-TGT-147); the outer allow ceiling and permanent deny list for inbound addresses; target hard blocks, TLS-to-target floors, certificate-verification permit and extra CA; Argon2id parameters, TOTP window and WebAuthn relying-party ID; step-up window, auto-revert period and loosening delay; and every floor, ceiling, envelope, permit flag and lock of the settings in FR-TGT-141 (SEC-TGT-142). The complete classification is `12-settings.md`."

**E-02 FR-TGT-141** replace with: "Administrators shall be able to change the administrator settings classified 'UI within ENV bounds' in `12-settings.md` from the UI; values are stored in the DBLoom store. They include at least: IP allow/deny lists (SEC-TGT-128), enforced-2FA scope, grace period and allowed factors (SEC-TGT-014), session lifetimes (SEC-TGT-041), login throttling (SEC-TGT-017, 131), the target-host policy within its `.env` envelope (SEC-TGT-030), invite and recovery link lifetimes (FR-TGT-104, 105), password policy within its floors, audit retention, notice thresholds, query and size limits, and import/export module selection. Settings of DEP-TGT-140 shall not be editable from the UI and a direct API call to change one shall be rejected. Importing settings (if offered) shall pass the same limits. In direct mode the same settings come from `.env`. The effective value of each setting follows the precedence rule (SEC-TGT-150)."

**E-03 SEC-TGT-142** replace title and text: "Bounded by `.env`. The deployment configuration shall define, for each administrator setting, a floor and ceiling (numbers), an envelope (lists) or a permit and a force flag (booleans), and may lock the setting. The UI may move a value inside these limits, in both directions, and the server shall reject values outside them on write and clamp them on read, with a warning and an audit entry. *Verification:* a request that sets a session lifetime above the ceiling is rejected; a stored value above a later-lowered ceiling is clamped on read."

**E-04 SEC-TGT-143** replace with: "Step-up check. Changing a setting classified 'UI within ENV bounds' or a user-management action (role change, invite or recovery link, disable, delete) shall require a fresh passkey or 2FA confirmation within the step-up window (`.env`, default 5 minutes), even in an active session. Administrator accounts always have 2FA (SEC-TGT-014). A change that loosens a setting may additionally be held pending for a cooling-off period (`.env`, 0 = immediate), shown as pending and cancellable. Automatic revert (SEC-TGT-144) needs no step-up. *Verification:* as before, plus a pending loosening takes effect only after the delay." (PROPOSED; ST-036 is an owner decision.)

**E-05 SEC-TGT-144** replace with: "Lockout protection. If a change to IP allow/deny lists, 2FA scope or factors, login throttling or session lifetimes would exclude the acting administrator or, by preview, other users, DBLoom shall warn with the number of affected users and require explicit confirmation; the check shall use the effective client address (SEC-TGT-127). Such changes shall apply with automatic revert after the auto-revert period (`.env`, default 5 minutes, range 1 to 15) unless confirmed from the new configuration or a new session; the pending change and its deadline are kept in the store so a restart neither loses nor makes it permanent. For other settings (for example target-host policy) the administrator shall see an impact preview, settings shall be versioned with one-click rollback, and the CLI reset shall cover them. A command-line or configuration-file reset shall exist for the case in which all administrators are locked out. *Verification:* as before, plus restart during a pending change."

**E-06 NFR-TGT-145** append: "Clamping of a stored value to `.env` limits and every reset to default shall be audited. If the audit entry cannot be written, the change shall be aborted."

**E-07 SEC-TGT-014** append: "Accounts with the administrator role shall always require 2FA; the policy applies to other roles. The first administrator shall enrol a factor before setup completes."

**E-08 SEC-TGT-018** replace "SEC-TGT-020 to 023, 030 to 033 and 040 to 043" with "SEC-TGT-017, 020 to 023, 030 to 033, 040 to 043 and 131"; append: "Rate limiting shall be keyed by effective client address and by normalised target host and username, so that DBLoom cannot be used to guess passwords of third-party servers. Free-form targets in direct mode shall require a named target allow-list or an explicit acknowledgement setting; otherwise startup is refused."

**E-09 SEC-TGT-017** append: "Throttling shall delay with backoff and shall never lock an account permanently. Thresholds are administrator settings within `.env` bounds (ST-076 to 078); in direct mode they come from `.env`."

**E-10 DEP-TGT-100** replace the *Proposed detail* with: "*Proposed detail:* setup is protected by a one-time token of at least 128 bits, supplied by environment variable or generated at startup and stored only as a hash; a generated token is written to a file readable only by the DBLoom user (and printed to the console only when stdout is a terminal), never to a log stream (SEC-TGT-023); it is valid for 60 minutes from process start and single use; a CLI command shows it on the host. The first administrator enrols a factor before setup completes."

**E-11 FR-TGT-104 and FR-TGT-105** append to both: "Issuing the link requires step-up (SEC-TGT-143). Redeeming a recovery link resets the password, revokes all passkeys and TOTP of the user, forces re-enrolment, revokes the user's sessions, does not affect the vault (SEC-TGT-026) and creates an in-app notice for the user and the administrators (FR-TGT-149). Invites for the administrator role are treated like recovery. Lifetimes are administrator settings within `.env` bounds."

**E-12 SEC-TGT-030 and SEC-TGT-032** append to 030: "Loopback, link-local, unspecified, multicast and reserved classes and their mapped forms are blocked by `.env` only; private ranges are permitted only if `.env` allows, and the UI may then narrow to named ranges. Allow/deny entries and ports are administrator settings inside an `.env` envelope." Replace in 032 "Disabling verification shall require an explicit per-profile setting and shall be visible in the UI." with "Disabling verification shall require that `.env` permits it (default: not permitted) and an explicit per-connection or per-profile choice by the user, which is visible in the UI and audited."

**E-13 SEC-TGT-011** append: "Sign-count check: reject and audit a received counter that is not greater than the stored one, except when both are 0 (authenticators that do not count)."

**E-14 SEC-TGT-112** replace "start with `=`, `+`, `-` or `@`" with "start with `=`, `+`, `-`, `@`, TAB or CR" and "unless the user explicitly disables it" with "unless the user disables it for one export and the administrator policy permits that".

**E-15 SEC-TGT-125** replace "no IP allow-list and no mTLS" with "no effective IP allow-list (computed from the `.env` ceiling and the UI list) and no mTLS" and add triggers: "debug flag or log level debug, setup still open, any outbound feature enabled, high-risk module enabled, probe allow-list wider than loopback".

**E-16 SEC-TGT-129** append: "Before the store is open, or when it cannot be read, the middleware shall evaluate `.env` rules only and shall never run with no policy. The probe allow-list for health checks is set in `.env`."

**E-17 NFR-TGT-090** replace "Log retention and access shall be configurable." with "Audit retention shall be an administrator setting within an `.env` floor and ceiling (proposed 90 to 1095 days, default 365); there shall be no UI function to delete or edit entries; access shall be limited to the administration plane (SEC-TGT-147), export shall need step-up and be logged, and an external append-only sink may be configured in `.env`."

**E-18 SEC-TGT-052** replace the first sentence with: "DBLoom shall offer a read-only connection mode at three levels: forced for the deployment (`.env`), default for new connections (administrator, may tighten only), and per connection (any user may tighten). It is a guard rail and not a security boundary (SEC-TGT-050). It shall block read-write transaction switches and multi-statement bypass. The destructive-statement confirmation shall be enforced on the server by a two-step token, with the hard class set in `.env` and not switchable from the UI or by users."

**E-19 SEC-TGT-071** replace "Reading files from the server filesystem shall be off by default." with "Reading files from the server filesystem shall be off by default and shall be enabled only in `.env`, with the directory fixed there; server-side saving of exports is not provided."

**E-20 SEC-TGT-081** append: "There is one application master secret (with a key ring for rotation, at least 32 bytes) from which purpose-bound keys for CSRF, signed client state (SEC-TGT-118) and encryption of reversible fields are derived; there is no separate session secret, because sessions are server-side. Startup verifies the key against a canary record."

**E-21 SEC-TGT-147 and SEC-TGT-148** merge 148 into 147 (same rule). Add to DEP-TGT-120: "Remote administration requires an administration range in `.env`."

**E-22 New SEC-TGT-150 (proposed)** "Precedence. The effective value of every setting is, in order: (1) `.env` limits; (2) UI override in the store; (3) `.env` default; (4) built-in default. Values outside the `.env` limits are clamped on every read with a warning and an audit entry. The settings page shall show each value's source and offer reset to default." Only after the owner approves section 2.

**E-23 SEC-TGT-031** append: "Every returned address shall be validated against the blocked classes before connecting, in normalised form (mapped IPv6, decimal, octal and hex spellings), again on every reconnect; the certificate shall be verified against the host name, not the pinned address."

**E-24 SEC-TGT-135** after owner decision D-11: add "Deployment under a URL sub-path is not supported in the first release."

## 6. Owner decisions

All entries DECIDED (recommendation accepted) except D-02 (accepted with change: public default).

| # | Decision | Recommendation | Related | Owner answer |
|---|---|---|---|---|
| D-01 | Approve the precedence rule (section 2) and the rename of SEC-TGT-142 to "Bounded by `.env`" (loosening allowed inside limits, with step-up for every change; optional cooling-off delay and its default). | Approve; delay optional, default off or short. | C-01, C-05, ST-036 | DECIDED: accepted as recommended; cooling-off delay optional, default 0 (off) |
| D-02 | Default of the inbound outer allow ceiling: private ranges only, or none. | Private ranges (loopback, RFC 1918, ULA). | ST-010 | DECIDED with change: default of the outer allow ceiling is PUBLIC (no network restriction by default); administrators may narrow it; admin plane restricted separately (SEC-TGT-147) |
| D-03 | Per-user address rules in scope? | No, roles only. | ST-014 | DECIDED: accepted (roles only) |
| D-04 | Where the setup token may go (file / env / TTY only). | File 0600 plus env, TTY only if terminal. | C-06 | DECIDED (revised by owner, option 2): the setup page is reachable from any address and protected by the token; the token may be printed to the console with conditions (single use, 60 minutes, new token at each start, "consumed" message, deployment guide note). Loopback-only restriction dropped (DEP-TGT-100, 123). |
| D-05 | Recovery: administrator accounts only via CLI? Recovery link resets second factors? | Resets factors (yes); CLI-only for administrators optional. | C-07 | DECIDED: accepted (recovery resets factors; CLI-only for administrators stays optional, not required) |
| D-06 | Direct mode: refuse start with free-form targets unless allow-list or acknowledgement; per-target throttling. Is an allow-list mandatory in account mode too? | Refuse; mandatory allow-list not required in account mode. | C-08, ST-103 | DECIDED: accepted |
| D-07 | Administrators always need 2FA; first administrator enrols before setup completes. | Yes. | C-09 | DECIDED: accepted |
| D-08 | Is a passkey a primary credential (passwordless) or only a second factor? Is TOTP in the first release? | Decide with scope. | ST-056, 057 | DECIDED (owner): both passkeys and TOTP are in the first release, and a passkey can be a primary credential. A passkey login with user verification satisfies the enforced-2FA policy by itself (owner), provided the authenticator reports the user-verified flag (SEC-TGT-014). |
| D-09 | Hard-coded minimums (password 12, Argon2id login m 19 MiB t 2, vault m 64 MiB t 3, TOTP +/-1, token 256 bit). | Accept; check runtime memory once the stack is chosen. | ST-063, 067, 086 | DECIDED: accepted as principle; numbers stay PROPOSED and unverified (check runtime memory once stack is chosen) |
| D-10 | Breached-password source (offline list / online range API / none) and fail-open or fail-closed. | Offline list, fail closed for the first admin, fail open with warning otherwise. | ST-066 | DECIDED: accepted |
| D-11 | Sub-path deployment: unsupported? | Unsupported. | C-15, ST-029 | DECIDED: accepted |
| D-12 | Liveness endpoint: probe allow-list or separate loopback port. | Separate allow-list in `.env`. | C-14, ST-020 | DECIDED: accepted |
| D-13 | Wildcard allowed host names: warn or refuse on non-loopback. | Refuse. | ST-007 | DECIDED: accepted |
| D-14 | Any outbound call at all in the first release (version check)? Drop error reporting, telemetry, captcha? | Off by default, drop the other three. | ST-091, 208, 209, 210 | DECIDED: accepted |
| D-15 | Read-only default for new connections; who may switch to read-write. | Read-only default for new connections, user may switch to read-write unless policy forbids. | ST-119 | DECIDED: accepted |
| D-16 | Formula neutralisation: may a user disable it per export? | Only if administrator policy permits. | ST-157 | DECIDED: accepted |
| D-17 | Drop `SaveDir`, keep `UploadDir` (default off)? Socket targets out of the first release? | Drop SaveDir, UploadDir off, sockets out. | ST-104, 153, 154 | DECIDED: accepted |
| D-18 | Keep deny-root as a feature; default allow? | Keep, default allow. | ST-124 | DECIDED: accepted |
| D-19 | Audit retention minimum and maximum (legal), IP storage allowed, ordinary users see own events? | Floor 90, default 365, ceiling 1095 days; own events yes. | ST-204, APP Q9 | DECIDED: accepted (numbers PROPOSED, legal check still advisable) |
| D-20 | Maintenance mode: effect on running sessions; settings export/import in UI or CLI only; log level in UI or `.env` only; logo upload. | Banner then read-only after grace; CLI only for import; log level `.env` only; no upload. | ST-202, 217, 218, 220 | DECIDED: accepted |
| D-21 | Do sessions survive a restart (DEP-TGT-150, open)? | Persist in the store. | C-18 | DECIDED: accepted |
| D-22 | Switching login mode on a deployment with data: unsupported unless a migration command is run? | Yes, refuse mismatch. | ST-050 | DECIDED: accepted |
| D-23 | Attestation: fixed `none` (simplification of AS-19)? | Yes. | ST-061 | DECIDED: accepted |

**Still OPEN** (not decided): D-08 and the following items depending on undecided scope or stack (not owner decisions of principle): certificate reload (ST-005), forwarded-header handling of the runtime (ST-008), single middleware over all route classes (ST-011), statement timeout watchdog and driver behaviour (ST-110, 122), Argon2 and WebAuthn libraries and memory (ST-061, 067, 086), URL-fragment tokens (ST-082), memory limit (ST-159), store type (ST-200, 221), which modules and languages exist (ST-152, 164, 212, 213), target key normalisation (ST-080).

## 7. Unverified items and legacy defaults

The app-ops report took legacy defaults from memory. The following were checked against `libraries/config.default.php` of the 5.2.3 tree (`doc/` ignored). Line numbers are those of that file.

**Verified (value matches the report):** `AllowThirdPartyFraming` false (100); `ssl_verify` true (200); `AllowRoot` true (533); `AllowNoPassword` false (540); `AllowDeny` order '' and rules [] (547, 554); `ProxyUrl` and `ProxyUser` '' (652, 662); `ExecTimeLimit` 300 (718); `MemoryLimit` '-1' (741); `MaxCharactersInDisplayedSQL` 1000 (697); `Confirm` true (790); `CookieSameSite` 'Strict' (802); `LoginCookieRecall` true (809); `LoginCookieValidity` 1440 (817); `LoginCookieStore` 0 (824); `LoginCookieDeleteAll` true (831); `AllowArbitraryServer` false (867); `MaxRows` 25 (1278); `ProtectBinary` 'blob' (1334); `ZipDump`, `GZipDump`, `BZipDump`, `CompressOnFly` true (1414 to 1436); `DefaultForeignKeyChecks` 'default' (1403); `DefaultLang` 'en' (2389); `FilterLanguages` '' (2411); `LimitChars` 50 (2557); `QueryHistoryDB` false (2616); `QueryHistoryMax` 25 (2623); `MaxExactCount` 50000 (2637); `ThemeDefault` 'pmahomme' (2725); `UploadDir` and `SaveDir` '' (2805, 2814); `TrustedProxies` [] (2844); `CheckConfigurationPermissions` true (2853); `CSPAllow` '' (2868); `SendErrorReports` 'ask' (2886); `DBG` flags false including `simple2fa` (2914 to 2935); `environment` 'production' (2945); `DisableShortcutKeys` false (2992); `PmaAbsoluteUri` '' (39).

**`VersionCheck`:** the default is not a literal. `config.default.php:637-640` takes `VERSION_CHECK_DEFAULT` (from `libraries/vendor_config.php:61`, `versionCheckDefault` = true) and otherwise true. So the legacy default is on; the report's "on" is right, but a distribution can change it.

**Not verified (marked unverified):**
- Semantics of `Confirm` (JS dialog before DROP/DELETE) was not re-read in code; only the default was checked.
- Legacy `Console` sub-options (defaults of `StartHistory`, `AlwaysExpand`, `EnterExecutes`, `Height`, ...): only the `Console` array's existence was located (line 2999).
- The claim that `MemoryLimit`/`ExecTimeLimit` map to PHP settings only, and the behaviour of `LoginCookieValidity` against `session.gc_maxlifetime`: not checked here.
- Legacy `AllowDeny['order']` values ('deny,allow', 'allow,deny', 'explicit') as listed in the network report: only the empty default was checked; the allowed values are in the spec (SEC-SAU-302/303), not re-verified against `IpAllowDeny.php` in this pass.
- `blowfish_secret` default '' is present (109); the claim that short values are ignored and a secret is generated per process (SEC-SAU-207 cited by the auth report) is taken from the spec, not re-read.
- All numeric floors, defaults and ceilings in section 3 are the reports' judgement (OWASP ASVS, NIST SP 800-63B, general practice as remembered); no live lookup of standards was done, and no value was tested against a running implementation.
- External facts quoted by the reports (WebAuthn synced passkeys report counter 0; `__Host-` cookies require `Secure`, path `/` and no Domain; MySQL `max_execution_time` applies to SELECT only and MariaDB uses `max_statement_time`; HIBP-style range API sends a 5-hex-character prefix) are general knowledge, unverified here.
