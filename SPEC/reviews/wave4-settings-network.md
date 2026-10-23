# Wave 4 - Settings classification: network, transport, inbound exposure

Status: review input for OPEN item 18. Everything marked PROPOSED is a suggestion, not a decision. Basis: `11-target-security.md` sections 13-14 (read in full), `OPEN.md` item 18, `10-conflicts.md` (CF-009..011), `FUTURE.md`, legacy `libraries/config.default.php` (PmaAbsoluteUri, AllowThirdPartyFraming, CSPAllow, CaptchaCsp, TrustedProxies, Servers[i][AllowDeny], CookieSameSite, LoginCookieValidity, ExecTimeLimit, MemoryLimit, ProxyUrl/User/Pass, VersionCheck, CheckConfigurationPermissions). Legacy has no `ForceSSL` (removed before 5.2.3; SEC-TGT-120 says the same), no CORS, no health endpoint, no rate limiting.

Terms: ENV = `.env`/process environment, startup only. UI = administrator UI, account mode only. "Bound" = a limit that lives in ENV and that the UI cannot cross. Direct mode has no UI, so every setting below is ENV in direct mode (decided, OPEN 18).

Two structural rules used throughout (these are my proposals, see disagreement D1):
- R1 "Outer fence": the effective network policy is evaluated in this order: ENV hard rules first (permanent deny, outer allow ceiling, admin networks), then UI rules. The UI can only narrow what ENV allows. This is what makes "tighten only" real for list-valued settings, where "floor/ceiling" has no meaning.
- R2 "Bootstrap policy": before the store is open (or if it is unreadable), the middleware (SEC-TGT-129) runs on ENV rules alone and treats the UI layer as empty. It never runs with "no policy".

---

## 1. Setting inventory and verdicts

IDs N-nn are local to this review. "Spec" gives the existing requirement.

