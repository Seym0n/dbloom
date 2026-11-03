# Request limits, health, readiness, logger (FR-SVR-009, 010, 020; task 4)

Checked 2026-11-03 against nitro 3.0.260903-beta, srvx 1.0.6, Node 24.19, built output run with `node .output/server/index.mjs`.

## 0. Removed by owner decision (2026-11-03)
The app no longer touches the Node HTTP server. Removed: `src/server/http/listener-plugin.ts` (the one-call `http.createServer` wrapper) and its registration in `vite.config.ts`; `applyListenerLimits` and `watchRequest` (per-request timer) in `limits.ts`; the 431 header refusal; max-connections and keep-alive settings; the variables `DBLOOM_MAX_HEADER_KIB`, `DBLOOM_REQUEST_TIMEOUT_SECONDS`, `DBLOOM_KEEPALIVE_TIMEOUT_SECONDS`, `DBLOOM_MAX_CONNECTIONS` and the matching `Config.limits` fields; their tests. Why: the reverse proxy is the primary limit, and the wrapper depended on Nitro/srvx internals (fragile). Header size, connection and timeout limits are Node defaults plus the proxy. Body size limits also belong in the proxy (Traefik needs a buffering/body-limit middleware, to be verified in task 8); the app only caps bodies for its own endpoints.

## 1. What the runtime supports
- Nitro/h3/TanStack have no body size option. Body caps are enforced in the gate (`evaluateGate`, step 2b) from the declared `Content-Length`. Node enforces the declared length on the wire, so a declared length is a true upper bound. A body with no length (chunked) on a capped route is refused 413 because it cannot be bounded without wrapping the request stream. Browser `fetch` with a string/Blob/FormData body always sends a length.

## 2. Limits as enforced
| Limit | Variable | Where | Over-limit answer |
|---|---|---|---|
| Server function body 1 MiB | `DBLOOM_BODY_LIMIT_FUNCTIONS_KIB` | gate | 413 `payload_too_large` |
| Other routes 64 KiB | `DBLOOM_BODY_LIMIT_OTHER_KIB` | gate | 413 `payload_too_large` |
| Upload routes `/api/io/upload`, `/api/rows/upload` | io limit / rows limit | their handlers (unchanged); gate skips them | their own 413 |

- Node defaults that now apply (checked 2026-11-03, Node 24.19; srvx 1.0.6 `http.createServer(this.serveOptions, handler)` and the Nitro Node preset set none of these in the built output): `headersTimeout` 60 s, `requestTimeout` 300 s for the WHOLE request including the body, `keepAliveTimeout` 5 s, no connection or header-size override (`maxHeaderSize` 16 KiB). Consequence: an upload to `/api/io/upload` or `/api/rows/upload` that takes longer than 300 s is cut by Node (408, connection closed), however steady. At 300 s a 2 GiB upload (io ceiling) needs about 7 MB/s; the 64 MiB default import limit is no problem. Large imports on slow links can hit this limit and the proxy read timeout (Traefik default believed 60 s, to verify in task 8); operators with big imports must raise the proxy timeout. Not verified by a live 300 s test (the value cannot be lowered without the wrapper).
- Response time is not limited (long SQL runs are cancelled by their own timeouts).
- Not covered by the app: header size, connection count, keep-alive, slow request/response. Proxy and Node defaults.

## 3. Health and readiness
- `GET /api/health`: `{"ok":true}`, 200, `no-store`. `GET /api/ready`: 200 `{"ready":true}` or 503 `{"ready":false}`, `no-store`; loopback peers get detail (`state`, `mode`, `store`, `version`). Administrator-session detail is deferred to the `admin` module.
- Gate order: Host (allowed host, or probe host + probe peer + GET on a probe path) -> OPTIONS 405 -> probe path with a peer outside `DBLOOM_PROBE_ALLOW` gets a bare 404 (empty body, reason `probe`; not byte-identical to the app's HTML 404, same status) -> body cap -> scheme -> origin.
- Decision 404 not 403: an outsider cannot tell the route exists.
- Docker `HEALTHCHECK` runs `fetch('http://127.0.0.1:3000/api/health')` inside the container: Host `127.0.0.1:3000` (probe host), peer 127.0.0.1 (probe peer). Works unchanged (test: Host `127.0.0.1:PORT`).
- Coolify: its health check comes from another container address with Host = container IP:port. Set `DBLOOM_PROBE_ALLOW` to the proxy network CIDR and `DBLOOM_PROBE_HOSTS` to the container address (or use the Docker `HEALTHCHECK`, which needs nothing). To go into docs/deploy.md (task 9).
- Readiness state: `src/server/lifecycle/readiness.ts`, flag on `globalThis` (several bundles). Task 5 calls `setShuttingDown()` when SIGTERM arrives. No test hook on the built server (an extra endpoint would be reachable by an outsider); the 503 flip is tested at unit level and by the SIGTERM test of task 5.

## 4. Logger
- `src/server/log.ts`: JSON lines on stdout, level from `DBLOOM_LOG_LEVEL` (debug in production without `DBLOOM_ALLOW_DEBUG` is refused by the config and treated as info here). Request id: `crypto.randomUUID()` set by the gate middleware on `request.context.dbloom.requestId`, sent back as `X-Request-Id`, on every access line (`msg: "request"`: method, path with redacted query, status, ms) and on `gate.refused` lines (reason, never the Host value). Assets and probes log at debug.
- Redaction: field names (authorization, cookie, set-cookie, password, token, body, ...) -> `[redacted]`; query values of sensitive keys or token-shaped values -> `[redacted]`; `Bearer`/`Basic` text; errors reduced to name + message. Request headers and bodies are never logged by the server code.
- Replaced: `console.warn` in `runtime.ts`, `console.error` in `startup-plugin.ts` and `/api/startup`. Left on purpose: `audit.ts` (audit stream), `auth/setup.ts` banner and CLI output (human output).
- Known gap: real static files (`/assets/*.js` that exist) are served by Nitro's static handler BEFORE the middleware chain, so the Host check, request id and access line do not apply to them (they carry the security headers through the response hook). Present since task 3, not a new regression; the content is public build output. Owner call: leave, or disable Nitro static serving for the gate (`serveStatic: false` with an own asset route).
