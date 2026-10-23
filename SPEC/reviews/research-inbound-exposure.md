# Research: restricting inbound exposure of DBLoom

Status: research input for `11-target-security.md` section 13 (all requirements there are PROPOSED). Date of research: 2026-10-23. Written by a security requirements engineer; not approved by the owner.

Reading convention: **[V]** = verified by fetching the cited page in this session; **[S]** = only seen in a search-result summary; **[U]** = unverified, from general knowledge, must be checked before it becomes a firm requirement.

## 1. Summary

1. LegacyAdmin 5.2.3 has almost no inbound control of its own. It has an optional per-server IP allow/deny list (with a CIDR defect), an optional `TrustedProxies` map (exact IP, no CIDR), `SameSite=Strict` cookies, and a fixed set of response headers. It has **no** `ForceSSL` setting (absent from the whole tree, grep over `*.php`), **no HSTS**, **no Host-header validation**, **no CORS handling**, and it decides "is HTTPS" by trusting about ten request headers from any client. Everything else (TLS, bind address, rate limits, source restriction) is delegated to the web server in front of it.
2. DBLoom is a database credential broker and potential SSRF pivot (11-target-security.md "Threat context"). The first line of defence should be *not being reachable*: loopback bind by default, explicit opt-in to expose, mandatory TLS when exposed, and network restrictions applied before authentication on every route.
3. The proxy boundary is the main source of subtle bugs: client IP, scheme, host and origin all derive from headers that are attacker-controlled unless the immediate peer is a configured trusted proxy. Requirements therefore define one place that computes "effective client IP / scheme / host" and forbid reading forwarded headers anywhere else.
4. With TanStack Start (tentative), "API surface" includes server functions (generated RPC endpoints) and server routes. CSRF protection exists for server functions but, per one secondary source, not for plain server routes. The host runtime (Node via Nitro or another adapter) determines bind address, trusted-proxy handling and TLS support; these must be verified against the pinned versions before the requirements are frozen.

## 2. Legacy evidence (LegacyAdmin 5.2.3, code only)

