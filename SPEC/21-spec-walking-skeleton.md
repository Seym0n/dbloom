# 21 — Module spec: `skeleton` (walking skeleton)

**Status: APPROVED by the owner (2026-10-23): npm, no licence file for now (the owner adds it manually), local Docker test databases, Playwright browsers.** Written with the spec-driven-development skill. Implements only a thin vertical slice of SCN-004, SCN-005 and SCN-010 (`19-scenarios.md`) to prove the stack end to end. Decisions come from `OPEN.md` items 2, 7, 12 and `11-target-security.md`; nothing here reopens them.

## 0. Capability map (build order, module ids stable)

| Module id | Responsibility | Depends on |
|---|---|---|
| skeleton | Project, Docker/Compose, CI, store interface, direct-mode login, database/table list, read-only table grid, design system base | — |
| auth-account | Setup wizard, DBLoom users, 2FA, account mode, connection picker | skeleton |
| browse-edit | Structure view, row edit (G1/G2), filter builder | skeleton |
| sql-tab | SQL tab, guard, history, timeouts | skeleton |
| io | Export/import (SQL, CSV, JSON) | browse-edit, sql-tab |
| assistant | AI sidebar, PII columns | sql-tab |
| admin | Users, settings UI, audit viewer | auth-account |

Only `skeleton` is specified below. The others get their own spec after `skeleton` is accepted.

## 1. Assumptions (correct me now)
1. Direct mode and stateful store only; stateless mode and account mode are later modules. The store is created but holds only sessions.
2. Single package, not a monorepo. Source lives in `E:\dbloom` root (`src/`, `tests/`); the legacy `legacy-release/` stays untouched and is never imported (CON-TGT-001).
3. I scaffold in a scratch folder (TanStack Start template), then move into the root, keeping `SPEC/`, `.git`, `.claude`, `.agents`.
4. Exact versions are pinned at install time to releases at least 7 days old (DEP-TGT-126); today `@tanstack/react-start` 1.169.4 is one day old, so an older release is chosen. Versions are verified through context7 and `npm view`, not memory.
5. Node 24 locally, CI matrix 22.12 and 24. `node:sqlite` is used if it works in the container on both, otherwise `better-sqlite3`.
6. Tests: Vitest (unit, integration against real MySQL 8.4 and MariaDB 10.11 containers) and Playwright (one browser test per scenario).
7. UI: shadcn/ui on Tailwind, light and dark, English strings through an i18n layer from day one (NFR-TGT-160). Visual direction follows the `apple-design` and `design-taste-frontend` skills (app-screen rules): restrained, one accent, spring motion that respects reduced-motion, no generic AI look.
8. No commit until you say so.

## 2. Objective
Prove that DBLoom's stack runs end to end on the real deployment target. A user opens the app, logs in with MySQL/MariaDB credentials (direct mode), sees databases and tables in the left sidebar, opens a table in a centre tab and sees a paged, sortable, read-only grid, and logs out. Container runs under Docker Compose as on Coolify. The layout shell already has the three areas of UI-TGT-001 (right assistant sidebar is an empty placeholder).

## 3. Tech stack
TypeScript (strict), TanStack Start (plain Node output, DEP-TGT-124) with Router/Query/Table, React, shadcn/ui, Tailwind, `mysql2`, SQLite store behind a `Store` interface (DEP-TGT-125), Vitest, Playwright, ESLint + Prettier, pnpm or npm (npm unless you prefer pnpm).

## 4. Commands (as scaffolded; final names confirmed in task 1)
```
Install:   npm ci
Dev:       npm run dev
Build:     npm run build
Start:     node .output/server/index.mjs
Lint:      npm run lint
Typecheck: npm run typecheck
Unit:      npm test
E2E:       npm run test:e2e
DBs:       docker compose -f compose.test.yaml up -d   (mysql 8.4 + mariadb 10.11)
Image:     docker compose up --build
```

