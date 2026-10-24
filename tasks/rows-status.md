# Module `rows` status (2026-10-24) - handover

Spec: SPEC/24-module-rows.md (approved; Q1-Q8 = recommended defaults, assistant-decided on owner instruction, changeable).

## Done
- Task 0 contracts (`src/server/rows/types.ts`, `src/components/rows/registry.ts`), spike 0b (findings folded into spec 5.3/5.7).
- Package A: `src/server/rows/{model,codecs,builder,filter,classes}.ts`, `src/lib/rows/filter-tree.ts`.
- Package B: `src/server/rows/{service,execute,limits,blob,prefs,http,default-ports}.ts`, `src/server/rows.functions.ts`, `src/routes/api/rows/*`, store migration 3 (`ui_prefs`), pool `maxPreparedStatements: 100`, `ROW_HINTS`.
- Package C: grid, pager, column menu, selection, filter builder, search bar (`src/components/rows/*`, `grid/table-view.tsx`).
- Package D: forms, editors, dialogs, FK picker, BLOB field, `use-row-editing.tsx`.
- State: typecheck, lint, build clean; vitest 1545/1548 on first run, the 2 timing-flaky tests (sql-run export hook, structure lock wait) pass on rerun.

## NOT done (next session)
- Package E: `e2e/rows-*.spec.ts` for SCN-037..051 (two-session fixture, storage scan, axe). Existing Playwright suite NOT re-run against the new grid.
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