Paths relative to `legacy-release\`.

| Topic | What legacy does | Evidence |
|---|---|---|
| ForceSSL | Does not exist in this version. `grep ForceSSL` over all `*.php` returns nothing. HTTPS is only *detected*, never required. | whole tree |
| HTTPS detection | `Config::isHttps()` returns true if any of: `PmaAbsoluteUri` scheme https, `HTTP_SCHEME`, `HTTPS=on`, `REQUEST_URI` starts `https:`, `HTTP_HTTPS_FROM_LB`, `HTTP_FRONT_END_HTTPS`, `HTTP_X_FORWARDED_PROTO`, `HTTP_CLOUDFRONT_FORWARDED_PROTO`, RFC 7239 `Forwarded`, or `SERVER_PORT==443`. None of these is conditioned on the peer being a trusted proxy, so a client can set `X-Forwarded-Proto: https` on a plain-HTTP connection. Consequence: the `Secure` cookie flag follows a client-influenced value. | `libraries/classes/Config.php:788-824` (headers at 799-818) |
| Cookie flags | `secure` = `isHttps()`, `httponly` per call, `samesite` = `CookieSameSite` (default `Strict`, only `Lax`/`None` accepted as override), path from `PmaAbsoluteUri` or request. Cookie names get `__Secure-` prefix and `_https` suffix when HTTPS. | `Config.php:955-979, 1009`; `config.default.php:793-802`; `Config/Settings.php:2267-2273`; `Session.php:142-179` |
| TrustedProxies | `$cfg['TrustedProxies']` default `[]`: map proxy IP (exact key, no CIDR) to header name. `Core::getIp()` returns `REMOTE_ADDR` unless it is a key; then takes the **first** element of the named header (leftmost, the spoofable one), validates it with `FILTER_VALIDATE_IP`, else returns false. Only the first `X-Forwarded-For` value is read; the value comes from `getenv` so multiple header lines are not combined. | `config.default.php:2842-2844`; `Core.php:806-840`; `Config/Validator.php:415-422` |
| AllowDeny | Per-server `order` (`''` = off, `allow,deny`, `deny,allow`, `explicit`) and `rules`. Evaluated in `checkRules()` only during authentication (called from the auth flow), not on every request, and not on static files or the setup script. Failure shows `allow-denied`. An unknown IP (`getIp()` false) matches no rule. | `config.default.php:545-554`; `Plugins/AuthenticationPlugin.php:272-309`; `Config/Settings/Server.php:1292-1305` |
| CIDR defect | IPv4 mask is built from bits 30..0 only (`for ($i < 31)`, `2 ** (30 - $i)`), so bit 31 is never compared: `10.0.0.0/8` matches `138.x.x.x`. Same defect affects the `localhost` shortcut (`127.0.0.1/8`, which would also match 255.x.x.x) and `localnetA/B/C` built from `SERVER_ADDR`. Spec id: **SEC-SAU-303** (not 3xx range wildcard; `05-security-auth.md:985-996`). Range form `[a-b]` compares octets as strings/loose numbers with no format validation. | `IpAllowDeny.php:67-107`, shortcuts `:265-272` |
| Response headers | `X-Frame-Options` DENY (or SAMEORIGIN by config), `Referrer-Policy: same-origin`, CSP (with `unsafe-inline` and `unsafe-eval` in script-src), obsolete `X-Content-Security-Policy`/`X-WebKit-CSP`, `X-XSS-Protection`, `X-Content-Type-Options: nosniff`, `X-Permitted-Cross-Domain-Policies: none`, `X-Robots-Tag: noindex, nofollow`, no-cache headers. **No `Strict-Transport-Security`.** | `Header.php:486-538, 574-629` |
| CORS | No `Access-Control-*` header anywhere in `*.php` (grep). Same-origin by omission. | grep |
| Host header | `HTTP_HOST` is used for the browser title template, export file names, and 2FA/WebAuthn relying-party host derivation; it is never validated against an allow-list. A missing `HTTP_HOST` only produces a warning on the home page. | `Util.php:1628,1653`; `Preferences/ManageController.php:80,91`; `Plugins/TwoFactorPlugin.php:165-169`; `Controllers/HomeController.php:403-410` |
| Setup | `setup/` is a separate PHP entry point that edits/generates `config.inc.php`; it has no network-source restriction in code (the grep found no IP or localhost check in `setup/`). Protection is by file-system layout (config directory must be created and made writable by the operator). | `setup/index.php`, `setup/config.php`, `setup/lib/common.inc.php` |
| Bind/TLS | Not applicable: PHP delegates to the web server. | n/a |

Observed weaknesses to carry forward as "do not repeat": (a) scheme detection from untrusted headers; (b) leftmost-XFF; (c) exact-IP trusted-proxy keys without CIDR; (d) allow/deny only at login; (e) CIDR bit-31 bug; (f) no HSTS; (g) no Host validation; (h) 2FA RP host taken from `HTTP_HOST` (relevant to SEC-TGT-011: RP ID must come from configuration).

## 3. External guidance (what current sources say)

### 3.1 TLS, HSTS, redirects
- OWASP Transport Layer Security Cheat Sheet **[V]**: default to TLS 1.3, TLS 1.2 may be supported for compatibility, TLS 1.0/1.1 must be disabled (RFC 8996), SSLv2/v3 always disabled. Public sites may listen on 80 and send a 301 to HTTPS, paired with HSTS; API-only endpoints should disable HTTP rather than redirect. RSA >= 2048, SHA-256, SAN lists the FQDN, avoid IP/internal names on external certificates, use CAA. mTLS: "consider for high-value applications or APIs, especially where users are technical or belong to the same organization"; rarely used publicly because of administrative overhead and interference from TLS-inspecting proxies. URL: https://cheatsheetseries.owasp.org/cheatsheets/Transport_Layer_Security_Cheat_Sheet.html
- OWASP HSTS Cheat Sheet **[V]**: example `max-age=63072000; includeSubDomains; preload`; start with a short max-age (example one day) and raise it; `preload` has "permanent consequences" and requires separate submission; HSTS makes certificate errors non-bypassable. URL: https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Strict_Transport_Security_Cheat_Sheet.html
- Mozilla Server Side TLS **[partly V]**: the wiki page now only points to the successor at docs.tlsref.org / tlsref.org (wiki page edited 2026-06-11); the profile contents (Modern = TLS 1.3 only, Intermediate = TLS 1.2+) could **not** be fetched in this session (`tlsref.org/server-side-tls.html` returned 404). The "Modern = 1.3 only, Intermediate = 1.2+" statement is from prior knowledge **[U]**. URLs: https://wiki.mozilla.org/Security/Server_Side_TLS , https://docs.tlsref.org/
- NIST SP 800-52 Rev. 2 **[S]**: servers must support TLS 1.2 and should support TLS 1.3; the 2024-01-01 TLS 1.3 date is worded as "shall" in one secondary source and as a recommendation on NIST's page; the PDF was not read. URL: https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-52r2.pdf
- Consequence for DBLoom: minimum TLS 1.2, prefer 1.3, no weaker; whether to require 1.3-only is an owner decision (section 7).

### 3.2 Forwarded headers and client IP
- MDN `X-Forwarded-For` **[V]**: security uses (rate limiting, IP access control) "must only use IP addresses added by a trusted proxy"; if the server is directly reachable from the internet, no part of the list is trustworthy; read from the right, skip trusted hops (by count or by trusted list); treat multiple `X-Forwarded-For` header lines as one ordered list; leftmost values are untrusted. URL: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Forwarded-For
- h3/Nitro **[S]**: a 2023 h3 issue says Nitro cannot know whether the connecting IP is trustworthy and that spoofing is easy without a trusted-proxy notion; whether current h3/Nitro versions have a trusted-proxy option was **not verified**. URL: https://github.com/unjs/h3/issues/504

### 3.3 Host header, origin, CSRF behind proxies
- OWASP CSRF Prevention Cheat Sheet **[V]**: verify `Origin`, else `Referer`, by exact origin match; do not allow-list `null`; `Sec-Fetch-Site` cross-site non-safe methods rejected, with Origin/Referer as fallback; behind proxies prefer the application's *configured* target origin; `X-Forwarded-Host` only from trusted proxies that overwrite it, validated on every ingress path including direct access; SameSite is defence in depth, `Lax` leaves state-changing GET exposed; custom-header approach relies on CORS preflight, so CORS must not be loosened. URL: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- Host header injection **[S]**: OWASP WSTG test 4.7.17 lists redirect/cache-poisoning/reset-link risks; allow-list validation of Host is the usual mitigation (vendor docs). No dedicated OWASP cheat sheet found. URLs: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/17-Testing_for_Host_Header_Injection , https://portswigger.net/web-security/host-header/exploiting

### 3.4 ASVS
- ASVS 5.0.0 exists **[S]**; chapter numbering differs from 4.0 (4.0: V11 HTTP security incl. trusted-proxy header verification; 5.0 moved browser items to "Web Frontend Security"). The exact 5.0 requirement IDs for TLS, headers and proxy handling were **not verified**; the repository's baseline (SEC-TGT-001) says "Level 2" without naming a version, so the owner must pin the version (section 7). Sources: https://scotthelme.co.uk/owasp-asvs-5-0-0-is-here/ , https://owasp.org/www-project-application-security-verification-standard/

### 3.5 TanStack Start (tentative stack)
- Official docs **[V]** (https://tanstack.com/start/latest/docs/framework/react/guide/server-functions): server functions are "same-origin RPC endpoints for your application", not public APIs; client calls become `fetch`; each function has a generated ID (SHA-256-based by default; URL format not stated); `createServerFn()` defaults to **GET**, POST by option; `createCsrfMiddleware()` protects server functions: checks `Sec-Fetch-Site`/`Origin`/`Referer`, rejects requests with none of them, origin defaults to the incoming request URL origin (configurable with `origin`), `allowRequestsWithoutOriginCheck` opt-out; auto-installed only if no `src/start.ts` exists; otherwise must be added to `requestMiddleware` filtered to server functions. Auth must be inside the server function (`beforeLoad` is UX only). Do not cache identity-dependent responses publicly.
- Server routes (plain HTTP endpoints) are **not** covered by the server-function CSRF middleware, per a third-party guide **[S]** (https://makerkit.dev/docs/tanstack-supabase/data-fetching/csrf-protection); to be verified against the pinned version.
- Implication: the default origin check uses the *incoming request URL origin*. Behind a proxy that rewrites Host or terminates TLS, that origin is the internal one (e.g. `http://127.0.0.1:3000`) and legitimate browser requests may fail, which pushes operators to `allowRequestsWithoutOriginCheck: true`. DBLoom should instead set the `origin` option from a configured public origin (consistent with the OWASP advice above).
- Not verified: default bind address of the Node/Nitro server output, how `HOST`/`PORT` are set, whether TLS can be terminated by the app server, trusted-proxy support in the runtime, how `request.url` is derived behind a proxy, whether response headers (HSTS, CSP nonces) can be set centrally for SSR and server routes. Each is a "must verify" item in the requirements' Verification lines.

