# 31 — Module spec: `admin-exposure` (exposure and status page, acknowledgement, readiness detail for administrators)

**Implementation: all 5 tasks done 2026-11-03, acceptance in `reviews/admin-exposure-acceptance.md`. Status: APPROVED by the owner (2026-11-03), Q1 to Q6 all as recommended (four extra runtime warnings on page and banner only; in-memory audited acknowledgement; banner on admin pages and connection home; ST-021 switch left to `hardening`; status block; no acknowledgement step-up).** Written with the spec-driven-development skill (Phase 1) for module id `admin-exposure` of `SPEC/28-admin-capability-map.md`. Depends on `admin-audit` (built, `SPEC/29`) and on `buildExposure` of the server module (`SPEC/27`). `admin-plane` is deferred. No plan, task list or code exists yet.

## 0. Assumptions (correct me now)
1. The exposure report is the pure function `buildExposure(config, env, configWarnings)` in `src/server/exposure.ts`. The page shows the report of the running process (built once at start from the same `Config` and environment the process runs with). The command `dbloom exposure` builds it from the environment of the shell that runs it; the two agree when the environment agrees. The page says "as at start" with the start time.
2. SEC-TGT-125 asks for a persistent warning "when DBLoom is configured to be reachable beyond loopback". On a loopback-only bind the warnings are listed on the page but no banner is raised.
3. Warnings that depend on stored or runtime state (no enforced second factor, setup still open, degraded audit sink) are computed at request time from the settings resolver and the sink status, not at start. They are added to the page and the banner; the CLI cannot know them (it has no store state) and stays as it is, except that it gains the ones that depend only on the environment (Q1).
4. Acknowledgement (ST-032) silences a warning's banner for **this process only**: it is kept in memory and is gone after a restart, which is what "re-shown after restart" requires. It is audited. It never hides the line on the page itself.
5. Account mode only for the page: administrators exist there. Direct and stateless installs have no administrator page; their operators use the CLI and the startup log.
6. With `admin-plane` deferred, the page is reachable by an administrator from any address; the page itself says so as a warning while the administration plane is unrestricted (Q1).
7. No commit and no new dependency without a go. None is needed.

## 1. Objective
Show administrators, in the application, what an operator sees on the command line: how DBLoom is exposed and what is risky about it, and let them acknowledge the warnings without making the warning permanent. Also give administrators the readiness detail that today only loopback peers get. Users: administrators. Success: the page shows the same lines and warnings as `dbloom exposure` for the same environment, a banner appears for administrators while unacknowledged warnings exist on a non-loopback install, acknowledging is audited and undone by a restart, and an administrator session can read `/api/ready` detail from any permitted address.

## 2. Commands
```
Build:         npm run build
Unit/integr.:  npx vitest run tests/exposure*.test.ts
All tests:     npm test
Typecheck:     npm run typecheck
Lint:          npm run lint
UI mock specs: npm run test:e2e:auth-ui
Live account:  npm run test:e2e:auth-live
CLI (exists):  node .output/cli/dbloom.mjs exposure
```

## 3. Project structure
```
src/server/exposure.ts                  buildExposure gains stable warning ids and state-dependent warnings   (changed)
src/server/exposure-state.ts            acknowledgement memory, runtime warnings                              (new)
src/server/exposure.functions.ts        getExposure, acknowledgeExposure                                      (new)
src/server/lifecycle/ready-response.ts  admin session branch                                                  (changed)
src/server/audit/events.ts              exposure.ack                                                          (changed)
src/routes/admin.exposure.tsx           page                                                                  (new)
src/components/auth/exposure/           page, banner                                                          (new)
src/components/auth/connections/        banner on the connection home and the admin pages                     (changed)
src/lib/auth/mock-api.ts                mock report                                                           (changed)
tests/exposure*.test.ts, e2e/auth-ui-exposure.spec.ts, e2e/auth-live-exposure.spec.ts
```

## 4. Requirements

### 4.1 Triage of the rows this module takes
| Row | State | Here |
|---|---|---|
| SEC-TGT-125 | startup log and report built; banner open | warning ids, runtime warnings, banner |
| FR-TGT-146 | page open | page showing the same report |
| FR-SVR-011 | function built, "feeds the admin page later" | the page |
| ST-032 | open | acknowledgement, audited, re-shown after restart |
| FR-SVR-010 / SEC-TGT-132 | detail for loopback only | detail for an administrator session |
| ST-021 | partly (loopback detail) | unchanged switch story (Q4) |

