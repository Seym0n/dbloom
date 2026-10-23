# Plan: module `skeleton`
Spec: SPEC/21-spec-walking-skeleton.md (approved 2026-10-23; npm, no licence file, local Docker DBs, Playwright browsers OK).

Order (sequential, each a vertical checkpoint):
1. Project foundation (build from scratch per TanStack docs, pinned deps, lint/typecheck/test)
2. Container + CI
3. Store interface + node:sqlite (Node 22/24 container test)
4. Host normalisation (pure, TDD)
5. Direct-mode auth (session, CSRF, rate limit, logout) vs MySQL 8.4 + MariaDB 10.11
6. DB helpers (quoting, resolve, paged query)
7. App shell + sidebar tree (design pass)
8. Table tab grid
9. Session-ended + logout flow
10. A11y / motion / screenshots

Risks: nitro is beta-only (3.0.260903-beta, needed for Node output); TanStack Start API drift (check context7 per use); node:sqlite stability on Node 22.
Pins: versions >= 7 days old at 2026-10-23.
