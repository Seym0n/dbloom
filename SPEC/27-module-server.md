# 27 — Module spec: `server` (deployment, listener, edge policy, lifecycle)

**Status: APPROVED by the owner (2026-11-02, "Agree": all recommendations of section 11 taken as decided, open to change).** Plan: `tasks/plan-server.md`; tasks: `tasks/todo-server.md`. Written with the spec-driven-development skill, in the format of files 22 to 26. Module id `server`; depends on `skeleton` and `auth-account` (public origin, setup state, session store); `hardening` (next module) builds on it. Requirements marked PROPOSED are new (`FR-SVR-nnn`, subsystem SVR, to be added to the README table on acceptance). Existing target requirements (`SEC-TGT-120` to `137`, `DEP-TGT-120` to `126`, `DEP-TGT-140`, `DEP-TGT-150`, `NFR-TGT-120` to `122`) are not reopened; this module turns them into code, tests and a deployment guide. Vendor and framework facts not yet checked are marked *verify*.

## 0. Assumptions (correct me now)
1. Reference deployment is the one decided in DEP-TGT-124: Docker image, Compose, Coolify proxy terminates TLS, one replica, plain Node output of Nitro. Other ways to run are not tested.
2. DBLoom does **not** terminate TLS itself in this module (SEC-TGT-120 option "behind a declared TLS proxy"). Own-TLS (SEC-TGT-121, mTLS SEC-TGT-130) is DEFERRED; the config keys are reserved only.
3. Account mode and direct mode both exist (SPEC/26). This module treats them alike except where a requirement says otherwise.
4. What already exists in `src/` (checked 2026-11-02): `Dockerfile` (two stages, Node 24 slim, user `node`, `/data` volume, healthcheck on `/api/health`), `compose.yaml` (one service, one volume, `.env` optional, publishes `3000:3000`), `.github/workflows/ci.yml` (lint, typecheck, vitest, Playwright, `docker build` only), `src/server/config.ts` (`DBLOOM_TRUST_PROXY` as a boolean, no CIDR), `src/server/middleware.ts` (per-function `Sec-Fetch-Site` check, `no-store`), `startup-plugin.ts` (exit 1 on bad config in production), `/api/health` returns `{ok:true}` without any check, `DBLOOM_PUBLIC_ORIGIN` read by the auth settings only.
5. Gaps this module closes: no `Host` check, no central forwarded-header module, no security headers (only `nosniff` on file responses), no graceful shutdown, health does not touch the store, no exposure report, compose runs no test, no `.env.example` validation, no proxy test, no bind-address rule.
6. No commit and no new dependency without a go. Possible dependency: a maintained CIDR matcher (Q3); `node:net` `BlockList` is already used by `host-policy.ts` and may be enough.

## 1. Objective
An operator deploys DBLoom from the repository on Coolify (or plain Compose) and gets a safe default: it starts only with a complete, valid configuration, answers only for its configured host names, trusts forwarded headers only from declared proxies, sends the security headers on every response, reports its health without leaking anything, shuts down cleanly on `SIGTERM` without losing a write, and tells the operator at startup what exposure it is running with. The same behaviour is proven by tests that run the built image, directly and behind a real reverse proxy.

## 2. Requirements and dispositions

Legend. **Where**: IN = this module; DEFER = later (reason); OTHER = named module.

### 2.1 Existing target requirements