## 4. Topic analysis, options and trade-offs

### 4.1 TLS for DBLoom itself
Options: (A) DBLoom terminates TLS (certificate/key configured, optional ACME); (B) DBLoom speaks plain HTTP on loopback/private link and a reverse proxy terminates TLS; (C) both supported. Trade-off: A is simplest and keeps secure cookies and HSTS under DBLoom's control but adds certificate management and Node TLS tuning; B is the common production pattern but makes "is this request secure" a proxy-trust question (section 4.3). Recommendation direction: support C, require that DBLoom *knows* which mode it is in (explicit `publicOrigin` with `https://`), and refuse non-loopback plain-HTTP operation unless a trusted proxy is declared. Plain HTTP on loopback only (developer/SSH-tunnel use) is acceptable because browsers treat `http://localhost` as a secure context, but `Secure` cookies and `__Host-` prefix behaviour on `http://localhost` must be verified per browser **[U]**.

### 4.2 Bind address and exposure defaults
Default `127.0.0.1` (and `::1`), port configurable. Non-loopback bind requires an explicit setting plus a configured public origin and allowed hosts; otherwise refuse to start. In containers the process must bind `0.0.0.0` inside the container; the guidance must then say to publish the port on loopback (`127.0.0.1:port:port`) unless intentionally exposed. A startup report lists effective exposure and warnings. Trade-off: a stricter default hurts first-run convenience for users who expect to open it from another machine; mitigated by a clear error naming the setting.