| ID | Setting | Spec | Legacy | Verdict | Bound in ENV | Decisive what-if |
|---|---|---|---|---|---|---|
| N-01 | Bind address | SEC-TGT-124 | none (PHP) | ENV-only | n/a | W4/W1: listener change needs restart and an admin-session attacker must not be able to rebind to 0.0.0.0 |
| N-02 | Listen ports (HTTPS, optional HTTP-redirect, optional health port) | SEC-TGT-122, 124 | none | ENV-only | n/a | W4: listener; W3: needed before store |
| N-03 | TLS mode (own TLS / behind declared proxy / loopback-plain) | SEC-TGT-120 | `Config::isHttps()` detection only | ENV-only | n/a | W1: attacker flipping to "plain" downgrades all traffic; W3: needed to open the listener |
| N-04 | TLS minimum version and cipher profile | SEC-TGT-121 | none | ENV-only | n/a | W1+W4: weakening is a pure attacker gain, no admin need to change often |
| N-05 | Certificate and key file paths, key passphrase, reload trigger | SEC-TGT-121 | none | ENV-only (secret: path in ENV, key file/secret manager, never UI) | n/a | W6: private key is a secret; W3: needed to start TLS |
| N-06 | Public origin (scheme, host, port) | SEC-TGT-126 | `PmaAbsoluteUri` | ENV-only | n/a | W1: poisoning it redirects invite/recovery links and WebAuthn RP ID to an attacker host |
| N-07 | Allowed host names | SEC-TGT-126 | none (HTTP_HOST trusted) | ENV-only | n/a | W1: adding a host re-enables Host-header attacks; W2: mistype locks everyone out but the fix is a file edit, no UI needed |
| N-08 | Trusted proxies (CIDR list, hop count, forwarded-header policy) | SEC-TGT-127 | `TrustedProxies` | ENV-only | n/a | W1: widening it lets the attacker forge client IP and bypass allow-list and rate limit |
| N-09 | Plain-HTTP redirect listener on/off | SEC-TGT-122 | none | ENV-only | n/a | W4: separate listener |
| N-10 | HSTS max-age, includeSubDomains, preload | SEC-TGT-123 | none | ENV-only | n/a | W2: a wrong HSTS value is sticky in browsers (preload is practically irreversible), UI recovery is impossible by design |
| N-11 | IP allow list (global) | SEC-TGT-128, FR-TGT-141 | `AllowDeny` per server | UI within ENV fence (R1) | ENV outer allow ceiling (N-13); UI list must be a subset | W1: attacker may only narrow (self-harm) or widen up to the ceiling, never beyond |
| N-12 | IP deny list (additional, UI) | SEC-TGT-128 | `AllowDeny` | UI within ENV fence | ENV permanent deny list (N-13) cannot be removed from UI | W2: mistyped deny can lock out; auto-revert + CLI reset |
| N-13 | ENV outer allow ceiling and permanent deny list | SEC-TGT-142, 128 | none | ENV-only | n/a | W1: this is the fence itself; if editable from UI the fence is void |
| N-14 | Administration networks | SEC-TGT-147 | none | ENV-only (as spec) | n/a | W1: attacker admin adding own network opens the admin plane to the internet |
| N-15 | Per-role / per-user address rules | SEC-TGT-148 (roles), open (users) | none | Role rule for admin: ENV (= N-14). Other roles: UI within the fence. Per-user: UI within the fence, undecided scope | N-13 | W8: non-technical admin needs per-user rules; W1: still bounded by fence |
| N-16 | mTLS mode, CA bundle, identity header name | SEC-TGT-130 | none | ENV-only | n/a | W1: turning mTLS off or swapping CA removes the gate; W6: CA path |
| N-17 | Login rate-limit thresholds and backoff (per account, per IP) | SEC-TGT-017, 131, FR-TGT-141 | none | UI within ENV floor+ceiling | ENV: min and max for every value (below) | W1+W2: too loose helps brute force, too tight lets anyone lock out all users |
| N-18 | Rate limiter master switch and store scope (memory / shared) | SEC-TGT-131 | none | ENV-only | n/a | W5: scope must match instance count; W1: "off" must not be one click |
| N-19 | General request rate, concurrent connections per IP, global concurrency | SEC-TGT-131 | none | ENV-only | n/a | W4: listener-level, W2: wrong value = outage, UI unreachable if rate-limited |
| N-20 | Max request body, max header size | SEC-TGT-131, 071 | php.ini (not config) | ENV-only for HTTP-level caps; import upload size = separate setting inside the ceiling given by this cap | ENV cap is the ceiling | W1: raising the cap enables memory DoS |
| N-21 | Timeouts (header, request, idle keep-alive, graceful shutdown) | SEC-TGT-131 (implied) | `ExecTimeLimit` 300 s, `MemoryLimit` -1 | ENV-only | n/a | W4: listener; W1: slow-loris exposure if raised |
| N-22 | Liveness endpoint on/off, path, optional separate port | SEC-TGT-132 | none | ENV-only | n/a | W3: orchestrators probe before store exists; W9: path disclosure |
| N-23 | Readiness detail, metrics, version, debug endpoints on/off | SEC-TGT-132 | none | ENV-only (default off); content then needs admin session | n/a | W1: enabling leaks version/topology to a later foothold |
| N-24 | CORS allowed origins | SEC-TGT-133 | none | ENV-only, default empty (off) | n/a | W1: an added origin gives that site credentialed cross-origin reach |
| N-25 | Origin/Fetch-Metadata check strictness (SEC-TGT-134 opt-outs) | SEC-TGT-134 | POST token only | ENV-only, fixed strict; not user-configurable | n/a | W1: relaxing = CSRF door |
| N-26 | CSP extensions, frame-ancestors / third-party framing | SEC-TGT-043 | `CSPAllow`, `AllowThirdPartyFraming`, `CaptchaCsp` | ENV-only | n/a | W1: admin-added script-src or frame-ancestors persists XSS/clickjacking |
| N-27 | Cookie scheme behaviour (Secure follows public scheme, SameSite Lax/Strict, `__Host-`) | SEC-TGT-040, 135 | `CookieSameSite`, `isHttps()` | Fixed behaviour, derived from N-03/N-06; SameSite choice (Lax/Strict only) ENV | n/a | W9: `Secure` from headers would be spoofable; derived from public scheme instead |
| N-28 | URL base path (sub-path deployment) | SEC-TGT-135 | `PmaAbsoluteUri` path, `PMA_PATH_TO_BASEDIR` | ENV-only; scope undecided | n/a | W3/W4: baked into asset URLs and cookie path; depends on stack (build-time vs runtime) |
| N-29 | Response header constants (`X-Robots-Tag`, no-store, nosniff, Referrer-Policy) | SEC-TGT-137, 043 | `Header.php` | Fixed in code, no setting | n/a | W1: nothing to gain from making them configurable |
| N-30 | First-run setup network rule: loopback only, remote override, one-time token | DEP-TGT-100, 123 | none | ENV-only | n/a | W3: exists before any store, W1: must vanish after setup (404) |
| N-31 | Exposure warnings: acknowledge / silence | SEC-TGT-125, FR-TGT-146 | `ServerConfigChecks` notices | Warnings themselves computed, not settable. Acknowledgement text: UI, logged | n/a | W9: silencing must not be possible by an attacker; a per-warning acknowledgement is audited and re-shown after restart |
| N-32 | Outbound proxy and version check (adjacent to this domain) | none | `ProxyUrl`, `ProxyUser`, `ProxyPass`, `VersionCheck` | ENV-only (ProxyPass is a secret) | n/a | W6; W1: attacker redirecting outbound traffic. Out of scope of 11 so far, flagged |
| N-33 | Meta settings: auto-revert period, step-up window | SEC-TGT-143, 144 | none | ENV value with UI read-only (proposal), or UI within ENV bounds (alternative, see Q6) | ENV | W1: attacker sets revert period to 1 s or step-up window to 1 day |
| N-34 | Multi-instance coordination (shared store URL, instance IDs, shared limiter) | SEC-TGT-131 (scope documented) | none | ENV-only; UI settings propagate through the shared store | n/a | W5. Depends on OPEN 12 (store type) and the single-vs-multi decision |

