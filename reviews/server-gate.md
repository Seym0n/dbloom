# Request gate, central headers, TanStack CSRF (FR-SVR-018 part, task 3)

Checked 2026-11-03 against nitro 3.0.260903-beta, h3 2.0.8, `@tanstack/react-start` 1.169.4 (`start-server-core` 1.169.45, `start-client-core`), built output run with `node .output/server/index.mjs`.

## 1. Does one Nitro middleware cover server functions and server routes alike?
Yes. Nitro option `handlers: [{ route: '/**', middleware: true, handler }]` (vite.config.ts) runs before routing for everything the Nitro app serves: pages (SSR), `/assets/*`, `/_serverFn/*`, `/api/*` server routes, unknown paths (404). TanStack Start is mounted behind Nitro as the renderer, so its server functions and server routes never see a request the middleware did not see. Proof: `tests/gate-integration.test.ts` sends a forged `Host` to `/`, `/setup`, an asset, a server function, four server routes and a 404 path, GET and POST, on two built servers: all 421 with an empty body. `tests/gate-routes.test.ts` repeats this for every entry of the generated route tree and every `createServerFn` export (80+), and checks the registration in `vite.config.ts`.
- A middleware returning a `Response` short-circuits; returning nothing continues.
- In-process requests (startup plugin `nitro.fetch`) carry no socket and `Host: localhost`. They are marked with a symbol on `request.context` (`INTERNAL_REQUEST`, set only by server code) and skip the gate; no header can set it.
- Dev (`vite dev`): not exercised by tests here; the handler registration is the same Nitro option. Dev function ids are base64url JSON, which `serverFunctionName` decodes.

## 2. TanStack Start CSRF / origin at the pinned version
- Server functions: `createStartHandler` adds `defaultCsrfMiddleware` as request middleware for every `/_serverFn/*` request when the app configures none. It uses `Sec-Fetch-Site` when present (must equal `same-origin`), else `Origin` against `new URL(request.url).origin`, else `Referer`; with none of the three it allows the request (`allowRequestsWithoutOriginCheck` only matters for the explicit middleware). It compares with the request URL origin (from `Host`), not the configured public origin.
- Server routes (`createFileRoute(...).server.handlers`, `/api/*`): no origin check at all by default. The CSRF middleware applies to routes only if the app adds it to `requestMiddleware` in a `start.ts`; DBLoom has none. Before this task the routes (`/api/rows/upload`, `/api/io/upload`, cell and download routes) relied on their own session and CSRF-header checks only.
- The warning "TanStack Start server functions are not protected by the CSRF middleware" appears in dev only and is not relevant now.
- Result: the gate is the only origin check covering server routes. TanStack's default stays as a second layer for functions, DBLoom's `sameOriginMiddleware` as a third.

## 3. Can headers be set centrally for SSR responses, functions and routes?
Yes, with the Nitro runtime hook `response` (plugin `src/server/http/headers-plugin.ts`). h3 calls `config.onResponse(response, event)` for every response it builds, including the responses a middleware returns (421, 405, 403) and framework error pages; the hook may mutate `response.headers`. Observed in the built server for page, asset, function (also a 500 answer), route, 404, 421 and 405 (`tests/__snapshots__/gate-integration.test.ts.snap`). The hook exists only when the app has at least one Nitro plugin (it has two). Headers set by a middleware via `event.res.headers` would miss thrown errors, which is why the hook is used.
- A response with immutable headers would throw on `set`; the hook catches that. None of the six response classes hit it.

## Decisions taken
- Cache rule: `Cache-Control: no-store` on every response without its own `Cache-Control`, except `/assets/*` (content-hashed, keeps `public, max-age=31536000, immutable`). Pages are no-store because they carry boot and session state. A handler's own value is kept.
- HSTS only when the configured public origin is https (not from request headers), none on http, none when `DBLOOM_HSTS=off`, no `preload`.
- Credential refusal on scheme mismatch uses one list (`CREDENTIAL_FUNCTIONS` and prefix `setup` in `src/server/net/gate.ts`) plus pages `/setup`, `/invite`, `/recover`. A function whose name cannot be read is refused (fail closed). `tests/gate-routes.test.ts` fails when a new server function is in neither the credential list nor the test's non-credential list.
- Function names: `vite.config.ts` sets `serverFns.generateFunctionId` to `<file>.<name>` (build) so the gate can read the name; before, build ids were SHA-256 hashes.
- Default allowed hosts on a loopback bind now include the `host:PORT` forms (`config.ts`), because matching is exact including the port.
- Session cookie `Secure`: all cookies stay `secure: true`. The cookie names use `__Host-`, which browsers reject without `Secure`, so following an `http` origin would break the cookie rather than relax it. Loopback `http://localhost` works in Chromium and Firefox; Safari rejects `Secure` cookies on plain http. Recorded for the owner (cookie flags are an "ask first" item).
- `Origin` rule: present `Origin` must equal the public origin (or `scheme://Host` without a configured origin); `Origin: null` refused; absent `Origin` needs `Sec-Fetch-Site` `same-origin` or `none`; any other `Sec-Fetch-Site` is refused even with a matching `Origin`. Non-browser clients that send neither header are refused on POST.