### 4.3 Trusted proxies and forwarded headers
Design: forwarded headers are ignored unless the TCP peer is in `trustedProxies` (CIDR list, IPv4+IPv6; optionally also "hop count" for platforms where proxy IPs are not stable). Client IP = rightmost non-trusted entry of all combined `X-Forwarded-For` (or RFC 7239 `Forwarded`) values. Scheme and host come from *configuration* (`publicOrigin`), and forwarded `Proto`/`Host` are accepted only from trusted peers and must agree with the configuration, otherwise the request is rejected. One header family only (configurable), not the legacy list of ten. Operators must make the proxy overwrite (not append to) inbound `X-Forwarded-*` from the internet, and the app port must not be reachable except through the proxy (MDN and OWASP both state this). Trade-off: strictness breaks setups with chained CDNs unless the CIDR list is complete; the startup report and a `doctor` check mitigate that.

### 4.4 IP allow/deny lists and CIDR
- Use a maintained IP/CIDR library or the runtime's `net.BlockList` **[U: confirm availability and IPv6/mapped-address behaviour in the pinned Node version]** instead of hand-written bit math. Normalise IPv4-mapped IPv6 (`::ffff:a.b.c.d`) before matching.
- Validate every rule at startup; an unparsable rule is a startup error (legacy silently mis-matches the range form).
- Legacy decision SEC-SAU-303: either preserve or fix; target recommendation is **fix** (no one benefits from `10.0.0.0/8` matching `138.x`); a regression test uses the legacy vector `ipv4MaskTest('10.0.0.0/8','138.1.2.3')`, which must now be false, plus prefix lengths /0, /1, /8, /31, /32 and IPv6 /0, /64, /128.
- Simplify the evaluation model: legacy has three orderings plus per-user rules (`allow|deny <user|%> from <addr>`). Option 1: single "allow-list, then deny exceptions" (like `explicit`). Option 2: keep Apache-style orderings for migrators. Per-user IP rules belong to account mode (SEC-TGT-061 roles) and are an owner decision. When the client IP cannot be determined, deny.
- Apply at the earliest point (before TLS-terminated routing, static assets, server functions, setup, health), not only at login as legacy does.
- Honest limitation: IP lists are weak against NAT, shared egress and spoofed XFF; they reduce noise and exposure, they do not replace authentication.