Count: ENV-only 24 (N-01 to N-10, N-13, N-14, N-16, N-18 to N-26, N-28, N-30, N-32, N-34 and the ENV part of N-27); UI within ENV bounds 5 (N-11, N-12, N-15 partly, N-17, and N-33 if alternative); fixed/not a setting 2 (N-29, N-31 warnings).

---

## 2. Proposed bounds for the UI-within-bounds settings (all PROPOSED)

### N-11 / N-12 / N-13 network lists
- ENV keys (names illustrative): `NET_PERMANENT_DENY` (default: empty), `NET_OUTER_ALLOW` (outer ceiling), `NET_ADMIN_NETWORKS` (default loopback, from SEC-TGT-147).
- PROPOSED default of `NET_OUTER_ALLOW`: loopback plus RFC 1918 and ULA ranges. Rationale: consistent with SEC-TGT-124/030 "private by default"; internet exposure then needs a visible, deliberate `0.0.0.0/0, ::/0` in ENV, which also feeds the SEC-TGT-125 warning. Alternative: no ceiling by default (more convenient, weaker). Decision for owner (Q1).
- UI allow list: empty means "everything the ceiling allows". Non-empty must be a subset of the ceiling; the server rejects a rule that is not covered by the ceiling.
- Max rules in UI: 256 each (PROPOSED) to bound matcher cost and audit size. Max prefix breadth in UI: not wider than the ceiling (automatic).
- Evaluation model: one model, "ENV deny, ENV ceiling, UI allow (if non-empty), UI deny, default deny" (supports D3).
- Admin plane = N-14 AND the normal global policy; both must pass.
- Auto-revert (SEC-TGT-144): PROPOSED default 300 s, ENV minimum 60 s, ENV maximum 900 s. Rationale: long enough to reconnect from the new address or fix a mistake, short enough that a typo is not an outage. State must live in the store with a due timestamp so it survives restart and works across instances (W5). The revert target is the last confirmed configuration.

