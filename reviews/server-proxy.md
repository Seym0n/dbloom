# Proxy suite and proxy verify items (FR-SVR-015, 018; task 8)

Run 2026-11-03: `npm run test:e2e:proxy` (vitest, no browser), 21 tests green. Image from the repo Dockerfile; `traefik:v3.6`, `caddy:2`, `nginx:1-alpine`; app on a fixed address behind three proxies in `deploy/proxy/compose.proxy.yaml` (network 172.30.0.0/24, `DBLOOM_TRUST_PROXY` lists exactly the three proxy addresses, stateless store, debug log so the effective client address is visible). The proxies exist only in this test setup; the image never contains one.

## Coverage
| Topic | Traefik (full) | Caddy (subset) | Direct to app port | nginx (subset) |
|---|---|---|---|---|
| Central headers, HSTS, no CORS | yes | HSTS | | HSTS |
| http to https redirect | yes (Traefik entry point) | | |  |
| Forged `Host` gives 421, empty body | yes | yes | yes | yes |
| Forged `X-Forwarded-Host`, `Forwarded` ignored for origin | yes | | |  |
| Spoofed `X-Forwarded-For` does not become the client address | yes | yes | yes (untrusted peer) | yes |
| Proxy reports `http` on an `https` origin: credential page 403 | yes (header-triggered router) | | |  |
| POST without `Origin`, cross-site `Origin`: 403; OPTIONS 405 | yes | yes (no Origin) | yes (no Origin) | yes (no Origin) |
| Body cap in the proxy (buffering middleware, 4 MiB): 413 | yes | | | yes (`client_max_body_size 4m`) |
| Probe paths for public peers: 404 | yes | | |  |

Test-only deviations: the Traefik router forwards every `Host` (`HostRegexp`), so the app's own 421 is exercised; real Coolify routers match the domain. The Caddy site lists `evil.example` so Caddy's own SNI/Host check does not stop the forged-Host test. The client address is read from the app's debug access log (`client` field), which exists only at debug level (personal data).

## Verify items
- **Traefik read timeout (owner decision 2026-11-03, SPEC/27 section 12).** Docs v3.6: `entryPoints.<name>.transport.respondingTimeouts.readTimeout` defaults to **60 s** and covers reading the entire request including the body; `writeTimeout` 0 (none), `idleTimeout` 180 s. Node's own request timeout is 300 s. Result: behind a stock Traefik, an upload that takes longer than 60 s is cut by the proxy before Node's limit applies. Not timed in the suite (a 60 s test was judged too slow); the deploy guide must tell operators to raise `readTimeout` for large imports. Coolify's own Traefik config was not inspected.
- **Traefik body-limit middleware.** Docs v3.6: `buffering.maxRequestBodyBytes` rejects larger bodies with 413 without forwarding; `0` is unlimited (the default); bodies above `memRequestBodyBytes` (default 1 MiB) are buffered on disk; the middleware replaces a chunked body by a fixed `Content-Length`. Verified by the 5 MiB test (413 at a 4 MiB cap). Side effect: the proxy reads the whole body before the app sees it, so upload progress is only visible after buffering.
- **`__Host-` cookie behind Traefik.** Verified 2026-11-03 with `npm run test:e2e:proxy-browser` (`e2e-proxy/cookie.spec.ts`, Playwright Chromium, MySQL 8.4 target in the proxy compose): login through Traefik on `https://dbloom.test` sets `__Host-dbloom-session` (HttpOnly, Secure, SameSite=Strict, Path=/, no Domain attribute, host-only on `dbloom.test`) and the session survives a reload. Chromium maps the name to the published Traefik port with `--host-resolver-rules`; Safari and Firefox not run.
- **Scheme mismatch.** Verified with a second router that overwrites `X-Forwarded-Proto: http` for requests carrying a test header.

## Open
- CI job runs the suite on `main` only (spec); Docker Hub pulls of the three proxy images are not pinned by digest yet.
- Apache is not covered; nginx runs the subset with the reference config `deploy/proxy/nginx/default.conf` (sets `X-Forwarded-For` to `$remote_addr`, `X-Forwarded-Proto` to `$scheme`, clears `Forwarded` and `X-Forwarded-Host`, `client_max_body_size 4m`, 600 s read timeout; the nginx image installs openssl with `apk` at start to make a throw-away certificate). The guide lists what a proxy must overwrite (`Host` forwarded, `X-Forwarded-For` set from the peer, `X-Forwarded-Proto` set, client-sent copies replaced, body limit, read timeout).