### 4.5 Host-header validation
Configure `allowedHosts` (exact names, optional ports; wildcards only as explicit `*.example.com` and discouraged). Reject others with 421 or 400 and do not echo the Host value. Build every absolute URL, WebAuthn RP ID/origin, invite link and redirect from `publicOrigin`, never from the request (legacy derived the RP host from `HTTP_HOST`, `TwoFactorPlugin.php:165-169`). Loopback names (`localhost`, `127.0.0.1`, `[::1]`) are allowed only when bound to loopback.

### 4.6 Mutual TLS (optional)
Useful for technical, same-organisation user bases (OWASP TLS sheet). Two forms: DBLoom terminates TLS and verifies client certificates itself against a configured CA; or the proxy verifies and passes certificate identity in a header that DBLoom accepts only from trusted proxies. mTLS is a network-level gate in front of, not instead of, DBLoom authentication, unless the owner later decides to map certificate subjects to accounts (not proposed here). Trade-off: certificate issuance/revocation burden, break with TLS-inspecting middleboxes.

### 4.7 Rate limiting: edge vs application
Edge (proxy/WAF/CDN) limiting protects availability and handles floods before Node sees them; it cannot know accounts and sees only IPs. Application limiting (SEC-TGT-017, per account and per source address with backoff) is the correctness control for credential guessing and cannot be delegated, since DBLoom may run without any proxy. Requirement shape: application limits are always on; they key on the *effective* client IP from 4.3 (otherwise all users share the proxy IP, or an attacker rotates a spoofed XFF); account-keyed limits are independent of IP; edge limits are recommended in deployment guidance, never assumed. Limit storage must survive restarts or be documented as in-memory per instance **[decision: single vs multi instance]**. Also bound request body size and concurrent connections in DBLoom as a backstop.

### 4.8 VPN, bastion, SSH tunnel
These are the strongest practical controls for an admin tool: DBLoom stays on loopback or a private interface; users reach it via VPN, bastion or `ssh -L`. With an SSH tunnel the browser sees `http://localhost:port`: HSTS and `Secure` cookies are moot, and the loopback exception of 4.1 matters. Deployment guidance should rank topologies: (1) loopback + SSH tunnel/VPN, (2) private network behind TLS proxy with IP allow-list, (3) public internet behind TLS proxy with mTLS or an identity-aware proxy plus DBLoom 2FA enforced (SEC-TGT-014), (4) public direct TLS (discouraged). Whether DBLoom should refuse or merely warn on (3)/(4) without enforced 2FA is an owner decision.

### 4.9 Setup / first run
DEP-TGT-100 already proposes a one-time setup token. Add: first-run setup is served only to loopback peers (effective client IP, evaluated with trusted-proxy logic, so a proxy on the same host must not make every request look like loopback: setup is refused if the request carries any forwarded header or arrives via a trusted proxy, unless an explicit override and the token are both given). After setup, the setup routes return 404. Trade-off: container/remote-server first run needs the override or a tunnel. Legacy contrast: `setup/` had no source check (section 2).

### 4.10 Health and diagnostics
Provide liveness (`/healthz`: fixed small response, no version, no dependency detail, no auth, rate-limited) and keep readiness detail, metrics, version info, config dumps and debug pages behind authentication with an administrator role or loopback-only. Disable debug routes in production builds. Responses carry `Cache-Control: no-store`. Legacy has no health endpoint; it leaks version via asset paths and the footer **[U, not checked in this task]**.

### 4.11 CORS
Default: none. No `Access-Control-Allow-Origin` emitted, matching legacy (grep). If a separate-origin front end is ever needed, exact-origin allow-list, never `*` with credentials, never reflect `Origin`, never allow `null`. This also protects the custom-header CSRF approach (OWASP CSRF sheet).

