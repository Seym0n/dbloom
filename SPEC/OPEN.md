# OPEN — Gaps in the SPEC that may block development

Gaps identified after review waves 1 to 3. Conflicts between legacy behaviour and DBLoom needs are tracked separately in `10-conflicts.md`; proposed security requirements are in `11-target-security.md`.

| # | Gap | Status |
|---|---|---|
| 1 | Scope is undefined | OPEN (to be decided in a second session) |
| 2 | DBLoom itself is not specified | OPEN (decided so far: web-based application, no PHP reuse; likely TypeScript/TanStack, tentative) |
| 3 | No end-to-end scenarios | OPEN |
| 4 | Legacy defects have no decisions | OPEN (only Ctrl+K decided, CF-002) |
| 5 | Quantitative targets are mostly absent | OPEN |
| 6 | Verification is unproven | OPEN |
| 7 | UI is described only in words | OPEN |
| 8 | Migration and compatibility | OPEN |
| 9 | Licence | OPEN |
| 10 | Diagram syntax | OPEN |
| 11 | How to normalise the target for the state key | OPEN |
| 12 | Whether the state store is a file or a database | OPEN |
| 13 | How state is stored in account mode | OPEN |
| 14 | Key-management model for stored target credentials | DECIDED for personal profiles; shared profiles deferred (FU-005) |
| 15 | Audit attribution and access rules for shared connection profiles | DEFERRED with shared profiles (FU-005) |
| 16 | Email delivery for invitations and recovery | DECIDED: manual link, no email |
| 17 | Details of the user-management proposals (setup token, forced password change, invite lifetime, password policy) | OPEN |
| 18 | Classification of settings (.env vs administrator UI), floors and ceilings, auto-revert time, notice thresholds | PARTLY DECIDED (classification and rules accepted; numbers and scope/stack items open) |

## 1. Scope is undefined
Status: the owner will decide scope in a second session.
The SPEC has over 900 legacy requirements and says nothing about which ones DBLoom must keep. Only the conflicts have a disposition (retain, replace or drop). This is the biggest gap, because every developer will otherwise guess.

## 2. DBLoom itself is not specified
Decided so far: single instance per deployment (DEP-TGT-150; multi-instance is FUTURE.md FU-007).
Decided so far: DBLoom is a web-based application like LegacyAdmin (SEC-TGT-110). It does not reuse PHP; the stack is likely TypeScript with TanStack (owner statement, tentative, framework parts and versions not fixed). Consequence: PHP-specific legacy requirements (PHP version and extensions, Composer, php.ini, PHP session handling) describe the legacy implementation only; the scope matrix (item 1) must classify them. Still open: technology stack, supported databases and versions, deployment model, target users.
The SPEC doesn't state its technology stack, supported databases and versions, deployment model (self-hosted or hosted), target users, or whether it should look like LegacyAdmin. The legacy requirements assume PHP and MySQL/MariaDB.

## 3. No end-to-end scenarios
There are no user journeys or acceptance scenarios, such as log in, connect, browse, edit a row, export, switch server, session expires. The 9.x sequence diagrams cover only a few. DBLoom's flows (account mode, direct mode, target connect and switch, multi-target sessions, logout, expiry, credentials lifecycle) are not specified at all.

## 4. Legacy defects have no decisions
The overview lists 25 known defects. Only Ctrl+K has been decided. For each, a developer needs "reproduce" or "fix".

## 5. Quantitative targets are mostly absent
Legacy has few concrete performance, size and availability numbers, so DBLoom's NFRs are largely unwritten.

## 6. Verification is unproven
The "Verification:" lines were derived from reading the code and never run. Behaviour that depends on missing libraries is marked unverifiable. Nobody has run the legacy application to capture reference behaviour.

## 7. UI is described only in words
There are no wireframes or flows. Open points include whether to keep the 95 languages, the themes, accessibility targets, and which legacy screens to carry over.

## 8. Migration and compatibility
The SPEC doesn't say whether DBLoom should import existing `la_*` data, or whether export formats must stay compatible.