### N-17 login rate limits
| Value | PROPOSED default | UI range | ENV floor (strictest allowed) / ceiling (loosest allowed) |
|---|---|---|---|
| Failures per account before backoff | 5 | 3 to 10 | floor 3, ceiling 10 |
| Failures per effective client IP in 15 min | 20 | 10 to 100 | floor 10, ceiling 100 |
| Backoff start / factor / cap | 1 s / x2 / 15 min | start 1 to 10 s, cap 5 to 60 min | cap ceiling 60 min so an attacker cannot lock accounts for days |
| Counter window | 15 min | 5 to 60 min | same |
Rationale: both directions are dangerous. Too loose helps brute force, too tight lets an attacker lock every account with a script. Hence floor AND ceiling, and ENV decides them. The admin account keeps a separate, always-applied floor (never below 5 failures) so lockout of the only administrator by a typo remains impossible to configure (see W2).

### N-33 meta settings
- Auto-revert and step-up window as ENV only: `STEPUP_WINDOW` PROPOSED 5 min (ENV allowed 0 to 15 min, 0 means every change). If the owner prefers UI control, bound the UI to 0..ENV max. My recommendation: ENV only, because it is touched about never, and it protects the protection (D4).

### N-15 per-role / per-user
- If per-user address rules are accepted: PROPOSED up to 16 CIDRs per user, subset of the ceiling and of the global allow list (a user rule can only narrow). Depends on undecided scope (Q4).

### N-20 import upload size (boundary with another domain)
- The HTTP body cap (ENV) is the ceiling. PROPOSED defaults: general request body 1 MiB, import upload ceiling 64 MiB; a UI value for import size, if any, lies between 1 MiB and the ENV cap. Owned by the import/export reviewer; only the HTTP-level cap is mine.

---

## 3. What-if matrix

W1 admin session held by attacker. W2 admin mistypes; lockout; UI recovery. W3 needed before store/login. W4 restart or listener. W5 multiple instances. W6 secret. W7 direct mode. W8 non-technical admin changes often. W9 wrong value exposes publicly; warning. Cells are terse outcomes.