## 5. Project structure
```
src/routes/        TanStack file routes (login, app shell, table tab)
src/server/        server functions: auth, sessions, db access (only place that touches mysql2)
src/server/db/     connection pool per session, identifier quoting, query builder
src/server/store/  Store interface + sqlite implementation
src/components/    ui/ (shadcn), shell/ (sidebar, tabs, assistant placeholder), grid/
src/i18n/          en.json + helper
tests/             unit and integration
e2e/               Playwright, one file per scenario
SPEC/              specification (this file included)
Dockerfile, compose.yaml, compose.test.yaml, .env.example, .github/workflows/ci.yml
```

## 6. Code style
Server functions validate input with zod, never build SQL by string concatenation of user input; identifiers go through one quoting helper.
```ts
export const listRows = createServerFn({ method: 'POST' })
  .validator(z.object({ db: z.string(), table: z.string(), page: z.number().int().min(0), sort: z.string().optional() }))
  .handler(async ({ data }) => {
    const conn = await requireTargetConnection();            // from session, never from client
    const t = await resolveTable(conn, data.db, data.table);  // names checked against the server (SEC-TGT-116)
    return pageRows(conn, t, data);                          // quoteIdent + parameters (SEC-TGT-117)
  });
```
Conventions: files kebab-case, components PascalCase, no default exports outside routes, no comments that restate code, UI strings only via `t('key')`.

## 7. Requirements covered (and what is explicitly not)
| ID | Slice implemented |
|---|---|
| SEC-TGT-018, 020 | Direct-mode login, single target, uniform error text, per-address and per-target rate limit |
| SEC-TGT-040, 042 | `__Host-` cookie, new session at login, CSRF on state-changing calls, logout is POST |
| SEC-TGT-116, 117 | Names verified against the server, one identifier quoting helper |
| SEC-TGT-070, 112 | Cell values escaped; binary shown as hex placeholder |
| SEC-TGT-030, 032, 033 | Host normalisation (DATA-TGT-095) and allow/deny check; TLS verify default; connect timeout |
| DEP-TGT-124, 125 | Node server image, SQLite on `/data` volume |
| UI-TGT-001, 003 | Three-area shell, tabs, shadcn |
| G8 | Page size 50, server-side sort and paging, estimated total |
| NFR-TGT-160 | i18n scaffold |

Not in this module: setup wizard, 2FA, account mode, row editing, SQL tab, export, assistant, settings UI, audit viewer (an audit log line is written to stdout for login, logout, table open).

## 8. Testing strategy
- Unit: host normalisation (DATA-TGT-095 table), identifier quoting, session store, rate limiter.
- Integration (real MySQL 8.4 and MariaDB 10.11): login success and uniform failure, list databases/tables, paging and sorting, table names with backticks, quotes and unicode.
- E2E (Playwright): SCN-004, SCN-005 (open, sort, page, SQL shown), SCN-010 (old cookie refused after logout).
- Security checks: forged POST without CSRF is rejected; loopback/denied host refused before connecting; no credential in logs.
- CI runs lint, typecheck, unit, integration, e2e and the Docker build on every push.

## 9. Boundaries
- **Always:** write the test first for server logic, run lint/typecheck/tests before reporting done, keep secrets out of git, check names against the server, pin exact versions.
- **Ask first:** adding a dependency beyond section 3, changing the Store interface after tasks start, changing CI, any commit or push.
- **Never:** copy or read-for-copying LegacyAdmin code, templates, CSS or text; store target passwords in the SQLite store in this module; put credentials in the browser; expose `mysql2` outside `src/server/db/`.

## 10. Success criteria
1. `docker compose up --build` starts the app; `/` shows the login page naming direct mode.
2. Logging in to the test MySQL 8.4 and MariaDB 10.11 shows their databases; wrong password, unknown host and denied host give the same message.
3. Opening a table shows 50 rows, sorts by a column on the server, pages forward, shows the SQL that ran.
4. Logout invalidates the cookie; the old cookie gets the single "session ended" response (G10).
5. All tests in section 8 pass in CI on Node 22.12 and 24.
6. The shell shows left sidebar, tabs and an empty right panel, in light and dark, keyboard-navigable, reduced-motion respected.

