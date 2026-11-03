# Server module acceptance walk-through (SPEC/27 section 9)

Walked 2026-11-03 on Windows 11 with Docker Desktop; Linux container for the POSIX signal tests. Full vitest run 2876 passed before tasks 7 to 9 (Docker test databases up); `npm run test:e2e:proxy` 21 passed; `npm run test:e2e:proxy-browser` 1 passed.

| # | Criterion | Evidence | State |
|---|---|---|---|
| 1 | Image builds, non-root, read-only root, restart keeps the store | `scripts/docker-smoke.sh` run locally: non-root, `--read-only` start healthy, second instance refused, stop exit 0, restart on the same volume healthy. CI job `docker` has the same script. | Met locally. The workflow has never run on GitHub. |
| 2 | Missing or placeholder required values exit 1 naming only the variable | `tests/config-startup-rules.test.ts`, `tests/config-registry.test.ts` (placeholder check, no echo of values). Startup plugin exits 1 in production (`startup-plugin.ts`). | Met by unit tests; exit code of a real process with a bad value is covered by the compose `:?` interpolation and the lifecycle tests, not by a dedicated process test. |
| 3 | Reference proxies refuse forged Host, spoofed `X-Forwarded-*`, missing Origin, cross-site POST; correct requests pass | `e2e/proxy/*.proxy.test.ts`: Traefik, Caddy, nginx, direct. Passing requests: `/` 200 and `/invite` 200 through Traefik; login in `e2e-proxy/cookie.spec.ts`. | Met. |
| 4 | Every response class carries the FR-SVR-007 headers | `tests/gate-headers.test.ts`, `tests/gate-integration.test.ts` header-diff snapshot (page, asset, function, route, 404, 421, 405). | Met. |
| 5 | SIGTERM during a request and an import job: request finishes, job interrupted, clean store, exit 0 within grace | `tests/server-lifecycle.integration.test.ts`. Windows run (IPC shim) in the full suite; real POSIX signals run in a `node:24-slim` container with the host MySQL forwarded: 6 of 6 and the limits suite 12 of 12 passed. | Met on both paths. |
| 6 | Probes reveal nothing beyond the fixed body to an outsider | `tests/server-health.test.ts`, `tests/server-limits.integration.test.ts` (non-probe peer 404), proxy test (probe path 404 through Traefik). | Met. |
| 7 | Exposure report matches the effective configuration per topology in the guide | `tests/exposure.test.ts` snapshots: local default (topology 1), behind proxy (2), risky stateless (3 warnings). Topology 4 is refused at startup (`DBLOOM_TLS=own`). | Met for the supported topologies. The report was not compared with a real Coolify deployment. |
| 8 | All FR-SVR-018 verify items have recorded results | See below. | Met. |

## FR-SVR-018 verify items
- **Nitro bind and forwarded-header behaviour (h3 trust):** `reviews/server-nitro-peer.md`.
- **TanStack server-route CSRF coverage at the pinned version:** `reviews/server-gate.md` section 2 (routes have none by default; the gate is the only origin check for them).
- **`__Host-` cookie behind Traefik:** `reviews/server-proxy.md`, browser test `e2e-proxy/cookie.spec.ts`.
- **CIDR matcher choice (Q3):** `node:net` `BlockList` with our own parser (`src/server/net/cidr.ts`); no new dependency. Tests in `tests/net-cidr.test.ts` and `tests/net-client-address.test.ts` cover IPv4, IPv6, IPv4-mapped normalisation, malformed entries and the 10.0.0.0/8 versus 138.1.2.3 case. `ipaddr.js` stays the alternative if a gap shows up.
- **Header setting for SSR, functions and routes:** `reviews/server-gate.md` section 3.

## Still open (not blocking the criteria)
Owner decisions from task 5 not yet accepted: interrupted jobs are not persisted across the restart; no 503 window on an open port (readiness is visible only on already-open connections); exit codes (0 after a clean stop, 1 on a second signal or lost lock); the lock row stays after SIGKILL and is taken over after 30 s; `CI` and `TEST` make srvx skip its signal handler. From task 4: `/assets/*` is served before the gate.

Not done anywhere: the GitHub workflow has not run (Trivy findings unknown); Coolify steps are from general knowledge; proxy images are not pinned by digest; Apache is not tested; Traefik's 60 s `readTimeout` is from the docs, not timed; rollback onto a migrated store is untested.