## 9. Licence
LegacyAdmin is GPL-2.0, and the requirements here were derived by reading its source. Whether DBLoom counts as a derivative work, or needs a clean-room process, is a question for whoever owns the project's legal decisions.

## 10. Diagram syntax
The Mermaid diagrams have never been rendered.

## 11. How to normalise the target for the state key
In direct mode, state is kept in a DBLoom-owned store keyed by target server and username (DATA-TGT-094, CF-009). The rule for turning what the user types into one normalised target (host and port) is not defined.

## 12. Whether the state store is a file or a database
The DBLoom-owned store for state (DATA-TGT-094, CF-009) has no decided type: a file or a database.

## 13. How state is stored in account mode
Where and how preferences, history, bookmarks and layouts are stored in account mode (CF-001, CF-009) is not decided. Only direct mode has a decision so far.

## 14. Key-management model for stored target credentials
Decided (CF-010, SEC-TGT-026): personal profiles use a vault key locked by a separate vault passphrase and a one-time recovery key; passkey (WebAuthn PRF) unlock is a possible later addition (FUTURE.md FU-003). The shared-profile master key is not part of the first release and is deferred to the future (FUTURE.md FU-005, FU-002).

## 15. Audit attribution and access rules for shared connection profiles
Deferred with shared profiles (FUTURE.md FU-005). For shared profiles (option C) the target database sees only the service account (SEC-TGT-025, CF-010). Not decided: which DBLoom roles may use which profile, how connections and statements are attributed to the DBLoom user in the audit log, and whether users may override a shared profile with their own credentials.

## 16. Email delivery for invitations and recovery (decided)
Decided (CF-011): invitation and recovery links are handed over manually by the administrator; DBLoom sends no email, so there is no SMTP dependency.

## 17. Details of the user-management proposals
Marked "proposed detail" in section 11 (the forced password change at first login is decided and no longer listed) of `11-target-security.md` and not yet approved. Since the owner accepted D-04, D-05, D-09 and D-10 (see item 18) the setup token handling (DEP-TGT-100), recovery handling, token strength and the password policy approach (offline breached list) are decided in principle, with numbers still PROPOSED. Still unapproved: the invite default lifetime of 7 days (FR-TGT-104) as a number, and the optional binding of an invite to an email address (not addressed by any decision; no email is sent).

## 18. Classification of settings and limits
Section 14 of `11-target-security.md` fixes the split (deployment settings in `.env`, administrator settings in the UI) and the rules. Direct mode uses `.env` only (confirmed). Second-administrator approval of changes is not needed (decided).

Decided (owner accepted D-01 to D-23 of `12-settings.md` section 6, edits applied to section 11 to 14 of `11-target-security.md`, log in `reviews/wave5-apply-settings-decisions.md`): the classification of settings (`12-settings.md` section 3), the precedence rule (SEC-TGT-150), "Bounded by `.env`" (SEC-TGT-142), step-up for every change, lockout protection with revert timer only for lockout-capable changes and impact preview plus rollback otherwise, administrators always 2FA, per-target throttling in direct mode, setup token and recovery handling, sessions persisted in the store, no sub-path deployment, the inbound outer allow ceiling is PUBLIC by default (D-02; the administration plane stays restricted separately, the default bind stays loopback). Roles only for address rules (D-03).

Still open: (a) all numeric floors, defaults and ceilings (auto-revert period, step-up window, notice thresholds, retention, size and time limits, Argon2id parameters) remain PROPOSED and unverified (no standard looked up, nothing tested); (b) D-08 is decided (passkeys and TOTP are both in the first release; a passkey can be a primary credential); a passkey login with user verification satisfies the enforced-2FA policy by itself (decided; SEC-TGT-014) (the allowed-factors and primary-credential settings ST-056, ST-057 and the 2FA part of lockout protection depend on it); (c) items depending on undecided scope or stack (item 1 and 2): certificate reload, forwarded-header handling of the runtime, one middleware over all route classes, statement-timeout watchdog and driver behaviour, Argon2 and WebAuthn libraries, URL-fragment tokens, memory limit, store type, available modules and languages, target-key normalisation (item 11).