## 11. Tasks (ordered; each ≤ ~5 files, each with a verify step)
1. Scaffold in scratch, move to root, pin versions, lint/typecheck/test wiring. *Verify:* `npm run build && npm test` green on an empty app.
2. Dockerfile, compose, `.env.example`, `/data` volume, CI skeleton. *Verify:* container starts, health route answers.
3. `Store` interface + SQLite implementation + container test of `node:sqlite` on Node 22 and 24 (closes part of OPEN item 12). *Verify:* tests pass in both images.
4. Host normalisation and allow/deny check (TDD). *Verify:* DATA-TGT-095 table tests.
5. Direct-mode login, session cookie, CSRF, rate limit, logout. *Verify:* integration + security tests against both servers (closes the `mysql2` check of OPEN item 2).
6. DB helpers: identifier quoting, table resolution, paged query. *Verify:* integration tests incl. hostile names.
7. App shell and sidebar tree (design pass with the two design skills). *Verify:* Playwright SCN-004.
8. Table tab with grid, sort, paging, SQL display. *Verify:* Playwright SCN-005.
9. Session-ended dialog and logout flow. *Verify:* Playwright SCN-009 (partial) and SCN-010.
10. Accessibility and reduced-motion pass, light/dark screenshots. *Verify:* axe check, screenshots reviewed.

## 12. Open questions
None open. Added during implementation: Nitro (`nitro/vite`) is the documented way to get the plain Node server output and exists only as a beta (3.0.260903-beta); it is pinned exactly (DEP-TGT-124, DEP-TGT-126).

## 13. Implementation notes (2026-10-23)
Tasks 1 to 9 are implemented and verified (105 unit and integration tests against MySQL 8.4 and MariaDB 10.11, 8 Playwright tests); task 10 is partly done (no axe run). Deviations and findings:
- **Node minimum raised to 22.13.** `node:sqlite` is unavailable on Node 22.12 without `--experimental-sqlite`; it is unflagged from 22.13 (checked in `node:22.12-slim`). The owner's "22.12+" in OPEN item 2 needs updating, or better-sqlite3 becomes the fallback. Decision for the owner. **Superseded 2026-10-27:** minimum is now Node 24.7 (built-in `crypto.argon2`, SPEC/26 Q1); CI matrix 24.7 and 24.
- Dependency age: the owner allowed same-day releases, so the latest versions are pinned (the 7-day rule of DEP-TGT-126 is waived for this build). TypeScript is 6.0.3 because `typescript-eslint` does not support TypeScript 7 yet. Nitro 3.0.260903-beta is the only Nitro 3 line.
- Added beyond section 3 (small, shadcn-core and fonts): clsx, tailwind-merge, class-variance-authority, lucide-react, @fontsource/ibm-plex-sans and -mono (fonts are bundled, no Google Fonts call from a self-hosted tool).
- `mysql2` finding: a bare `SELECT 1` returns BIGINT (string) on MySQL 8.4 and INT (number) on MariaDB 10.11; BIGINT is returned as string by design.
- Startup refuses without `DBLOOM_DIRECT_TARGETS` or `DBLOOM_DIRECT_FREE_FORM_ACK=true` (SEC-TGT-018); a Nitro plugin enforces it.
- **Task 10 done 2026-11-05.** `e2e/shell-a11y.spec.ts` (14 tests) runs axe on the direct login page, the shell, the open tree, the assistant panel and the session-ended dialog (light and dark), on tablet and phone, plus the mobile drawer, focus visibility and reduced motion. Axe found nothing on those pages; the drawer gap is closed (backdrop, tap and Escape close it, focus returns to the button, `aria-expanded`). Still not done: the design inspector run, the compose restart test with the volume, and the first CI run on GitHub.