| ID | W1 attacker admin | W2 mistype / recovery | W3 before store | W4 restart/listener | W5 multi-instance | W6 secret | W7 direct mode | W8 frequent change | W9 public exposure + warning |
|---|---|---|---|---|---|---|---|---|---|
| N-01 | If UI could set it: rebinds to 0.0.0.0, immediate exposure. So not in UI | Wrong bind = unreachable; fix by file edit, UI cannot help (it is unreachable) | Needed to open socket | Restart required | Each instance own bind; may differ legitimately | no | ENV | rarely | Non-loopback bind without TLS/proxy/origin: refuse start (SEC-TGT-124). Non-loopback with all checks: warn per SEC-TGT-125 |
| N-02 | Same as N-01 | Port clash: start fails, clear error | yes | restart | may differ per host | no | ENV | rarely | exposure report lists ports |
| N-03 | Switch to plain = downgrade; so ENV | Wrong mode behind proxy: redirect loops or HTTP; fix by file edit | yes | restart | must agree per topology (all behind proxy or all own TLS) else cookie Secure and redirects differ | no | ENV | rarely | "TLS none" on non-loopback: refuse start. "Proxy" with empty trusted-proxy list: refuse start |
| N-04 | Downgrade to 1.2 weak ciphers aids MITM: ENV | Too strict: old clients cannot connect; fix by file edit | yes | restart | should agree; scanner test per instance | no | ENV | rarely | warn if below profile, refuse if below TLS 1.2 |
| N-05 | Key replacement = impersonation. ENV | Wrong path/expired cert: TLS fails, whole service down; startup check and expiry warning 30 days before | yes | restart or reload signal (proposed, verify in stack) | each instance needs cert; shared secret store recommended | Yes: private key never in store, UI, logs, audit | ENV | cert renewal ~ every 60-90 days: automate (reload), not a UI task | expiry warning in exposure report |
| N-06 | Attacker poisons invite/recovery links and RP ID | Wrong origin: links wrong, WebAuthn fails, login via Host check fails; admin unreachable if host check enforced, fix by file edit | yes (builds redirects, cookie decision) | restart | must be identical across instances (RP ID and cookie) | no | ENV (RP ID uses it too) | rarely | Origin with http:// on non-loopback: refuse start |
| N-07 | Adds attacker host: enables Host header attacks | Typo: 421 for everyone including admin; fix by file edit; loopback exempt for CLI health check only | yes (before routing) | restart | should agree | no | ENV | adding a hostname occasionally; use ENV | wildcard: warning (SEC-TGT-125). Recommend refusing wildcard on non-loopback (Q) |
| N-08 | Widen to 0.0.0.0/0 = spoof any client IP, bypasses allow-list, rate limit and setup rule | Too narrow: all clients appear as proxy IP, rate limit locks everyone together (W9 of N-17); wrong too wide: spoof. Neither fixable from UI safely | yes | restart | must agree; proxies in front may differ | no | ENV | when infrastructure changes | warn if trusted range wider than /16 or includes public ranges; warn if XFF seen from untrusted peer (indicates misconfig) |
| N-09 | trivial | none | yes | restart | agree | no | ENV | no | redirect uses configured origin only |
| N-10 | Raising max-age or preload harms operability, lowering weakens | Sticky in browsers: UI recovery impossible, so ENV with docs and short first-rollout default | no | restart | agree | no | ENV | no | warn if HSTS disabled on public TLS |
| N-11 | Narrow only up to fence. Worst case self-DoS; widest case = ceiling. Step-up still required | Excludes self: confirmation + auto-revert + CLI reset (SEC-TGT-144). Revert needs no step-up | R2: before store use ENV rules only; store read errors fall back to ENV rules, not to "allow all" | applies live (no restart) via store; fence needs restart | store-backed with version stamp; instances re-read within seconds, document max propagation delay (PROPOSED 5 s) | no | ENV only (no UI) | yes, admins add office IPs often: needs good UX and range check | empty UI list + broad ceiling = warn "no IP allow-list" (SEC-TGT-125) |
| N-12 | Attacker denies legit users/admins: DoS; revert + audit | Same as N-11 | as N-11 | live | as N-11 | no | ENV | occasional (block abusive IP) | n/a |
| N-13 | If reachable: voids the fence. ENV only | Typo in ceiling excludes all: fix by file edit; startup check refuses config whose ceiling excludes the admin networks | yes | restart | must agree (union would silently widen) | no | ENV (only list in direct mode) | no | ceiling containing public ranges: warn |
| N-14 | Attacker adds own range: admin plane exposed. ENV only | Typo: no admin reachable; fix by file edit or CLI on host. Startup check refuses empty admin networks in account mode | yes | restart | must agree | no | n/a (no admin plane) | rarely; VPN range change is a deploy event | non-loopback admin range wider than /16: warn |
| N-15 | Narrowing only; admin-role rule = N-14 | A per-user mistake locks one user; admin can fix from UI | store needed; before store only ENV rules | live | store-backed | no | n/a | yes | n/a |
| N-16 | Disable/swap CA = gate removed. ENV | Wrong CA: nobody connects; file edit | yes | restart | agree; CA bundle shared | CA public, but identity header trust relies on N-08 | ENV | cert rollout: CA rarely changes | warn if identity header trusted without mTLS-capable proxy |
| N-17 | Loosen within ENV floor/ceiling only; step-up; audit old/new | Too tight: attacker can lock all; protected by ENV ceiling on backoff cap and the admin floor. Admin locked out: CLI `unlock` plus lockout expiry bounded by cap | defaults used from ENV bounds until store open | live | needs shared limiter (N-18), else limits multiply by instance count; counters must also be shared or documented | no | ENV (fixed per deployment) | rarely after tuning | n/a, but behind-proxy IP error shows as shared lockout (see N-08) |
| N-18 | Disabling would be the first attacker step. ENV and not offered | Wrong store scope: limits ineffective across instances | yes | restart | must match instance count: memory only allowed with 1 instance (startup check where detectable) | no | ENV | no | "limiter off" refuses start on non-loopback |
| N-19 | Raise = DoS exposure; ENV | Too low: normal users throttled, admin too if not exempt; admin networks exempt from the general (not login) limit | yes | restart | per instance limits; document that global limit = sum | no | ENV | rarely | warn if disabled |
| N-20 | Raise = memory DoS; ENV | Too low: imports fail with clear error; too high bounded by memory check at startup | yes | restart | agree | no | ENV | rarely | n/a |
| N-21 | Raise = slow-loris; ENV | Too low: long exports/imports cut; should be exempt per route class (streaming) | yes | restart | agree | no | ENV | rarely | n/a |
| N-22 | Enabling a public endpoint leaks little; still ENV | Wrong path: orchestrator marks instance dead, restarts loop; ENV | yes: needed before store, probes run at boot | restart | each instance exposes own | no | ENV | no | body fixed minimal; subject to network rules unless on separate loopback port (Q7) |
| N-23 | Enable metrics/version: info leak | Not applicable | no | restart | per instance | metrics may reveal hostnames: no secrets | ENV | rarely | default off; if enabled on non-loopback require admin session |
| N-24 | Added origin = credentialed cross-origin access. ENV | Missing origin: external widget fails, harmless | no | restart | agree | no | ENV | no | wildcard / null / reflect: refuse |
| N-25 | Relaxation = CSRF risk; not configurable | n/a | no | restart | n/a | no | fixed | no | n/a |
| N-26 | Attacker adds script source: persistent XSS channel. ENV | Bad CSP breaks UI: fix by file edit; report-only mode (PROPOSED) for rollout | yes | restart | agree | no | ENV | rarely | frame-ancestors * warns |
| N-27 | Header-derived Secure flag spoofable: derive from N-03/N-06 only | Wrong scheme: cookie not sent, login loops; fix N-06 | yes | restart | must agree (else sessions not shared) | session secret is separate (not my domain) | same | no | Secure off on non-loopback: refuse |
| N-28 | n/a | Wrong base path: assets 404; fix file | yes | restart / rebuild | agree | no | ENV | no | n/a. Depends on stack and on `__Host-` conflict (D6) |
| N-30 | Setup route must not be reachable by admin session at all; after setup 404 | Token lost: regenerate via CLI | The setup rule is the chicken-and-egg case: ENV only | restart | only one instance may run setup (store lock) | one-time token is a secret: shown once, hashed | n/a (no accounts; initial config is ENV) | no | non-loopback setup needs token + override + warning |
| N-31 | Attacker silencing warnings hides exposure: acknowledgements are audited and non-permanent | n/a | exposure report works from ENV alone | restart refreshes | computed per instance, shown aggregated | none | warnings printed in log/CLI only | admin acknowledges occasionally | this is the warning mechanism itself |
| N-32 | Redirects outbound traffic through attacker proxy | Wrong proxy: version check fails only | yes | restart | agree | ProxyPass secret | ENV | no | n/a |
| N-33 | Attacker sets revert to 1 s (defeats protection) or step-up window to long: therefore ENV or bounded | Too long window: weakens; too short: nuisance | ENV default available | live if UI | store-backed due timestamps | no | n/a | no | n/a |
| N-34 | n/a | Instances disagree on ENV: partial lockouts, mixed redirect; need startup consistency fingerprint in store (PROPOSED) | store must exist | restart | this is the W5 case | store credential is secret | single | no | warn on fingerprint mismatch |