| ID | Status | What it means here | Where |
|---|---|---|---|
| SEC-TGT-120 | PROPOSED | No credentials over plain HTTP from a non-loopback peer. Behind the proxy: refuse a login whose effective scheme is `http`. | IN (FR-SVR-004) |
| SEC-TGT-121 | PROPOSED | TLS profile of the listener. | DEFER (proxy terminates; the guide names the profile) |
| SEC-TGT-122 | PROPOSED | Port-80 redirect listener. | DEFER (Coolify proxy does it) |
| SEC-TGT-123 | PROPOSED | HSTS on every HTTPS response. | IN (FR-SVR-007) |
| SEC-TGT-124 | PROPOSED | Loopback default bind; non-loopback needs origin and proxy/TLS declaration. | IN (FR-SVR-002); container exception in Q2 |
| SEC-TGT-125 | PROPOSED | Persistent warning for risky exposure. | IN for the startup log and report (FR-SVR-011); admin-page banner is OTHER: admin |
| SEC-TGT-126 | PROPOSED | Public origin and allowed hosts; reject others with 421. | IN (FR-SVR-003) |
| SEC-TGT-127 | PROPOSED | Trusted-proxy list in CIDR, rightmost-untrusted rule, one module. | IN (FR-SVR-005) |
| SEC-TGT-128, 129 | PROPOSED | IP allow/deny lists as global middleware. | DEFER to `hardening` (this module provides the middleware slot and the effective client address, FR-SVR-005, 006) |
| SEC-TGT-131 | PROPOSED | Body, header and connection limits. | IN for limits (FR-SVR-009); rate limits stay in `auth-account` |
| SEC-TGT-132 | PROPOSED | Minimal unauthenticated liveness; detail only for admin or loopback. | IN (FR-SVR-010) |
| SEC-TGT-133 | PROPOSED | CORS off. | IN (FR-SVR-008) |
| SEC-TGT-134 | PROPOSED | Origin check on every state-changing request, server routes included. | IN (FR-SVR-006) |
| SEC-TGT-135 | PROPOSED | `Secure` cookie from configured scheme; no sub-path. | IN (FR-SVR-006) |
| SEC-TGT-136 | PROPOSED | Registry of endpoints with declared auth. | DEFER to `hardening` |
| SEC-TGT-137 | PROPOSED | `X-Robots-Tag`, no-store for authenticated pages. | IN (FR-SVR-007) |
| DEP-TGT-120, 121 | PROPOSED | Topologies and reference proxy config tested in CI. | IN (FR-SVR-015, 016) |
| DEP-TGT-122 | PROPOSED | Exposure report at startup and by command. | IN (FR-SVR-011) |
| DEP-TGT-123 | DECIDED | Setup reachable from any address, token protected. | OTHER: done in `auth-account`; this module only tests it through the proxy |
| DEP-TGT-124 | DECIDED | Docker, Compose, Coolify, non-root, health check, restart with volume. | IN (FR-SVR-012 to 014) |
| DEP-TGT-125 | DECIDED/PROPOSED | Stateful and stateless modes (`DBLOOM_STORE`). | IN for startup rules and tests (FR-SVR-001, 017) |
| DEP-TGT-126 | DECIDED | Pin `@tanstack/*`, audit in CI, lifecycle scripts off. | IN (FR-SVR-016) |
| DEP-TGT-140 | PROPOSED | Config through `.env` and environment; placeholders stop startup. | IN (FR-SVR-001) |
| DEP-TGT-150 | PROPOSED | Single instance; second instance on the same store detected. | IN (FR-SVR-013) |
| NFR-TGT-120, 121, 122 | PROPOSED | Proxy test suite, header diff per release, close the *verify* items. | IN (FR-SVR-015, 018) |

### 2.2 New requirements (PROPOSED)

