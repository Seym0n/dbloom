# OPEN — Gaps in the SPEC that may block development

Gaps identified after review waves 1 to 3. Conflicts between legacy behaviour and DBLoom needs are tracked separately in `10-conflicts.md`; proposed security requirements are in `11-target-security.md`.

| # | Gap | Status |
|---|---|---|
| 1 | Scope is undefined | PARTLY DECIDED (DBLoom wording for the 343 ADAPT rows drafted by Haiku in `20-adapted-requirements.md`, 45 UNSURE rows kept as a watch list and not implemented, owner 2026-10-23; the rest unreviewed): `18-scope-triage.md` (946 legacy requirements; owner decided the 23 features on 2026-10-23: 124 keep, 343 adapt, 88 superseded, 342 drop, 49 deferred, 0 open; a sample of 40, a consistency pass of 98 rows and a second review of all 946 rows by Haiku reviewers (18 flags, 10 changed) were done and corrected). The machine decisions on the remaining requirements are proposals the owner has not reviewed one by one |
| 2 | DBLoom itself is not specified | MOSTLY DECIDED (decided so far: web-based application, no PHP reuse; TypeScript with TanStack Start on Node.js confirmed; versions, Docker/Coolify and adapter decided; checks and container tests pending) |
| 3 | No end-to-end scenarios | DRAFTED (`19-scenarios.md`: 11 scenarios, 10 gaps G1 to G10, all decided, six of them by the assistant on the owner's instruction; not reviewed; user administration, import, structure changes, recovery and server screens not yet covered) |
| 4 | Legacy defects have no decisions | PROPOSED: `reviews/legacy-defects-modernization.md` (7 not applicable, 11 fixed by design, 6 must-not-repeat with new wording SEC-TGT-152 to 157, 1 decided: SEC-TGT-151); Ctrl+K decided earlier (CF-002); the owner has not reviewed the other 24 |
| 5 | Quantitative targets are mostly absent | DEFERRED by the owner (2026-10-23: limits and response times "we will see that later") |
| 6 | Verification is unproven | NOT NEEDED (owner, 2026-10-23); requirements keep their verification lines as test ideas |
| 7 | UI is described only in words | MOSTLY DECIDED (English with i18n readiness NFR-TGT-160; React, TanStack and shadcn/ui UI-TGT-003; the screenshot gives the layout): three-area layout (UI-TGT-001); wireframes, languages, accessibility still open |
| 8 | Migration and compatibility | DECIDED: no `la_*` compatibility; some export formats stay compatible (list to be chosen with the scope, item 1) |
| 9 | Licence | PARTLY DECIDED: no copied LegacyAdmin material (CON-TGT-001, decided); licence Apache-2.0 proposed, MIT the alternative, confirm before the first public release; lawyer check advised |
| 10 | Diagram syntax | OPEN |
| 11 | How to normalise the target for the state key | DECIDED: DATA-TGT-095 |
| 12 | Whether the state store is a file or a database | DECIDED: SQLite file on a local volume |
| 13 | How state is stored in account mode | DECIDED: DBLoom SQLite store, per DBLoom user |
| 14 | Key-management model for stored target credentials | DECIDED for personal profiles; shared profiles deferred (FU-005) |
| 15 | Audit attribution and access rules for shared connection profiles | DEFERRED with shared profiles (FU-005) |
| 16 | Email delivery for invitations and recovery | DECIDED: manual link, no email |
| 17 | Details of the user-management proposals (setup token, forced password change, invite lifetime, password policy) | DECIDED for invites (7 days, no email binding); other numbers still PROPOSED |
| 18 | Classification of settings (.env vs administrator UI), floors and ceilings, auto-revert time, notice thresholds | PARTLY DECIDED (classification and rules accepted; numbers and scope/stack items open) |
| 19 | AI sidebar for data insight | OPEN (in the first release, owner decision; details to be discussed later; owner idea: AI "skills" such as schema normalization review replace legacy wizards like the normalization wizard, FR-DTB-140) |
| 21 | Open LegacyAdmin issues versus the SPEC | REVIEWED except 44 unclear and 48 PHP-flagged rows: proposed requirements in `16-issue-requirements.md` and `17-issue-requirements-batch2.md` (not approved) |
| 20 | Features of current MySQL and MariaDB that the legacy SPEC lacks | PROPOSED in `13-new-features.md` (unapproved; vendor facts unverified; subject to item 1) |

## 1. Scope is undefined
Status: the owner will decide scope in a second session.
The SPEC has over 900 legacy requirements and says nothing about which ones DBLoom must keep. Only the conflicts have a disposition (retain, replace or drop). This is the biggest gap, because every developer will otherwise guess.

## 2. DBLoom itself is not specified
Decided so far: single instance per deployment (DEP-TGT-150; multi-instance is FUTURE.md FU-007).
Decided so far: DBLoom is a web-based application like LegacyAdmin (SEC-TGT-110). It does not reuse PHP; the stack is TypeScript with TanStack (owner statement, confirmed; https://tanstack.com/). TanStack Start is the full-stack framework (owner statement, confirmed); the runtime is Node.js (owner statement, confirmed); the other TanStack parts used, the Start host adapter and the versions are not yet fixed. Consequence: PHP-specific legacy requirements (PHP version and extensions, Composer, php.ini, PHP session handling) describe the legacy implementation only; the scope matrix (item 1) must classify them. Decided: the first release supports MySQL and MariaDB only; PostgreSQL and MongoDB are possible later (FUTURE.md FU-008). Decided: DBLoom is self-hosted, like LegacyAdmin (owner statement); each operator runs their own instance and there is no hosted service operated by the project. Decided (owner statement, 2026-10-23): Node.js 22 is the minimum, the owner develops on Node.js 24 (both are tested; LTS releases only) [raised by the owner on 2026-10-27 to Node.js 24.7, for the built-in Argon2id, SPEC/26 Q1; CI tests 24.7 and the current 24]; TanStack Start is used in the latest stable release, pinned to an exact version and upgraded deliberately (checked 2026-10-23: Start has no LTS line; see DEP-TGT-126); the minimum servers are MySQL 8.4 LTS and MariaDB 10.11 LTS (ARCH-TGT-003; the end-of-life dates come from third-party sources and are still to be checked against Oracle and mariadb.org). Decided (owner, 2026-10-23): the MySQL driver is mysql2; still to be confirmed by a test against both MySQL 8.4 and MariaDB 10.11 (TLS, timeouts, multi-statement control). Decided (owner, 2026-10-23): the deployment target is Docker Compose on Coolify; the Start host adapter is the plain Node server output (DEP-TGT-124). Still to be checked: container tests for mysql2 and node:sqlite.
Decided: target users are database administrators, developers, and customers who want insight into their data through an AI sidebar (owner statement). The AI sidebar is new and not covered by the SPEC; see item 19.
The SPEC doesn't state its technology stack, supported databases and versions, deployment model (self-hosted or hosted), target users, or whether it should look like LegacyAdmin. The legacy requirements assume PHP and MySQL/MariaDB.

## 3. No end-to-end scenarios
There are no user journeys or acceptance scenarios, such as log in, connect, browse, edit a row, export, switch server, session expires. The 9.x sequence diagrams cover only a few. First draft (2026-10-23): `19-scenarios.md` holds 11 scenarios with acceptance criteria and 10 gaps G1 to G10; all ten gaps are decided (2026-10-23: G1, G6, G7, G10 by the owner; G2 to G5, G8, G9 by the assistant on the owner's instruction, open to change). DBLoom's flows (account mode, direct mode, target connect and switch, multi-target sessions, logout, expiry, credentials lifecycle) are not specified at all.

## 4. Legacy defects have no decisions
The overview lists 25 known defects. Ctrl+K and SEC-DTB-004 (structured filter builder, SEC-TGT-151) are decided; a Sonnet review of 2026-10-23 proposes a disposition for all 25 (`reviews/legacy-defects-modernization.md`). For each, a developer needs "reproduce" or "fix".

## 5. Quantitative targets are mostly absent
Legacy has few concrete performance, size and availability numbers, so DBLoom's NFRs are largely unwritten.

## 6. Verification is unproven
The "Verification:" lines were derived from reading the code and never run. Behaviour that depends on missing libraries is marked unverifiable. Nobody has run the legacy application to capture reference behaviour.

## 7. UI is described only in words
Decided (owner, 2026-10-23): English first, ready for i18n later (NFR-TGT-160); the UI is React with TanStack libraries and shadcn/ui (UI-TGT-003; the owner's "TanStack UI" is read as the TanStack libraries, to be confirmed). Not decided: accessibility target and browser matrix. The main application is a typical admin-panel layout; the first-run setup is a wizard with five steps: welcome, login mode, site configuration, first administrator, done (UI-TGT-002; step 2 is preselected from `.env` but modifiable, and the step 3 list is decided; the remaining contents are proposals). The rough layout is a left sidebar, tabbed content in the middle (with a SQL tab) and an AI sidebar on the right (UI-TGT-001). There are still no wireframes or flows. Open points include whether to keep the 95 languages, the themes, accessibility targets, and which legacy screens to carry over.

## 8. Migration and compatibility
Decided (owner, 2026-10-23): DBLoom is not backwards compatible with the LegacyAdmin configuration storage. It neither reads, writes nor creates the `la_*` tables or a `legacyadmin` configuration database on a target server, and it offers no import of their contents (bookmarks, history, relations, tracking, designer pages and so on); its own state lives in the DBLoom store (items 12 and 13). Decided (owner, 2026-10-23): some export formats shall stay compatible with the LegacyAdmin output, not all; the formats are chosen in the scope decision (proposal in `18-scope-triage.md`: SQL, CSV, JSON). Existing `la_*` tables on a target are not considered: DBLoom treats them as ordinary tables.

## 9. Licence
LegacyAdmin is GPL-2.0, and the requirements here were derived by reading its source. Whether DBLoom counts as a derivative work, or needs a clean-room process, is a question for whoever owns the project's legal decisions. Owner statement (2026-10-23): DBLoom builds on the requirements (the functions) of LegacyAdmin for a more modern system; it is a new implementation, not a port of the code. Decided (owner, 2026-10-23): the rules of CON-TGT-001 in `11-target-security.md` that keep LegacyAdmin code, templates, translations, images and documentation text out. The licence is a permissive one (AGPL-3.0 was considered and not chosen); Apache-2.0 is proposed (explicit patent grant), MIT is the alternative; the owner was not sure and confirms before the first public release. Not legal advice; a lawyer should confirm if DBLoom is published or sold.

## 10. Diagram syntax
The Mermaid diagrams have never been rendered.

## 11. How to normalise the target for the state key
In direct mode, state is kept in a DBLoom-owned store keyed by target server and username (DATA-TGT-094, CF-009). Specified as DATA-TGT-095 in `11-target-security.md` (owner accepted, 2026-10-23): no DNS resolution, lower-case host, IPv6 and IPv4-mapped forms made canonical, strange IPv4 shorthand rejected, default port 3306, case-sensitive user name, three separate key columns.

## 12. Whether the state store is a file or a database
Decided (owner, 2026-10-23): the store is optional; DBLoom has a stateful and a stateless mode, selected in `.env` (DEP-TGT-125; the consequences listed there are proposals, among them: stateless means direct mode only, in-memory sessions, no saved bookmarks or history). Decided (owner, 2026-10-23): the DBLoom store is a SQLite database in one file on a local volume (Docker: one mounted volume, for example /data; not a network share). Decided (owner, 2026-10-23): the SQLite driver is the built-in node:sqlite (no native build); a test on Node.js 22 and 24 in the Docker image shall confirm that it works there (to be checked: its stability status on both versions, which this SPEC has not verified; better-sqlite3 is the fallback). The store sits behind a small interface so a server database can replace it if several instances are ever wanted (FU-007). Master key and secrets stay outside the volume.

## 13. How state is stored in account mode
Decided (owner, 2026-10-23): in account mode, preferences, layouts, bookmarks and history are stored in the DBLoom SQLite store (item 12), not on the target database server, and belong to the DBLoom user. Each bookmark and history entry records the target it was made on, so it can be filtered by server (owner confirmed, 2026-10-23). Only the key rule for direct mode (item 11) is open.

## 14. Key-management model for stored target credentials
Decided (CF-010, SEC-TGT-026): personal profiles use a vault key locked by a separate vault passphrase and a one-time recovery key; passkey (WebAuthn PRF) unlock is a possible later addition (FUTURE.md FU-003). The shared-profile master key is not part of the first release and is deferred to the future (FUTURE.md FU-005, FU-002).

## 15. Audit attribution and access rules for shared connection profiles
Deferred with shared profiles (FUTURE.md FU-005). For shared profiles (option C) the target database sees only the service account (SEC-TGT-025, CF-010). Not decided: which DBLoom roles may use which profile, how connections and statements are attributed to the DBLoom user in the audit log, and whether users may override a shared profile with their own credentials.

## 16. Email delivery for invitations and recovery (decided)
Decided (CF-011): invitation and recovery links are handed over manually by the administrator; DBLoom sends no email, so there is no SMTP dependency.

## 17. Details of the user-management proposals
Marked "proposed detail" in section 11 (the forced password change at first login is decided and no longer listed) of `11-target-security.md` and not yet approved. Since the owner accepted D-04, D-05, D-09 and D-10 (see item 18) the setup token handling (DEP-TGT-100), recovery handling, token strength and the password policy approach (offline breached list) are decided in principle, with numbers still PROPOSED. Decided (owner, 2026-10-23): an invite link expires after 7 days (FR-TGT-104, ST-081) and is not bound to an email address (ST-083). The recovery-link default (24 h) and the other numbers of item 18 remain proposals.

## 18. Classification of settings and limits
Section 14 of `11-target-security.md` fixes the split (deployment settings in `.env`, administrator settings in the UI) and the rules. Direct mode uses `.env` only (confirmed). Second-administrator approval of changes is not needed (decided).

Decided (owner accepted D-01 to D-23 of `12-settings.md` section 6, edits applied to section 11 to 14 of `11-target-security.md`, log in `reviews/wave5-apply-settings-decisions.md`): the classification of settings (`12-settings.md` section 3), the precedence rule (SEC-TGT-150), "Bounded by `.env`" (SEC-TGT-142), step-up for every change, lockout protection with revert timer only for lockout-capable changes and impact preview plus rollback otherwise, administrators always 2FA, per-target throttling in direct mode, setup token and recovery handling, sessions persisted in the store, no sub-path deployment, the inbound outer allow ceiling is PUBLIC by default (D-02; the administration plane stays restricted separately, the default bind stays loopback). Roles only for address rules (D-03).

Still open: (a) all numeric floors, defaults and ceilings (auto-revert period, step-up window, notice thresholds, retention, size and time limits, Argon2id parameters) remain PROPOSED and unverified (no standard looked up, nothing tested); (b) D-08 is decided (passkeys and TOTP are both in the first release; a passkey can be a primary credential); a passkey login with user verification satisfies the enforced-2FA policy by itself (decided; SEC-TGT-014) (the allowed-factors and primary-credential settings ST-056, ST-057 and the 2FA part of lockout protection depend on it); (c) items depending on undecided scope or stack (item 1 and 2): certificate reload, forwarded-header handling of the runtime, one middleware over all route classes, statement-timeout watchdog and driver behaviour, Argon2 and WebAuthn libraries, URL-fragment tokens, memory limit, store type, available modules and languages, target-key normalisation (item 11).

## 19. AI sidebar for data insight
Owner statement: customers who want insight into their data shall be able to get it through an AI sidebar. Nothing is specified yet. The legacy system has no equivalent. Open points:
- What the sidebar does: answer questions about the schema, write SQL for the user to review, explain query results, or run queries itself. Whether it may change data (default proposal: read-only, and any statement runs only after the user approves it).
- Which AI service: a hosted model API, a self-hosted model, or the operator's choice. This decides whether data leaves the deployment.
- What is sent to the AI: schema only, or also rows and query results. Target data is sensitive and untrusted (SEC-TGT-112), and an AI service may store what it receives. An operator setting to switch the sidebar off, and limits on what may be sent, are likely needed (settings classification, `12-settings.md`).
- Prompt injection: cell values, comments and names come from the target and could carry instructions to the model. The model's output must be treated as untrusted too (SEC-TGT-112, SEC-TGT-117).
- Permissions and audit: the sidebar must act with the user's own rights on the target, never wider, and its statements must appear in the audit log.
- Decided: the AI sidebar does not generate embeddings, and vector columns, indexes and similarity search are not part of DBLoom for now, because embeddings differ from model to model (owner statement; dropped FR-TGT-210 to 214, see `13-new-features.md` section 2).
- Decided: the AI sidebar sits on the right of the main window, closable, expandable to a modal, with a conversation selector and answers that cite their sources (UI-TGT-001, 2026-10-23).
- Decided (owner, 2026-10-23): an OpenAI-compatible API integration that the administrator configures (FR-TGT-251; settings ST-223 to ST-225 proposed). Still open there: prompt-injection rules and the PII screen.
- Decided (owner, 2026-10-23): the assistant writes SQL and runs it through a tool call; the result appears inline as a table with a button to open it in a new tab of the same browser tab (FR-TGT-250). Columns can be marked as PII so that their values are not exposed to the AI (SEC-TGT-158; details proposed: administrator marks per target and column, parser-based detection, rows withheld from the model when a PII column is touched, read-only statements only, audited). Still open: which AI service, what else is sent besides schema and non-PII rows, prompt injection, the operator switch, and the screen for marking PII.
- Decided: the AI sidebar is part of the first release (owner statement). The details are to be discussed in a later session.

## 20. Features of current MySQL and MariaDB that the legacy SPEC lacks
Owner request: write requirements for features that newer MySQL and MariaDB versions offer and LegacyAdmin 5.2.3 does not cover. Proposed in `13-new-features.md` (`FR-TGT-200` to `FR-TGT-243`, vector requirements 210 to 214 dropped by the owner): a capability model, `CHECK` constraints, expression and invisible indexes, CTE and window-function support, explain/analyse, statistics, performance views, system-versioned tables, sequences, new types and `utf8mb4` defaults. Open: approval of each requirement; verification of the vendor facts (only the vector facts were looked up); a check of the legacy code for the parts it may already cover; which features ship in the first release (item 1).

## 21. Open LegacyAdmin issues versus the SPEC
Owner request: check whether the open issues of LegacyAdmin are reflected in the SPEC and which matter for DBLoom. 852 open issues were triaged by 17 Haiku subagents (`15-open-issues-triage.md`, register `reviews/wave6-open-issues-triage.tsv`). The 132 priority candidates were reviewed and turned into proposed requirements in `16-issue-requirements.md` (108 issues accepted into 40 requirements, 9 deferred to FUTURE.md FU-009, 15 dropped); the 44 UNCLEAR rows were skipped by decision. A second review read the full text of the other 347 gap rows (92 older with Sonnet subagents and the orchestrator, 255 newer with Haiku subagents) and produced 145 further proposed requirements after a duplicate and conflict review (35 overlapping issues folded together, 6 conflicts resolved), 71 merges into the first file, 15 covered and 81 dropped (`17-issue-requirements-batch2.md`). Open: owner approval of all these requirements (about 185 in total; the wording of the second batch is machine drafted and overlaps in places); the 44 UNCLEAR rows (skipped by decision) and the 48 rows flagged as PHP or build specific are not reviewed; the disposition of all gaps together with item 1.

- Decided (assistant, on the owner's instruction "fix both", 2026-11-06; open to change): SEC-ISS-001 scopes the session cookie by public port (`__Host-dbloom-session` on 443, `__Host-dbloom-session-<port>` otherwise), and names the reason of a failed target TLS connect in account mode only (error `target_tls`, fixed categories); direct mode keeps the uniform message. Not changed: connection tests of saved profiles still show the generic text.