---

## 4. Cross-cutting findings

1. Lockout classes. UI-recoverable: individual rate-limit values, UI allow/deny lists (auto-revert + CLI), a single user. Not UI-recoverable by design and therefore ENV: bind, ports, TLS, origin, hosts, trusted proxies, HSTS, admin networks, mTLS. In those cases a mistake makes the UI itself unreachable, so a UI editor could not recover and would only add attack surface. Recovery is: edit `.env`, restart.
2. Auto-revert applies to N-11/N-12 (and N-15). It should not extend to ENV settings. It needs persisted due time and cross-instance semantics, and must not itself require a step-up, otherwise a locked-out admin cannot revert.
3. Behind a proxy with wrong N-08, "per IP" rate limits and allow lists degrade to "one IP for everybody": either everyone is locked out by one attacker, or an allow-list for the proxy IP passes the world. Startup check: if mode is "proxy" and no trusted proxy is configured, refuse start (extends SEC-TGT-124); at runtime warn when the effective client address equals the TCP peer for every request over some period (PROPOSED heuristic).
4. Multi-instance: ENV settings must agree (fingerprint check). UI settings are store-backed and agree by construction, but propagation delay exists, limiter state needs a shared store, and the revert timer must be a store timestamp.
5. Secrets in this domain: TLS private key and passphrase, outbound ProxyPass, one-time setup token, mTLS identity header (not secret but trust-critical). None in the UI store.
6. Direct mode: no admin plane means no N-14, no N-31 UI, no auto-revert, no step-up; the same fence values are simply the policy. Direct mode on an exposed bind is already a SEC-TGT-125 warning; I propose also making it fail startup on a bind outside the outer ceiling unless an explicit acknowledgement variable is set (Q8).
7. Admin plane vs ordinary users (SEC-TGT-147/148): the check must be per route class and per role, evaluated on the effective client address after N-08. If N-08 is wrong, N-14 is bypassable; N-14 therefore depends on N-08 in the threat model.