### 4.12 Cookies and sessions behind proxies
- `Secure` must follow the configured public scheme, not request headers (legacy `Config.php:788-824` is the anti-pattern).
- SEC-TGT-040 asks for the `__Host-` prefix. That prefix requires `Secure`, `Path=/` and no `Domain` **[U: browser rule from the cookie-prefix specification; verify]**. It is therefore incompatible with serving DBLoom under a sub-path (e.g. `https://host/dbloom/`) if the cookie path is restricted, and with plain-HTTP loopback use. Needs an owner decision: require root-path deployment, or relax to `__Secure-` with explicit path.
- Server-side sessions: if sessions are in process memory, multiple instances behind a load balancer need sticky routing or a shared store (legacy had the same issue for 2FA session fallback; `05-security-auth.md` gap 5). Keep this in the deployment guidance.
- Session binding to client IP is not recommended (mobile networks, proxies); optionally log IP changes.
- No identity-dependent response may be cached by shared caches (TanStack docs: `private`/`no-store`).

### 4.13 TanStack/TypeScript-specific effects
- Every server function and server route is an HTTP endpoint reachable by anyone who can reach the port; there is no "internal" function. Authentication and authorisation must live inside each handler or a mandatory middleware (SEC-TGT-060) and network restrictions must be global middleware, not per route.
- Server functions default to GET; state-changing ones must be POST so CSRF and SameSite=Lax logic hold (SEC-TGT-042). GET functions are cacheable and loggable (URL contains data): do not put credentials or SQL in GET server functions.
- Keep the CSRF middleware enabled when a custom `src/start.ts` exists, set `origin` from configuration, never enable `allowRequestsWithoutOriginCheck` in production; add an explicit equivalent check to server routes.
- SSR renders on the server: data from target databases is rendered into HTML/JSON (SEC-TGT-112 applies); SSR also means the Node process builds absolute URLs, which must come from `publicOrigin`.
- Hosting: a Node server needs explicit host/port and a trusted-proxy implementation in DBLoom's own middleware (do not assume the runtime provides it). Edge/serverless runtimes would conflict with long-lived DB connections, local file stores and in-memory sessions; deployment on edge runtimes should be declared unsupported unless the owner decides otherwise **[U]**.
- Supply chain: framework is young and fast-moving; pin versions and re-verify the points marked unverified above at pin time (links to DEP-TGT-091).

## 5. Gaps in the research (not verified)
- Mozilla/tlsref profile contents; NIST SP 800-52r2 text; ASVS 5.0 requirement numbers.
- Node/Nitro/h3 defaults (bind address, trusted proxy support, `request.url` behind proxy), `net.BlockList` semantics, TanStack Start server route CSRF coverage, response-header middleware for SSR.
- `__Host-` prefix rules and behaviour on `http://localhost` in browsers.
- Whether legacy leaks version/health information (not examined).

## 6. Proposed requirement set
See `11-target-security.md` section 13 (SEC-TGT-120..137, DEP-TGT-120..123, NFR-TGT-120..122). All PROPOSED.

## 7. Open decisions for the owner (not decided here)
1. Minimum TLS: 1.2+ (compatibility) or 1.3 only.
2. Does DBLoom terminate TLS itself, rely on a reverse proxy, or support both (this report proposes both)?
3. Must DBLoom *refuse to start* or only warn when exposed (non-loopback) without TLS, without enforced 2FA, or without allowed hosts?
4. HSTS defaults: max-age value, includeSubDomains, and whether `preload` is ever offered.
5. Default bind: loopback only (proposed) versus 0.0.0.0 in container images.
6. Fix or preserve the legacy CIDR behaviour (SEC-SAU-303), and keep or simplify the allow/deny ordering model and per-user rules.
7. Trusted proxy model: CIDR list only, hop count, or both; which forwarded header families are supported.
8. mTLS: in scope for the first release? DBLoom-terminated, proxy-verified, or both? Mapping certificates to accounts?
9. `__Host-` cookie prefix versus sub-path deployment (root path required?).
10. Single versus multiple instances (affects rate-limit storage and session store).
11. Edge-runtime hosting: declared unsupported or investigated?
12. ASVS version to pin (4.0.3 or 5.0.x) for SEC-TGT-001.
13. Health endpoint: liveness only or also authenticated readiness detail; metrics endpoint in scope?
14. Direct-mode (SEC-TGT-018) exposure: should direct mode be refused on non-loopback binds unless an IP allow-list or proxy-level authentication is configured?
15. Setup-from-localhost rule: strict (no override) or with token plus explicit override for remote/container first run.
