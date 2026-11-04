# Acceptance walk-through: module `admin-exposure` (SPEC/31 section 8)

Date: 2026-11-03. Windows 11, Node 24, Chromium via Playwright. Commands: `npx tsc --noEmit`, `npx eslint .`, `npx vitest run` (121 files, 3036 passed, 4 skipped), `npm run test:e2e:auth-ui` (122 passed, of which 13 new), `npm run test:e2e:auth-live` (50 passed, 2 skipped, 4 of them in `auth-live-exposure.spec.ts`), `node scripts/gen-env-docs.mjs --check`, `vite build` (server, then CLI).

| # | Criterion | Result | Evidence and limits |
|---|---|---|---|
| 1 | Page and CLI show the same lines and environment warnings for one environment | Met | `tests/exposure-items.test.ts`: rendered text of the page report equals the command output for three topologies. Live: the command is run with the live server's environment and every line it prints appears on the page. The live server's environment is rebuilt by hand in the spec (it is not exported by the fixture), so a variable the spec forgets would show as a difference. |
| 2 | The four runtime warnings are computed from state and appear on page and banner on non-loopback installs | Met for the computation, the page and the banner rule; the banner itself is not seen live | `tests/exposure-state.test.ts` (each warning, mode rules, banner rule off loopback and on loopback). Live: `no-mfa` and `admin-any-address` on the page of a real server. The live server binds loopback, so the banner is not raised there; the mock layer shows it, and the rule is a pure function with unit tests. The setup-open and degraded-sink warnings are covered by unit tests and the mock layer only. |
| 3 | Acknowledging writes `exposure.ack` first, clears the banner count, and a restart brings the warning back | Met | Unit: audit before record, failing audit refuses, drop-on-resolve, new state after restart. Mock layer: count drops, item stays with who and when, banner gone after all. Live: the row exists with actor and subject, the audit viewer lists it, a server restart shows the warning unacknowledged again and the row stays. |
| 4 | An administrator session gets readiness detail; others do not | Met in unit tests; not separable live | `tests/ready-detail.test.ts` (administrator yes; user, pre-MFA administrator, disabled, demoted, no user, unknown session, failing lookup no; no lookup without the cookie). The live test only shows that the cookie request gets the detail: from a loopback test client the answer would be the same without it, because loopback peers always get detail. |
| 5 | Non-administrators get the denied page; the banner is never shown to them | Met | Mock layer (user: denied page, no banner at home; no session: front page; direct mode: front page). Service role matrix in `tests/exposure-functions.test.ts`. The denied page is not shown to a signed-in ordinary user on the live server. |
| 6 | `docs/deploy.md` mentions the page, the banner, the acknowledgement rule | Met | Section "Exposure page". |

## Findings during the work
- Config warnings needed their own ids (SPEC/31 assumed one id `config`; acknowledging one would have hidden all). The ids are `hsts-off`, `trust-proxy-deprecated`, `debug-logging`, `unknown-variable:<name>` and a hash id for others.
- The wiring of the service is kept on `globalThis` (as the readiness flag) so that acknowledgements are seen by every server bundle.
- `vite build` failed with `EBUSY` several times in a row during task 4; it passed after waiting 20 seconds. Cause not found.
- No client-chunk problem this time: the `exposure.functions` chunk holds no Node references (the import list of that file is pinned by a test).

## Not done or not run
- No test on a public interface (the live fixture binds loopback); the banner on a real non-loopback bind is covered by the rule's unit tests.
- The ST-021 switch for readiness detail and metrics stays with `hardening` (`SPEC/FUTURE.md`, FU-ready-switch).
- The page is reachable by an administrator from any address (admin-plane deferred); the page says so as a warning.
- The mock layer has one fixed report; it does not follow a real configuration.