---

## 5. Disagreements and gaps against the spec text of sections 13 and 14

D1. FR-TGT-141 lists "IP allow/deny list (SEC-TGT-128)" as an administrator UI setting while SEC-TGT-128 calls it "an optional global setting" and DEP-TGT-140 puts no ENV baseline for it. With the UI alone, a stolen admin session could add `0.0.0.0/0`. Section 14 has no mechanism for list-valued settings: SEC-TGT-142 speaks only of "floor and ceiling for each numeric or list-valued setting", which does not define what a bound on a list is. Proposal: R1 (ENV permanent deny, ENV outer allow ceiling, UI subset) and R2.

D2. SEC-TGT-129 requires the network middleware to run "before routing and authentication", but if the allow list lives in the store, the middleware cannot evaluate it before the store is open. The spec does not say what happens at startup, on store failure, or during setup. Proposal R2 (ENV-only fallback, never allow-all).

D3. SEC-TGT-128 leaves the evaluation model open (legacy orderings vs one model). With UI + ENV layers a fixed order is needed; proposed order in section 2. Legacy `AllowDeny['order']` (`'deny,allow'`, `'allow,deny'`, `'explicit'`) should not be carried over.

D4. SEC-TGT-143 and 144 contain parameters (step-up window, "a few minutes" revert) that are themselves security settings, but section 14 does not classify them. If UI-editable without bound, an attacker sets revert to seconds. Proposal: N-33 ENV (or ENV-bounded).

D5. SEC-TGT-144 requires warning when the change "would exclude the administrator's current address". Two gaps: it does not cover a change that excludes other users (only the acting admin is protected), and it does not say that the check must use the effective client address (SEC-TGT-127), otherwise behind a proxy the check evaluates the proxy's IP and passes wrongly. Also, "loosening" within the ceiling is not distinguished from "tightening"; it may deserve a different gate (Q5).

