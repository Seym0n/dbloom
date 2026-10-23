# Wave 5 — applying owner decisions on settings (D-01 to D-23)

Owner: accepted D-01 to D-23 of `12-settings.md` section 6, with D-02 changed (outer allow ceiling PUBLIC by default). D-08 left OPEN. Markers "(changed, owner decisions D-nn)" are in the requirement text.

## Applied edits (file `11-target-security.md`)

| Edit | ID | Before -> after (one line) |
|---|---|---|
| E-01 | DEP-TGT-140 | short `.env` list -> full list (TLS, secrets, audit sink, outbound permits, outer ceiling default public, step-up/revert/delay, limits); dropped features named |
| E-02 | FR-TGT-141 | short UI list -> "UI within ENV bounds" classification, import CLI only, precedence reference; allowed factors omitted (D-08) |
| E-03 | SEC-TGT-142 | "Tighten only" -> "Bounded by `.env`", both directions, reject on write, clamp on read |
| E-04 | SEC-TGT-143 | any security-relevant change -> every UI-bound setting and user-management action; admins always 2FA; optional cooling-off (default 0) |
| E-05 | SEC-TGT-144 | IP list only -> timer only for lockout-capable changes; impact preview and rollback for the rest; deadline stored |
| E-06 | NFR-TGT-145 | audit of changes -> plus clamping and reset audited, abort if audit write fails |
| E-07 | SEC-TGT-014 | policy only -> administrators always 2FA, first admin enrols before setup completes |
| E-08 | SEC-TGT-018 | direct mode meets 020-043 -> plus 017/131, per-target throttling, free-form targets need allow-list or acknowledgement |
| E-09 | SEC-TGT-017 | rate limit -> delay only, no permanent lock, thresholds in `.env` bounds |
| E-10 | DEP-TGT-100 | token "shown in console" -> hashed, 0600 file, TTY only, 60 min, single use, CLI show |
| E-10 | DEP-TGT-123 | setup token required for remote -> token handling as DEP-TGT-100, override in `.env` |
| E-11 | FR-TGT-104, 105 | links -> step-up to issue; recovery resets password/factors/sessions, vault untouched, notices; admin invite = recovery |
| E-12 | SEC-TGT-030, 032 | allow/deny policy -> `.env` hard blocks and envelope, no Unix sockets (D-17); verification off needs `.env` permit |
| E-13 | SEC-TGT-011 | sign count check -> reject non-increasing except 0/0; attestation `none` (D-23) |
| E-14 | SEC-TGT-112 | formula chars `=+-@` -> plus TAB, CR; per-export opt-out only if policy permits |
| E-15 | SEC-TGT-125 | triggers -> effective allow-list, debug, setup open, outbound, high-risk module, probe list; text on public ceiling and separate admin plane (D-02) |
| E-16 | SEC-TGT-129 | global middleware -> `.env` rules only when store unreadable; probe list in `.env` |
| E-17 | NFR-TGT-090 | "retention configurable" -> bounded retention, no delete in UI, admin plane, own events visible to users, external sink |
| E-18 | SEC-TGT-052 | read-only mode -> three levels; default read-only for new connections, user may switch unless forced (D-15); server-side confirmation token |
| E-19 | SEC-TGT-071 | server files off by default -> only via `.env`, no server-side export saving |
| E-20 | SEC-TGT-081 | secrets from env -> one master secret with key ring, no session secret, canary check |
| E-21 | SEC-TGT-147/148, DEP-TGT-120 | two rules -> merged in 147 (148 kept as stub); remote admin needs `.env` range |
| E-22 | SEC-TGT-150 (new) | none -> precedence rule, marked DECIDED (task 2) |
| E-23 | SEC-TGT-031 | resolve once -> validate normalised address on every connect/reconnect, verify cert against host name |
| E-24 | SEC-TGT-135 | sub-path open -> unsupported (D-11) |

Additional edits following accepted decisions: SEC-TGT-015 (D-09, D-10 minimums, offline breached list), SEC-TGT-019 (D-22 mode mismatch refused), SEC-TGT-026 (D-09 vault minimums), SEC-TGT-126 (D-13 wildcard refused), SEC-TGT-128 (D-02 public ceiling, D-03 roles only), SEC-TGT-132 (D-12 probe list), DEP-TGT-150 (D-21 sessions persist), section 14 intro, open-decisions list (read-only decided, D-08 added).

## Not applied or only partly applied

- E-02 part "allowed second factors / primary credential": depends on D-08 (open); omitted from FR-TGT-141.
- E-05 part on 2FA factors in lockout protection: kept, but flagged "applies once D-08 is decided".
- SEC-TGT-012 (TOTP as fallback factor) and 011 (passkey as primary or second factor): unchanged apart from E-13; D-08 open.
- E-11 optional "administrator recovery via CLI only" not adopted (recommendation: optional).
- Invite binding to an email address (FR-TGT-104, ST-083 "Dropped"): no decision covers it; text unchanged.
- D-18 (deny-root feature), D-20 parts (maintenance mode, settings import CLI, logo), D-14 drop of error reporting/telemetry/captcha: recorded in `12-settings.md` / DEP-TGT-140 only; no separate requirement exists in section 11-14 to edit.

## Contradictions found

1. SEC-TGT-125 listed "wildcard allowed hosts" as a warning while D-13 refuses wildcard on non-loopback: trigger removed, refusal added to SEC-TGT-126.
2. ST-010 default (private ranges) vs D-02 (public): rows ST-010, ST-011 fixed; reconciliation note added in section 4 of `12-settings.md`. Consequence to watch: with a public default the SEC-TGT-125 "no effective IP allow-list" warning fires on every non-loopback deployment without a narrower list; intended, not changed.
3. ST-202 (log level in UI) vs D-20 (`.env` only): row marked superseded; the left-column verdict text still reads "UI within ENV bounds" in the row's Setting column text and should be rewritten when the table is next edited.
4. SEC-TGT-052 vs D-15: E-18 said default "may tighten only"; the accepted D-15 makes read-only the default with users able to switch to read-write; text follows D-15.
5. DEP-TGT-150 "sessions ... to be decided" vs D-21: updated.
6. ST-014 (per-user rules) vs D-03: updated. SEC-TGT-148 references in `reviews/wave4-*` are historical.
7. Tension left: SEC-TGT-143 requires 2FA for administrators while D-08 (TOTP in first release) is open; if neither passkey nor TOTP is in scope, step-up has no factor. To be resolved with D-08.
8. Numbers in the changed requirements (retention, minimums, timers) stay PROPOSED and unverified.
