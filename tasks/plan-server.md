# Plan: module `server`
Spec: SPEC/27-module-server.md (approved 2026-11-02, all section 11 recommendations decided). Depends on skeleton, auth-account.

Order (sequential; each ends at a green checkpoint: typecheck, lint, vitest, relevant e2e):
1. Config registry + `.env.example` + bind/origin/mode rules (FR-SVR-001, 002, 003 config part, 017). Foundation for all later steps.
2. `net/` module: CIDR trusted proxies, client address, origin, hosts; replace every `getRequestIP`; lint rules (005, 003, 004).
3. Global request gate + central response headers + CORS off (006, 007, 008). Close verify items for Nitro/h3 and server-route CSRF here (018 part).
4. Limits, health + ready routes, structured logger (009, 010, 020).
5. Lifecycle: shutdown, instance lock, interrupted jobs (013 lock, 014).
6. Exposure report + CLI (011).
7. Image, Compose files, `.dockerignore`, CI jobs (012, 013, 016). Trivy step waits for owner go.
8. Proxy suite Traefik (full) + Caddy (subset) (015), remaining verify items (018).
9. `docs/deploy.md` generated variable table (019).

Parallel: 7 can start after 1. 8 needs 3 and 7. 9 last.
Risks:
- Nitro/h3 may not expose peer address or trust semantics as needed (verify in step 3; fall back to reading `event.node.req.socket`).
- Global middleware may not cover server routes and functions alike (verify; else add a wrapper per route class plus a route-inventory test).
- Windows EBUSY nitro build flake; proxy suite needs Docker (Linux containers).
- `read_only` root file system may break temp/SQLite WAL paths; test early in step 7.
- Changing cookie `Secure`/origin logic can break existing auth e2e; run `test:e2e:auth-live` after steps 2 and 3.