D6. SEC-TGT-135 asks to resolve sub-path deployment against `__Host-`. For my classification this means base path (N-28) is a possible ENV value that conflicts with SEC-TGT-040. Not decidable until the owner chooses sub-path support; note that `__Host-` needs path `/` and `Secure`, so a sub-path deployment must either drop the prefix (documented weaker option) or be unsupported. I recommend unsupported (Q3).

D7. SEC-TGT-131 requires rate limiting "always on" but FR-TGT-141 lists "rate-limit thresholds" as UI-editable without bounds in section 14 terms. Both directions need bounds (too loose and too tight), which "floor and ceiling" covers, but SEC-TGT-142's name "Tighten only" suggests only one direction. The title should say "within bounds".

D8. SEC-TGT-147 says admin networks "set in `.env`" and default loopback. A containerised or remote deployment with the admin on another host cannot reach the admin plane by default; the spec offers no path other than editing `.env`. Acceptable, but should be stated in DEP-TGT-120 per topology. Also SEC-TGT-148 and 147 overlap; 148 could be merged into 147.

D9. DEP-TGT-140 lists the ENV scope but omits: HSTS (N-10), mTLS (N-16), CORS (N-24), CSP extensions (N-26), health/diagnostics (N-22/23), body/header/time limits (N-20/21), limiter store (N-18), outbound proxy (N-32), cookie SameSite (N-27), the permanent deny list and ceiling (N-13). FR-TGT-141 says ENV settings are not editable in the UI; they should be listed so "stolen admin session" cannot reach them.

D10. SEC-TGT-125 warnings include "no IP allow-list". With R1, "no UI allow list" is no longer the same as "no allow-list": warnings should be computed on the effective policy (ceiling AND UI list).

D11. SEC-TGT-132 allows one unauthenticated liveness endpoint but does not say whether it needs to run on a separate port or bypass the allow-list (orchestrator probes come from the node itself or the cluster network). Depends on deployment shape (edge/serverless undecided).

D12. NFR-TGT-122 lists items "to be verified" that determine feasibility of several verdicts here: whether the stack can reload certificates without restart (N-05), whether framework adapters handle forwarded headers on their own (N-08), whether one middleware covers every route class (N-11). Verdicts marked "depends on stack" in section 1 are provisional until those are closed.

---

## 6. Open questions for the owner

Q1. Default of the outer allow ceiling: private ranges only (secure, needs explicit ENV for internet) or none (convenient, weaker)? (affects D1, SEC-TGT-124 consistency.)
Q2. Should the UI be allowed to add allow-list entries (loosen within the ceiling) at all, or only to remove/narrow? Allowing it is more convenient for non-technical admins; narrowing only is stricter.
Q3. Is sub-path deployment (N-28) supported? Recommendation: no; keeps `__Host-` intact.
Q4. Are per-user address rules in scope (N-15)? If not, drop; roles only.
Q5. Should loosening and tightening differ (for example loosening needs step-up plus a delay or a second confirmation, tightening only step-up)? Four-eyes is excluded, a delay is not.
Q6. Are step-up window and auto-revert period ENV-only (my recommendation) or UI within ENV bounds?
Q7. Is the liveness endpoint exempt from the allow list or placed on a separate loopback/internal port?
Q8. Direct mode on an exposed bind: warn only (current spec) or refuse start without an explicit acknowledgement variable?
Q9. Wildcard allowed hosts: warn (spec) or refuse on non-loopback binds?
Q10. Single instance only for the first release? That removes the shared limiter and revert-propagation questions (depends on OPEN 12 and the multi-instance decision listed in the research file).
Q11. Certificate reload without restart: required or acceptable to restart on renewal? Depends on the stack.
Q12. Final values for the proposals in section 2 (revert 300 s, step-up 5 min, rate-limit ranges) are the owner's call; I based them on common practice, not on a verified standard.

Marked as depending on undecided scope or stack: N-05 (reload), N-08 (runtime forwarded-header handling), N-11 (single middleware), N-22/23 (edge runtimes), N-28 (sub-path), N-34 and N-18 (single vs multi instance, store type), N-15 (per-user scope).