| ID | Statement | Verification |
|---|---|---|
| FR-SVR-001 | **Config contract.** One typed, zod-validated config module reads environment (and `.env` through the process, real variables win). Every variable has a name, type, default, range and a line in `.env.example`; unknown `DBLOOM_*` names produce a startup warning (typo guard); a missing required value or a placeholder (`change-me`, empty secret) stops startup with one message naming the variable, never its value. | Table-driven test over all variables; `.env.example` and the schema are checked against each other. |
| FR-SVR-002 | **Bind.** `DBLOOM_HOST` (default `127.0.0.1`) and `PORT`. A non-loopback host requires `DBLOOM_PUBLIC_ORIGIN` and either `DBLOOM_TRUST_PROXY` set to a CIDR list or `DBLOOM_TLS=own` (reserved, refused today); otherwise exit 1 naming the missing key. | Start with `0.0.0.0` and each missing piece. |
| FR-SVR-003 | **Public origin and hosts.** `DBLOOM_PUBLIC_ORIGIN` (scheme, host, optional port; `https` required unless the origin host is loopback) and `DBLOOM_ALLOWED_HOSTS` (default: the origin host). A request with another `Host` gets 421 and an empty body, in a global middleware before routing. Wildcards refused on non-loopback bind. All absolute URLs (invite, recovery, WebAuthn RP) come from the origin, never from request headers; the auth module's existing origin read moves to this module. | Forged `Host`, `X-Forwarded-Host`, `Forwarded`; link in a response still uses the origin. |
| FR-SVR-004 | **Effective scheme.** Effective scheme = scheme of the public origin, confirmed (never overridden) by `X-Forwarded-Proto` from a trusted peer. If a trusted proxy says `http` while the origin is `https`, requests to login, setup and any function carrying a credential are refused. | Test through the reference proxy with the header forced to `http`. |
| FR-SVR-005 | **Client address.** One module `src/server/net/client-address.ts` computes the effective client address from the TCP peer and forwarded headers under SEC-TGT-127: trusted-proxy list in CIDR (IPv4, IPv6, v4-mapped normalised), rightmost untrusted entry, optional hop count, malformed becomes `unknown`. `DBLOOM_TRUST_PROXY=true` (today's boolean) is accepted for one release with a startup warning and means "peer is any private address" (Q4). Every existing `getRequestIP` call is replaced; a lint rule forbids reading forwarded headers elsewhere. | Spoofed XFF from untrusted peer, multiple header lines, chained proxies; grep test finds no other reader. |
| FR-SVR-006 | **Request gate.** A global Nitro middleware runs first: host check (003), scheme check (004), address computation (005), then the slot for allow/deny rules (`hardening`), then origin check for non-GET requests on server functions **and** server routes (`Origin` or `Sec-Fetch-Site` must match the origin; missing or `null` is refused; the opt-out is off). The per-function `sameOriginMiddleware` stays as a second layer. Cookie `Secure` follows the configured scheme. | Cross-site POST to every route class fails; same-origin through the proxy passes; route-inventory test lists the routes the gate covers. |
| FR-SVR-007 | **Response headers.** Set centrally on every response: `Strict-Transport-Security` (origin is `https`; `max-age` default 31536000, `includeSubDomains` by `DBLOOM_HSTS_SUBDOMAINS`, no `preload`; `DBLOOM_HSTS=off` allowed only with a warning), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, `Cross-Origin-Opener-Policy: same-origin`, `Permissions-Policy` denying camera, microphone, geolocation, `Cache-Control: no-store` for every response that depends on identity. CSP and frame rules are `hardening` (Q5). | Header-diff test on page, asset, function, route and error responses; none over plain loopback HTTP for HSTS. |
| FR-SVR-008 | **CORS.** No `Access-Control-*` header on any response; `OPTIONS` answers 405 without CORS headers. | Preflight from an unlisted origin. |
| FR-SVR-009 | **Limits.** Request body cap per route class (functions 1 MiB, import upload by the `io` limit, everything else 64 KiB), header size cap, request timeout, keep-alive timeout, max connections, all `DBLOOM_*` with floors and ceilings. Slow-body requests are cut. Over-limit gives 413 or 431 with a fixed body. | Oversize, slowloris-style and many-connection tests against the built server. |
| FR-SVR-010 | **Health.** `GET /api/health` (liveness): fixed body `{"ok":true}`, status 200 while the process serves, no version or detail, `no-store`, answered before the allow/deny slot but after the host check for the probe host (`DBLOOM_PROBE_HOSTS`, default `localhost,127.0.0.1`), probe peers limited by `DBLOOM_PROBE_ALLOW` (default loopback; SEC-TGT-132). `GET /api/ready` (readiness): 200 only when config is valid, the store opens and answers `SELECT 1`, and shutdown has not begun; 503 with the same fixed body style otherwise; detail (store state, mode, version) only for loopback peers or an administrator session. Both are in the endpoint registry. | Unauthenticated request from a remote address gets nothing extra; readiness flips to 503 on `SIGTERM` and on a locked store. |
| FR-SVR-011 | **Exposure report.** At startup and by `npm run exposure` / `dbloom exposure` (same CLI as the auth commands): bind, origin, allowed hosts, trusted proxies, scheme, HSTS, probe lists, login mode, store mode, direct-mode allow-list state, temp and import dirs, TLS-to-target default, enabled diagnostic endpoints, plus the warnings of SEC-TGT-125 that apply today. No secret, no value of any key. The same function feeds the admin page later. | Snapshot test per topology. |
| FR-SVR-012 | **Image.** Multi-stage `Dockerfile`: pinned Node LTS digest, `npm ci --ignore-scripts` with an allow-list for needed scripts, build, runtime stage with only `.output`, non-root user, read-only root file system supported (writes only to `/data` and `/tmp`), `tini` or Node's own signal handling as PID 1, no dev dependencies, `HEALTHCHECK` on `/api/health`, labels (source, version), `.dockerignore` excludes `.env`, `.git`, `tests`, `e2e`, `.claude` and the other agent folders. Image size and layer list reported in CI. | CI builds, inspects user id, runs with `--read-only`, scans with a vulnerability scanner (Q6). |
| FR-SVR-013 | **Compose and single instance.** `compose.yaml` runs one service, one named volume, no published port by default (Coolify routes to the container port), `expose: 3000`, `restart: unless-stopped`, `stop_grace_period: 30s`, `read_only: true` with `tmpfs: /tmp`, `deploy.replicas: 1`, environment from `.env`. A second `compose.local.yaml` publishes `127.0.0.1:3000`. The store holds an instance lock (pid, host, start time, refreshed); a second process on the same store exits with a clear message (DEP-TGT-150). | CI: start, stop, start with same volume, store intact; second container refused. |
| FR-SVR-014 | **Graceful shutdown.** On `SIGTERM` or `SIGINT`: readiness turns 503, new connections are refused, in-flight requests finish up to `DBLOOM_SHUTDOWN_SECONDS` (default 25, below the Compose grace), running import/export jobs are marked interrupted in the store (not silently dropped), target pools are closed, the store is checkpointed and closed, temp files of finished jobs removed, exit 0. A second signal exits at once. Exit code 1 on startup failure, 0 on clean stop. | Integration test sends `SIGTERM` during a request and a job; store has no WAL leftover and the job state is `interrupted`. |
| FR-SVR-015 | **Proxy test suite.** `npm run test:e2e:proxy` starts the built image and a reference reverse proxy (Traefik, which is what Coolify uses, with the full suite; Caddy runs a smaller header/forwarding subset, Q7) in Compose, and runs the tests of FR-SVR-003 to 008 and 010 through the proxy and directly: spoofed forwarded headers, forged `Host`, missing `Origin`, direct access to the app port, redirect behaviour, header overwrite, body size, timeouts. | The suite exists and runs in CI on `main`. |
| FR-SVR-016 | **CI.** `.github/workflows/ci.yml` adds: Docker build with the compose test (health, restart, volume), proxy suite (015), `npm audit --omit=dev` fails on high, pinned `@tanstack/*` check (exact versions, lock file), lifecycle-script allow-list check, `.env.example` versus schema check, header-diff check (NFR-TGT-121). Actions pinned by SHA. | Workflow runs green on a clean clone; each check fails on a seeded violation. |
| FR-SVR-017 | **Mode refusal rules.** `DBLOOM_STORE=none` with account mode is refused at startup; stateless sets a read-only root file system as supported; the startup log and the exposure report state the mode. | Startup tests per combination. |
| FR-SVR-018 | **Close the *verify* items.** Record results (in `reviews/` and linked from here) for: Nitro bind and forwarded-header behaviour (h3 trust), TanStack server-route CSRF coverage at the pinned version, `__Host-` cookie behind Coolify/Traefik, CIDR matcher choice, header setting for SSR, functions and routes. | Each item has a recorded result and a test. |
| FR-SVR-019 | **Deployment guide.** `docs/deploy.md`: Coolify steps (repository, build pack Dockerfile or Compose, variables, volume, health check, domain, one replica), the topologies of DEP-TGT-120, variable reference generated from the schema, backup of `/data` (store plus key), key rotation pointer, upgrade and rollback, what the proxy must overwrite, the container bind note (DEP-TGT-121). | Link check; the variable table is generated and diffed in CI. |
| FR-SVR-020 | **Logging.** One structured logger (JSON lines on stdout, level by `DBLOOM_LOG_LEVEL`, default `info`), request id per request, no query strings with tokens, no bodies, no `Authorization` or cookie values; the audit stream stays separate (NFR-TGT-090). Debug level refused when `NODE_ENV=production` unless `DBLOOM_ALLOW_DEBUG=true` (a warning trigger). | Log capture test with secrets in URL and headers. |

## 3. Tech stack
TanStack Start 1.x on Nitro (Node preset), Vite 8, Node 24 in the image (24.7 floor in CI), SQLite store (`node:sqlite`), Vitest, Playwright, Docker and Compose v2. Reverse proxy for tests: Caddy 2 and Traefik 3 images. No new runtime dependency planned; CIDR through `node:net` `BlockList` (Q3).

## 4. Commands
```
Build:        npm run build
Typecheck:    npm run typecheck
Lint:         npm run lint
Unit/integr.: npx vitest run
E2E (main):   npm run test:e2e
E2E (proxy):  npm run test:e2e:proxy          # new
Image:        docker build -t dbloom . && docker compose up -d
Exposure:     npm run exposure                 # new
Audit:        npm audit --omit=dev
```

## 5. Project structure
```
src/server/net/             client-address.ts, origin.ts, hosts.ts, gate.ts        (new)
src/server/http/headers.ts  central response headers                               (new)
src/server/lifecycle/       shutdown.ts, instance-lock.ts, readiness.ts            (new)
src/server/config.ts        extended, zod schema, variable registry
src/server/exposure.ts      report + warnings                                      (new)
src/routes/api/health.ts, ready.ts
Dockerfile, compose.yaml, compose.local.yaml, compose.proxy.yaml, .env.example, .dockerignore
deploy/caddy/Caddyfile, deploy/traefik/dynamic.yml
e2e/proxy/*.spec.ts
docs/deploy.md
```

## 6. Code style
```ts
// One place decides the client address; nothing else reads forwarded headers.
export function clientAddress(peer: string, headers: Headers, cfg: NetConfig): string {
  if (!cfg.trustedProxies.contains(peer)) return normalise(peer)
  const chain = parseForwardedFor(headers) // all header lines, in order
  if (chain === null) return 'unknown'
  return normalise(rightmostUntrusted(chain, cfg.trustedProxies, cfg.hops))
}
```
Typed config only, zod at boundaries, `t('key')` for any user-visible text, no string-built SQL, no raw `process.env` outside `config.ts` (lint rule).

## 7. Testing strategy
- Unit: config schema, CIDR and address rules (including `10.0.0.0/8` versus `138.1.2.3`, v4-mapped IPv6), header builder, instance lock, shutdown sequencing with fakes.
- Integration: built server process, real signals, real SQLite file, both MySQL 8.4 and MariaDB 10.11 for readiness with a target.
- E2E: `test:e2e:proxy` through Traefik (full) and Caddy (subset); main Playwright runs unchanged behind the gate.
- Container: CI builds the image, runs read-only, restarts with the volume, checks user id.
- Regression: header-diff snapshot per release (NFR-TGT-121).

## 8. Boundaries
- **Always:** validate config at startup and fail closed; derive origin, scheme and client address in the one module; run the proxy suite before changing any header or gate rule; keep logs free of secrets.
- **Ask first:** new runtime dependency; changing a default bind or port; adding a published port to the reference Compose; own-TLS; any change of cookie names or flags.
- **Never:** trust a forwarded header from an untrusted peer; build a URL from the `Host` header; commit `.env` or a key; run the image as root; ship a health route that returns version or configuration; skip the origin check on server routes.

## 9. Success criteria
1. The image builds in CI, runs as non-root with a read-only root file system, and the Compose test restarts it with the same volume and finds the store intact.
2. Starting with each missing or placeholder required value exits 1 with a message naming only the variable.
3. Through the reference proxies, a forged `Host`, spoofed `X-Forwarded-*`, missing `Origin` and a cross-site POST are refused; the same requests from the proxy path with correct headers succeed.
4. Every response class carries the FR-SVR-007 headers; the header-diff test is green.
5. `SIGTERM` during a request and an import job finishes the request, marks the job interrupted, leaves a clean store, exits 0 within the grace period.
6. `/api/health` and `/api/ready` reveal nothing beyond the fixed body to an outsider.
7. The exposure report matches the effective configuration for each topology in `docs/deploy.md`.
8. All FR-SVR-018 *verify* items have recorded results.

## 10. Plan sketch (for review, not yet a plan)
1. Config registry, `.env.example`, bind and origin rules (001 to 003, 017).
2. Client address and gate middleware, headers (004 to 008).
3. Limits, health and readiness, logging (009, 010, 020).
4. Shutdown and instance lock (013, 014).
5. Exposure report and CLI (011).
6. Image, Compose, CI (012, 016).
7. Proxy suite and the *verify* items (015, 018).
8. Deployment guide (019).

## 11. Decisions (owner, 2026-11-02: "Agree" = every recommendation below is DECIDED; Q6 needs a go before the CI change is made)
- **Q1. Scope of this module.** Recommended: this file as written, with allow/deny lists, endpoint registry and CSP in `hardening`. Alternative: merge both modules.
- **Q2. Container bind.** SEC-TGT-124 says loopback default, but a container must listen on `0.0.0.0` to be reachable by Coolify. Recommended: the image sets `DBLOOM_HOST=0.0.0.0` itself and Compose publishes no port; the bind rule (FR-SVR-002) then requires origin and trusted proxy in the image, so a bare `docker run -p` fails closed.
- **Q3. CIDR matcher.** Recommended: `node:net` `BlockList` plus our own parser tests, no new dependency. Alternative: `ipaddr.js`.
- **Q4. Old `DBLOOM_TRUST_PROXY=true`.** Recommended: keep for one release with a warning, meaning "private-range peer". Alternative: remove now (the project is unreleased).
- **Q5. CSP and frame rules.** Recommended: `hardening` module (needs a nonce strategy for SSR and the Monaco/CodeMirror workers). This module sets the other headers only.
- **Q6. Image scanning.** Recommended: Trivy in CI, fail on high with a fix available. Needs a go (CI change).
- **Q7. Proxy for tests.** Traefik 3 for the full suite, because Coolify uses it; Caddy for a smaller header/forwarding subset. (Corrected 2026-11-02 after the owner pointed out that the first draft had the priority reversed.)
- **Q8. Node floor.** OPEN.md item 2: 22.12 versus 22.13 for `node:sqlite`. Image is Node 24 and CI runs 24.7; recommend declaring `engines >= 24.7` and closing the item.
- **Q9. Probe allow-list default.** Recommended: loopback only, which works for the Docker `HEALTHCHECK`; Coolify's own check runs inside the container network and needs `DBLOOM_PROBE_ALLOW` set to the proxy network (documented in the guide).

**Status (2026-11-02):** task 1 done (FR-SVR-001, 017, config part of 002 and 003): `src/server/env-registry.ts` (all `DBLOOM_*` and `PORT`; `.env.example` generated from it), `config.ts` startup rules and warnings, tests `tests/config-*.test.ts`. Auth, sql and rows reads are registered but still parsed by their modules (TODO in the registry). Request-time Host check, scheme check and client address are tasks 2 and 3.

**Decided (owner "Ok", 2026-11-02) after task 1:** (1) Compose requires `DBLOOM_PUBLIC_ORIGIN` and `DBLOOM_TRUST_PROXY`; `compose.local.yaml` (task 7) supplies local values. (2) New variable names as chosen in `env-registry.ts` (`DBLOOM_TLS`, `DBLOOM_PROXY_HOPS`, `DBLOOM_HSTS*`, body/header/timeout/connection limits). (3) Legacy `DBLOOM_TRUST_PROXY=true` satisfies the bind rule with a warning for one release (Q4). Follow-up: merge the two `DBLOOM_PUBLIC_ORIGIN` parsers (`config.ts` and `auth/start-gate.ts`) in task 2 or 3. Q6 (Trivy) approved ("go", 2026-11-02).

**Status (2026-11-02, task 2):** done: `src/server/net/` (`cidr.ts`, `client-address.ts`, `origin.ts`, `current.ts`), all `getRequestIP` callers and the duplicate origin parser replaced, ESLint rule plus `tests/net-*.test.ts`, finding in `reviews/server-nitro-peer.md`. Next: task 3 (gate, headers) uses `isHostAllowed`, `effectiveScheme` (mismatch result) and `currentClientAddress`.

**Decided (owner "Accept all of those", 2026-11-03) after task 2:** trusted chain with only trusted entries or an empty `X-Forwarded-For` gives the peer address; `DBLOOM_PROXY_HOPS=N` takes the entry N from the right (`unknown` if the chain is shorter); an entry with a port is malformed (`unknown`); allowed-host matching is exact including port, and `*.x.org` matches subdomains only, not the apex.

**Status (2026-11-03, task 3):** done: global gate as Nitro middleware (`src/server/net/gate.ts`, `gate-middleware.ts`; Host 421, OPTIONS 405, scheme mismatch refusal for credential functions and pages, client address stored on the request context, empty slot for allow/deny, origin check for non-GET on functions and routes), central headers by the Nitro `response` hook (`src/server/http/headers.ts`, `headers-plugin.ts`), tests `tests/gate-*.test.ts` with header-diff snapshot, verify items for FR-SVR-018 in `reviews/server-gate.md`. Open for the owner: cookies keep `Secure` always (`__Host-` prefix needs it); build function ids are now `<file>.<name>`; loopback default allowed hosts include `host:PORT`.

**Decided (owner "Accept", 2026-11-03) after task 3:** (1) session cookies are always `Secure` (the `__Host-` prefix requires it); this amends SEC-TGT-135 and FR-SVR-006 ("`Secure` follows the configured scheme"): the scheme only drives HSTS and the scheme-mismatch refusal. Chrome accepts it on `http://localhost`, Safari does not. (2) Strict origin rule for non-GET requests. (3) Server function ids are `<file>.<name>`. (4) Default allowed hosts on loopback include `host:PORT`. (5) One credential-function list in `gate.ts`, guarded by a test.
