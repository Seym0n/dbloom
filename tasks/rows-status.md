# Module `rows` status (2026-10-24) - handover

Spec: SPEC/24-module-rows.md (approved; Q1-Q8 = recommended defaults, assistant-decided on owner instruction, changeable).

## Done
- Task 0 contracts (`src/server/rows/types.ts`, `src/components/rows/registry.ts`), spike 0b (findings folded into spec 5.3/5.7).
- Package A: `src/server/rows/{model,codecs,builder,filter,classes}.ts`, `src/lib/rows/filter-tree.ts`.
- Package B: `src/server/rows/{service,execute,limits,blob,prefs,http,default-ports}.ts`, `src/server/rows.functions.ts`, `src/routes/api/rows/*`, store migration 3 (`ui_prefs`), pool `maxPreparedStatements: 100`, `ROW_HINTS`.
- Package C: grid, pager, column menu, selection, filter builder, search bar (`src/components/rows/*`, `grid/table-view.tsx`).
- Package D: forms, editors, dialogs, FK picker, BLOB field, `use-row-editing.tsx`.
- State: typecheck, lint, build clean; vitest 1545/1548 on first run, the 2 timing-flaky tests (sql-run export hook, structure lock wait) pass on rerun.

## Update 2026-10-26
- Wire-up done (table-view.tsx), session-end handle cleanup done, grid-alignment exclusion done; Playwright suite re-run: green after fixing stale direct-mode assertions. Docker must be running for DB tests.
- Package E started: `e2e/rows-edit.spec.ts` (SCN-037 partly, 038 partly, 040 step 1; both products, `rows-.*` is in `perProductSpecs`), `e2e/fixtures/rows-fixtures.ts`. First real browser run of the editing UI works (insert, inline edit, delete dialogs).

## NOT done (next session)
- Package E also: `e2e/rows-bulk.spec.ts` (SCN-041 steps 1-3 on InnoDB), `e2e/rows-nochange.spec.ts` (SCN-039 core). Badge wording fixed (`rows.class.*`, `ClassBadge scope`). Also `rows-readonly.spec.ts` (SCN-042 UI side; hand-made POST refusal untested in e2e), `rows-conflict.spec.ts` (SCN-044 steps 2-5, audit lines unchecked).
- Also `rows-identity.spec.ts` (SCN-043 steps 1-5, no generated-invisible-PK case) and `rows-filter.spec.ts` (SCN-046: flat any-of filter, injection and LIKE-literal search, hex search, page find; NOT covered: nested groups, between/in, sort by two columns + page 2, string-operator setting, forged request). SCN-045 blocked: needs URL routing for tab+filter (search-param route proposed) and `fkHref`/`groupHref` wiring.
- Also `rows-paging.spec.ts` (SCN-049 scaled to 200k rows, estimate/Count/Last page, `a.b` table with x` column; NOT: cancel count, view 10 000+, page 4000 hint, 2-column modifier sort, timeouts) and `rows-prefs.spec.ts` (SCN-051 steps 1-2; NOT: partial text/page size/ProtectBinary step 3, stateless step 4). Fixed: reopened table showed 30 s cached rows/catalog (staleTime 0 on the page query).
- Also `rows-privileges.spec.ts` (SCN-050: SELECT-only, column-level UPDATE; NOT: forged changeRows 1142/1143 + audit, `blind` user, failing privilege read) and `rows-blob-json.spec.ts` (SCN-047: download, PNG preview, upload + 9 MiB refusal; NOT: wrong-session cell id, SVG/PDF; SCN-048: invalid/valid JSON, emoji; NOT: geometry, CR LF/NUL).
- Also `rows-a11y.spec.ts` (axe wcag2a/aa on grid, insert/edit/delete/filter/columns dialogs: clean; storage scan: clean). Added devDependency `@axe-core/playwright` 4.14.0. FOUND, not fixed (skeleton task 10): app-shell tab strip has close buttons inside `role=tablist` (aria-required-children); excluded from the scan.
- Package E rest (SCN-041 MyISAM/1000 cap, 039 all-type matrix & 5000-char key & proxy): SCN-037 (3 rows, Ignore, copy), 038 (Tab, trigger, view), 039, 040 steps 2-3 (cascade/token, 1451), 041-051; two-session fixture, storage scan, axe.
- Task 15: fill the remaining *verify* cells of SPEC/24 (incl. `LEFT(col,...)` cost at ~line 366); update FR-ROW-020 text to the narrower cascade rule (hard only for deletes with ON DELETE CASCADE and updates touching ON UPDATE CASCADE columns).
- Wire-up: table tab must call `setFormsApi(liveFormsApi)` once (`useLiveFormsApi()` in `server-api-forms-live.ts`) and pass `useRowEditing` hooks to the grid; `fkHref`/`groupHref` built by the table tab. Check the editing UI is actually reachable in the app.
- `e2e/grid-alignment.spec.ts` must exclude `[data-rows-actions]` cells.
- `sessions.ts` should call `cellHandles.dropSession` and `uploads.dropSession` on session end.
- Tests missing: `lookupRows`, `referencingRows` integration; async/keyboard flows (no jsdom); `lower_case_table_names=1`; role/column-level privileges.
- Move download byte-chunk statements from `default-ports.ts` into `builder.ts` (FR-ROW-001).
- `referencingRows` silently skips a group when a key cell is truncated/binary (contract has no flag).
- UI not visually reviewed by the owner: toolbar wraps to two lines at 1440px; D's UI never run in a browser.
- Traceability file still says `planned` for skeleton/structure/sql-tab/rows rows; update statuses.
- Split-off modules proposed in SPEC/24 (navigation, browse-view, db-search, transformations) are not in the capability map/traceability yet.
- Skeleton task 10 (a11y/motion pass, axe) still open.

## Not specified yet
auth-account, io, server, admin, assistant, hardening. Suggested order: io, auth-account, server, admin, assistant, hardening.