### 4.2 Functional requirements
| ID | Requirement | Verification |
|---|---|---|
| FR-AEX-001 | **Stable warning ids.** Each warning of `buildExposure` has a stable id (`origin-not-https`, `legacy-trust-proxy`, `direct-free-form`, `target-tls`, `private-targets`, `wildcard-hosts`, `probe-open`, plus config-parse warnings as `config`) next to its text; `renderExposure` and the CLI output are byte-identical to today. | Existing snapshot tests unchanged; new test for ids. |
| FR-AEX-002 | **Runtime warnings.** On top of the environment warnings the page computes, at request time: no enforced second factor (`mfaScope` is `none`), setup still open, external audit sink degraded, and, while `admin-plane` is deferred, "administration pages are reachable from any address". Each has an id and the text of the owner decision it follows. They appear on the page and in the banner, not in the CLI (Q1). | Unit per warning with a fake runtime; none on a loopback-only bind raises the banner. |
| FR-AEX-003 | **Page.** `/admin/exposure` for role `admin` (others get the standard denied page, as on the other admin pages): the lines of the report in a definition list, the warnings as a list with severity text, an "as at start" time, and a status block (ready state, login mode, store state, schema version, version, audit sink status). Read only. No secret, no key value, no path of a secret file (the report already holds none). | Mock-layer spec: lines, warnings, status, role gate, axe light and dark, phone width. Test that every line and warning of `renderExposure` for a topology appears on the page. |
| FR-AEX-004 | **Banner.** While at least one unacknowledged warning exists and the bind is not loopback, administrators see a persistent, non-blocking banner on the connection home and on every admin page: count, one line, link to the page. It does not block use. Ordinary users never see it. | Mock-layer spec; unit for the loopback rule. |
| FR-AEX-005 | **Acknowledge.** An administrator acknowledges a warning on the page. The acknowledgement is audited as `exposure.ack` (actor, warning id) through `auditRequired`: if the audit row cannot be written the acknowledgement fails and the banner stays. It is kept in memory for the life of the process; a restart shows the warning again. Acknowledging removes the warning from the banner count only; the page still lists it with "acknowledged by <name> at <time>". A warning that stops being true disappears. | Unit: ack kept in process, audit row written first, failing audit refuses, restart clears (new runtime). Mock spec. |
| FR-AEX-006 | **Readiness detail for administrators.** `GET /api/ready` returns the detail body (`ready`, `state`, `mode`, `store`, `version`) to an administrator session as well as to loopback peers; every other caller still gets the fixed body. The status code is unchanged. A request without a valid administrator session behaves exactly as today. | Unit with fake session resolver: admin gets detail, user and anonymous do not; the fixed bodies are unchanged. |
| FR-AEX-007 | **Same values as the command.** For one environment the page's lines and environment warnings equal the CLI report (same function, same input). A test builds both from one environment and compares them. | Test. |

### 4.3 Non-functional
- Report and warnings are built from data already in memory; the page adds no network or disk reads beyond one settings read and the sink status.
- Strings through the i18n layer; keyboard operable; axe clean in both themes; phone width without horizontal scroll.
- The banner must not appear for direct or stateless installs (no administrators).

## 5. Code style
```ts
// src/server/exposure.ts (shape, not final): keep text and add an id
export type ExposureWarning = { id: string; text: string }
export type ExposureReport = { lines: [string, string][]; warnings: string[]; items: ExposureWarning[] } // `warnings` stays for the CLI
```
`warnings` (texts) stays exactly as today so the CLI, the startup log and `tests/exposure.test.ts` do not change; `items` carries the ids.

## 6. Testing strategy
- Unit (vitest): ids, runtime warnings, acknowledgement lifecycle, loopback rule, readiness branch, report equality of page and CLI.
- Mock layer: `auth-ui-exposure.spec.ts` (page, banner, acknowledge, role gate, axe, phone width).
- Live: `auth-live-exposure.spec.ts` on a built server bound to a non-loopback test address is not possible on every machine; the live spec uses the loopback bind with an `https` public origin (the existing fixtures) and checks the page, the status block, the acknowledgement row in the audit log, and the readiness detail with an administrator cookie.
- Not tested: a real public interface.

## 7. Boundaries
- **Always:** build the page from `buildExposure`; keep CLI output unchanged; audit acknowledgements; keep secrets out of every line.
- **Ask first:** any warning that blocks use, persistence of acknowledgements across restarts, a new dependency, changing existing warning texts.
- **Never:** hide a warning permanently; show key material or secret file paths; give an unauthenticated caller more than today.

## 8. Success criteria
1. Page and CLI show the same lines and environment warnings for one environment.
2. The four runtime warnings are computed from state and appear on the page and the banner on non-loopback installs.
3. Acknowledging writes `exposure.ack` first, clears the banner count, and a restart brings the warning back.
4. An administrator session gets readiness detail; others do not.
5. Non-administrators get the denied page; the banner is never shown to them.
6. `docs/deploy.md` mentions the page, the banner and the acknowledgement rule.

## 9. Plan sketch (for review, not yet a plan)
1. Warning ids and `items` in `buildExposure`, equality test (001, 007).
2. Runtime warnings and acknowledgement memory with audit (002, 005).
3. Server functions, readiness branch (003, 006).
4. Page and banner, mock layer and specs (003, 004).
5. Live spec, deploy note, acceptance walk-through.

## 10. Open questions for the owner
| # | Question | Recommendation |
|---|---|---|
| Q1 | Warnings beyond today's list: no enforced second factor, setup still open, degraded audit sink, and "administration pages reachable from any address" (while `admin-plane` is deferred). Add them, page and banner only? | Yes to all four; they come from SEC-TGT-125 and the owner's deferral decision. Page and banner only; the CLI keeps its environment-only list and gains nothing that needs the store. |
| Q2 | Acknowledgement kept in memory for the process life (gone after restart), audited as a required write. | Yes: ST-032 says "re-shown after restart"; a required audit row keeps silencing accountable. |
| Q3 | Banner on all admin pages and the connection home, non-blocking. | Yes. |
| Q4 | ST-021 asks for an ENV switch (default off) for readiness detail, metrics and version. The built endpoint already gives loopback peers detail with no switch (FR-SVR-010). Add the switch now? | No. Add the administrator-session branch only; the ST-021 switch and metrics belong with `hardening`. Note it in `SPEC/FUTURE.md`. |
| Q5 | Show the readiness-style status block (ready, mode, store, schema version, version, sink) on the page? | Yes, read only, no new endpoint. |
| Q6 | No acknowledgement step-up (the effect is a banner that returns after restart and an audit row). | Agree: no step-up. |

## 11. Notes for `docs/deploy.md`
Describe `/admin/exposure`, the banner rule (non-loopback binds only), that acknowledgements last until the next restart, that administrators can read `/api/ready` detail with their session, and that the page itself warns while administration pages are open to any address.
