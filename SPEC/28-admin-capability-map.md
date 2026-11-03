# 28 — Capability map: `admin` (split into six modules)

**Status: APPROVED by the owner (2026-11-03) with these decisions: Q1 no (admin-plane is NOT in the first admin release, deferred), Q2 to Q10 as recommended.** Written with the spec-driven-development skill (Phase 0). The capability map of SPEC/21 section 0 has one module `admin` ("Users, settings UI, audit viewer"). The inventory in `reviews/admin-scope.md` (40 rows, seven groups A to G) shows it bundles capabilities that ship and test separately, so it is split before any module spec is written. No spec, plan or code for these modules exists yet; each module gets its own `29-...` file after this map is approved.

## 1. Map

| Module id | Responsibility | Groups, main IDs | Depends on |
|---|---|---|---|
| admin-audit | Audit store (SQLite table, retention, no UI delete or edit), audit write that can abort a change, viewer, export with step-up, external sink | C: NFR-TGT-090, NFR-TGT-107, FR-AUT-027 storage, ST-092, ST-204 to 206 | auth-account, server |
| admin-plane (**deferred**, owner 2026-11-03) | Administration plane: admin routes and admin sign-in only from `DBLOOM_ADMIN_NETWORKS`; address allow/deny rules UI hook | F: SEC-TGT-147, ST-011 to 014 | auth-account, server (client address, gate slot) |
| admin-users | Users screen completion (disable, delete, role change, issue recovery link, invites), notices for administrators, site notice and banner | D+E: FR-TGT-105, FR-AUT-028, FR-AUT-016 UI, ST-085 display, FR-TGT-149, ST-207, ST-216 to 219 | admin-audit, admin-plane |
| admin-exposure | Exposure and status page: exposure report and warnings from `buildExposure`, acknowledgement (audited, re-shown after restart), `/api/ready` detail for an administrator session | G: SEC-TGT-125, ST-032, FR-TGT-146, FR-SVR-010, ST-021 | admin-audit, admin-plane |
| admin-settings | Settings editor: one generalised resolver over all ST rows, stored/effective/source display, write validation, locks, narrowing preview | A: FR-TGT-141, SEC-TGT-142, SEC-TGT-150, NFR-TGT-145, ST-056 preview, ST ranges for auth, target, io, display, site | admin-audit, admin-plane |
| admin-protect | Change protection for settings: step-up set, lockout warning with affected-user count, auto-revert with persisted deadline (cooling-off deferred) | B: SEC-TGT-143, ST-093, ST-034, ST-035, SEC-TGT-144 | admin-settings, admin-audit |

Build order: admin-audit and admin-plane (independent, either first) → admin-users and admin-exposure (independent) → admin-settings → admin-protect.

Dependency direction runs one way; `admin-audit` and `admin-plane` depend only on already built modules. The contract each provider gives lives in its own spec: `admin-audit` exposes an audit writer whose failure the caller can treat as fatal; `admin-plane` exposes one check "is this request from an administration network" used by routes and sign-in.

Left out of the six on purpose: FR-SRV-042 (drop the same-named database on user delete; see question 8) and the `hardening` items (CSP, allow/deny rule evaluation, rate limits), which stay with the `hardening` module.

## 2. Why this split
- Each module has its own data and its own test: audit rows, address checks, user actions, the exposure page, setting writes, pending changes.
- `admin-audit` is first because NFR-TGT-145 and ST-092 make a failed audit write abort a settings change; settings cannot be finished honestly without it. Audit today is stdout JSON only (`src/server/audit.ts`).
- `admin-plane` is first because SEC-TGT-147 is only enforced for the setup wizard today; no admin page should ship before routes and admin sign-in are restricted.
- `admin-users` is the smallest visible gain (services and server functions already exist; only the page has buttons missing) and can ship early.
- `admin-protect` is separate because it needs a persisted pending-change table and a timer, and it can be cut or delayed without touching the settings editor.

## 3. Assumptions (correct me now)
1. Account mode has the SQLite store; direct mode has no store, so audit goes to stdout (or the external sink) and the settings page is read-only with source `.env` (SEC-TGT-150).
2. DBLoom roles stay `admin` and `user` (SPEC/26 Q4).
3. "UI within ENV bounds" means the existing precedence: `.env` limit > stored value > `.env` default > built-in (SPEC/26 section on settings).
4. The `hardening` module is not part of this map and may come before or after.
5. No commit and no new dependency without a go.

## 4. Questions for the owner
Recommendations are the assistant's; 1 to 3, 5 and 8 change the map or module scope.

| # | Question | Recommendation |
|---|---|---|
| 1 | Ship admin-plane enforcement in the first admin release? | Yes, before any admin UI is exposed. |
| 2 | Settings outside auth (target policy, io, display): extend the auth resolver to all ST rows, or one resolver per module? | One generalised resolver, same table meaning. |
| 3 | Where does the audit store live? | SQLite table in the account store; direct mode stdout or external sink only. |
| 4 | ST-204 retention default conflict (365 d in SPEC/12:199 vs 90 d noted for AS-96). | 365 d, range 90 to 1095. |
| 5 | Cooling-off for loosening changes (ST-036, marked PROPOSED, default unclear): in the first release? | Defer to FUTURE.md; keep auto-revert (ST-035). |
| 6 | Auto-revert storage. | A `pending_settings` table with an absolute deadline; timer plus startup sweep. |
| 7 | Settings page in direct mode. | Read-only, source `.env`. |
| 8 | FR-SRV-042 (drop same-named database on user delete) needs a user-to-database mapping SPEC/26 does not define. | Drop from admin scope; account mode has no such mapping. |
| 9 | ST-014 per-role address rules vs SEC-TGT-147 (admin role follows ST-013 only, no per-user rules). | Roles-only UI for non-admin roles, as decided before. |
| 10 | Overlap of `/api/ready` detail (FR-SVR-010) and the exposure page (FR-TGT-146). | Both read the same `buildExposure` data. |

## 5. Owner decisions (2026-11-03)
- Q1: **No.** Administration-network enforcement (`admin-plane`, SEC-TGT-147, ST-011 to 014) is deferred out of the first admin release. Admin pages are protected by the admin role (and step-up where a spec says so) only. Consequences: `admin-plane` leaves the build order and the dependencies of the other modules; Q9 (ST-014 per-role rules) falls with it; the deploy guide must state that administrators reach admin pages from any address until it ships; FUTURE.md records the deferral. The module stays in this map as `deferred`.
- Q2 to Q10: as recommended (one generalised resolver; audit table in account mode; 365 days; cooling-off deferred; `pending_settings` table; settings read-only in direct mode; FR-SRV-042 out of scope; ready detail and exposure page share `buildExposure`). The owner wrote "the other remaining five"; the assistant read it as all questions other than Q1 (the five map-changing ones were 1, 2, 3, 5, 8). Correct this if only some were meant.

## 6. Build order after the decisions
admin-audit, then admin-users and admin-exposure (independent), then admin-settings, then admin-protect. `admin-plane` deferred.

## 7. Next step
After approval of this map (changes to module boundaries, order or the answers above), one module spec per id is written in build order, starting with `admin-audit` and `admin-plane`, each stopping for review before its plan.
