# FUTURE — Ideas deferred beyond the first release

Ideas that were discussed and deliberately postponed. They are **not requirements** and carry no commitment. Each entry records the idea, why it was deferred, and what it would change, so it can be picked up later without redoing the discussion.

| ID | Idea | Origin | Deferred because |
|---|---|---|---|
| FU-001 | Key-holder shared profiles (user private key unlocks a shared connection) | Owner proposal, discussion of CF-010 | Too complex for now (owner decision) |
| FU-002 | Public/private key architecture for the shared-profile master key (connection broker, KMS/HSM) | Discussion of SEC-TGT-027 | Depends on the technology stack; symmetric master key chosen for now |
| FU-003 | Passkey (WebAuthn PRF) unlock of the personal vault | Discussion of SEC-TGT-026 | Browser/authenticator support varies; passphrase and recovery key chosen for now |
| FU-004 | Short-lived credentials from a secrets manager or cloud IAM (option D) | CF-010 | Deferred in the decision itself |
| FU-005 | Shared connection profiles (option C) with a server-managed master key | CF-010, SEC-TGT-025, SEC-TGT-027 | Implementation of the shared-profile master key is not part of the first release (owner decision) |
| FU-006 | Plugin system for third-party extensions | SEC-TGT-113 | First release uses a closed, built-in registry (owner statement, to be confirmed) |
| FU-007 | Multiple DBLoom instances (scaling and high availability) | DEP-TGT-150 | Single instance per deployment (owner decision) |
| FU-008 | Further target databases (PostgreSQL, MongoDB) | `OPEN.md` item 2 | First release supports MySQL and MariaDB only (owner decision) |
| FU-009 | Features requested in open LegacyAdmin issues, deferred | `16-issue-requirements.md` | Not needed for the first release; proposed by the issue review, to be confirmed |
| FU-010 | Legacy LegacyAdmin features postponed: replication UI, tracking, designer, GIS editor, single sign-on, charts | `18-scope-triage.md` | Owner decision of 2026-10-23: not in the first release |

---

## FU-001 — Key-holder shared profiles
**Idea (owner):** Like a PuTTY/SSH key pair: a shared connection's service-account credentials are encrypted so that only holders of an authorised private key can decrypt them. To connect with a shared connection, the user supplies their private key (file or keystore), and DBLoom uses it to unlock the credentials for that session. Several users can be authorised for one profile, each with their own key pair (multi-recipient encryption, as in PGP or the `age` tool).

**Benefits**
- A stolen database, backup or server at rest yields nothing: no key that can decrypt exists on the server.
- Access is per user and cryptographic; revoking a user removes their wrapped copy.

**Costs and risks recorded in discussion**
- If the user uploads the private key, the server sees it for that moment; decrypting in the browser avoids that but then the browser holds the plaintext password.
- Users holding a key who can obtain the encrypted record could decrypt the service-account password offline and bypass DBLoom roles and audit. This contradicts the decided property that users never see the password (CF-010, option C).
- Revocation is not enough: someone who once decrypted the password still knows it; the service account's password must also be changed on the database server.
- Adding a user needs someone who can already decrypt, to re-wrap the record key for the new public key.
- SSH/PuTTY keys are meant for signing; encrypting to them needs a deliberate key-format choice (some tools such as `age` accept SSH keys, to be verified).
- Operational burden: users must safeguard private keys; a lost key needs administrator re-authorisation.

**Possible shape if revived:** an optional stricter variant "C-key" for high-security servers, alongside the server-managed shared profile, not replacing it.

**Related decided requirements:** SEC-TGT-027 (shared profiles use a server-managed master key), SEC-TGT-025.

---

## FU-002 — Public/private key architecture for the shared-profile master key
**Idea:** Split the master key into a public key that can only lock (kept on the web tier) and a private key that can unlock (kept elsewhere), for example with a libsodium sealed box.

**Benefit:** The component that stores shared profiles cannot read them.

**Only useful when** unlocking is done by a separate component: a small connection broker holding the private key, or a KMS/HSM that unlocks on request. With one DBLoom process doing both, the private key must be available at runtime and the gain over a symmetric key is small.

**Why deferred:** The choice depends on the technology stack (`OPEN.md` item 2). The first release uses a single symmetric master key. Wrapping and unwrapping should sit behind a small interface so that this can be introduced later cheaply.

**Related:** SEC-TGT-027, `OPEN.md` item 14.

---

## FU-003 — Passkey (WebAuthn PRF) unlock of the personal vault
**Idea:** Request the WebAuthn PRF extension in the login ceremony so that one passkey touch both logs in and unlocks the user's personal vault, with no passphrase typed.

**Notes**
- Support depends on browser, operating system and authenticator; to be checked at design time.
- The secret belongs to one passkey; a robust design wraps the same vault key under each registered passkey, and keeps the passphrase and recovery key as fallbacks.
- The server still holds the vault key in memory during the session.

**Related:** SEC-TGT-026 (passphrase and recovery key are the decided methods).

---

## FU-004 — Short-lived credentials (option D)
**Idea:** Obtain short-lived database credentials per connection from a secrets manager or cloud IAM, so no long-lived password is stored.

**Why deferred:** Decided as deferred in CF-010. More integration work; not every database server supports it.

**Related:** CF-010, SEC-TGT-024.

---

## FU-005 — Shared connection profiles (option C)
**Idea:** An administrator defines a connection profile (host, port, optional default database, TLS settings, service-account username and password). Users select it by name and never see the password; DBLoom injects it server-side (CF-010, option C).

**Why deferred:** It depends on a server-managed master key, and implementing that master key is not part of the first release (owner decision). The first release therefore supports credential options A (entered per connection) and B (personal profiles with a vault passphrase and recovery key) only.

**Design recorded so far (not committed)**
- A random record key per profile encrypts the username and password; the record key is locked by a single symmetric master key held outside the DBLoom store (environment, key file, secret manager, KMS, or entered at startup; not decided). The master key is never written to the store, backups or logs.
- Wrapping and unwrapping should sit behind a small interface so that KMS, a connection broker or public/private key variants (FU-001, FU-002) can be introduced later.
- Rotation re-locks the record keys only. The key must be backed up separately from the data; losing it makes every shared profile unreadable.
- A new user has no access to any shared profile until an administrator grants it. With a shared profile the target database sees only the service account, so connections must be attributed to the DBLoom user in the audit log.
- Open questions that come with it: which roles may use which profile, whether users may override a shared profile with their own credentials, where the master key comes from, and the rotation procedure.

**Related requirements (deferred with it):** SEC-TGT-025, SEC-TGT-027, SEC-TGT-106; formerly `OPEN.md` items 14 (shared part) and 15.

---

## FU-006 — Plugin system for third-party extensions
**Idea:** Allow third parties to add import/export formats, display transformations or other features as plugins.

**Why deferred:** A plugin system means loading code that is not part of the core, which is the root of the legacy file-inclusion class of defects (SEC-TGT-113). The first release uses a closed, built-in registry. If revived, it needs a defined plugin API, a signing or review process, isolation and a permission model.

**Status:** Interpretation of the owner's statement "no dynamic code loading means plugin system"; to be confirmed.

**Related:** SEC-TGT-113, `06-plugins.md` (legacy plugin framework).

---

## FU-007 — Multiple DBLoom instances (scaling and high availability)
**Idea:** Run several DBLoom instances behind a load balancer, for capacity or availability.

**Why deferred:** The owner decided that a deployment has a single instance (DEP-TGT-150). Multi-instance operation would need shared session and rate-limit state, a consistent view of `.env` settings across instances, key and secret distribution, and coordination of store migrations.

**Related:** DEP-TGT-150, SEC-TGT-017 and SEC-TGT-131 (rate limiting), `OPEN.md` item 2.

---

## FU-008 — Further target databases (PostgreSQL, MongoDB)
**Idea:** Let DBLoom connect to and manage PostgreSQL and MongoDB in addition to MySQL and MariaDB.

**Why deferred:** The first release supports MySQL and MariaDB only (owner decision), which matches the legacy scope. Each further database needs its own Node.js driver and its own handling of statement timeouts and multi-statement control. MongoDB is not relational, so the table, row, SQL and structure screens do not carry over and need a separate design. The target-database layer is built behind an adapter interface (ARCH-TGT-001) so this stays possible without changing existing code.

**Related:** `OPEN.md` item 2, ARCH-TGT-001 in `11-target-security.md` (database-adapter interface), `reviews/wave4-settings-targets-data.md` (driver-dependent items).

---

## FU-009 — Features requested in open LegacyAdmin issues, deferred
**Idea:** Capabilities that users of LegacyAdmin asked for repeatedly (issue numbers in brackets): choose tables before importing a dump (#6022); generate random test data that respects constraints (#6267); drag a column to another table (#6317); pop-out SQL window (#11983); choose the columns shown in the designer (#12340); visual editor for relations and views (#13082); Excel (XLSX) import and export (#19962); confirm before inserting on Enter (#15467); deep links from status variables to the right manual anchor (#19069).

**Why deferred:** Each is a feature on top of the legacy scope, and the scope decision (`OPEN.md` item 1) is still open. The designer items depend on whether the designer is kept at all.

**Status:** Proposed by the review in `16-issue-requirements.md`; not confirmed by the owner.

**Related:** `15-open-issues-triage.md`, `OPEN.md` item 21.

---

## FU-010 — Legacy features postponed beyond the first release
**Idea:** Six features of LegacyAdmin that DBLoom does not offer at first (owner decision, 2026-10-23, on the proposal of `18-scope-triage.md`):
- **Replication UI:** set up and control primary/replica replication from the web page (FR-SRV-004, 024 to 028, 076, 077, CPT-SRV-003, SEC-SRV-003, DATA-SRV-009).
- **Tracking:** version tracking of structure and data changes of a table (FR-DTB-110 to 114, 150, 151, CPT-DTB-002, DATA-DTB-004).
- **Designer:** visual diagram of tables and relations, with internal relations and schema diagram export (FR-DTB-066, 101, 120 to 124, DATA-DTB-005, FR-PLG-013, DATA-PLG-005, FR-UIX-063). Together with the designer items of FU-009.
- **GIS editor and visualisation:** edit and show spatial data (FR-IOX-067, 068, 098, 099).
- **Single sign-on:** another application logs the user in (FR-SAU-013, 016, 018). Needs a design first; a standard protocol such as OpenID Connect is the likely shape (not decided).
- **Charts:** chart of result data (FR-UIX-059).

**Why deferred:** Large or niche features, not needed to replace the daily work of LegacyAdmin; each needs its own design. Several overlap with ideas for the AI sidebar (`OPEN.md` item 19).

**Related:** `18-scope-triage.md` section 3, FU-009.

## FU-011 — Faster CSV import with LOAD DATA
**Idea:** Offer CSV import through `LOAD DATA [LOCAL] INFILE` as a speed option next to the batched parameterised INSERT path (FR-IOX-046, 092, DATA-ISS-137 of module `io`). Needs: `local_infile` enabled on the server (off by default on MySQL 8.4), the driver's local-file stream hook limited to the one staged upload, field and line terminators from fixed allow-lists, no compressed or charset-converted input, and a benchmark that shows the gain (NFR-ISS-102).

**Why deferred:** Owner decision, 2026-10-27: not in the first slice. The INSERT path works on every server and exposes no server-side file reading.

**Related:** `25-module-io.md` Q2.

## FU-admin-plane: administration plane (module `admin-plane`)

**Idea:** Admin routes and admin sign-in only from `DBLOOM_ADMIN_NETWORKS` (SEC-TGT-147, ST-013), address allow/deny rules UI (ST-011, 012, 014). Today the variable is read only by the setup wizard.

**Why deferred:** Owner decision, 2026-11-03: not in the first admin release. Admin pages are protected by the admin role and step-up only; `docs/deploy.md` must say that administrators reach them from any address until this ships.

**Related:** `28-admin-capability-map.md`, `29-module-admin-audit.md` assumption 6.

## FU-user-notices: new-location notice to the affected user

**Idea:** Once the notice detector of `admin-users` exists, also tell the user about a sign-in from a new location on their own account.

**Why deferred:** FR-TGT-149 names administrators only (owner decision 2026-11-03, `30-module-admin-users.md` Q2).

**Related:** `30-module-admin-users.md`.

## FU-ready-switch: readiness detail switch and metrics (ST-021)

**Idea:** ENV switch (default off) for readiness detail, metrics and version, content for loopback or an administrator session.

**Why deferred:** Owner decision 2026-11-03: `admin-exposure` adds only the administrator-session branch of `/api/ready`; the switch and metrics belong with `hardening` (`31-module-admin-exposure.md` Q4).

**Related:** `27-module-server.md` FR-SVR-010.

## FU-settings-ext: settings of target policy, io, history and display on the settings page

**Idea:** Register the remaining "UI within ENV bounds" rows of `12-settings.md` (sections 3.3 to 3.5: target allow and deny, timeouts, row caps, upload and export limits, history, version check, language) in the settings registry so the page edits them.

**Why deferred:** Their consumers read the environment (`Config`) directly, so a stored value would change nothing. Each owning module must first read its value through the settings resolver; the registry and page then take the key with no change (owner decision 2026-11-03, `32-module-admin-settings.md` Q1).

**Related:** `32-module-admin-settings.md`, `12-settings.md` ST-101 to ST-164, ST-209 to ST-215.

## FU-settings-transfer: settings export and import (ST-220)

**Idea:** Export the settings as versioned JSON and import them again, each key validated against the same limits, one audit entry per key, no step-up bypass.

**Why deferred:** Not needed for the first administrator release (`32-module-admin-settings.md` section 9).

**Related:** `12-settings.md` ST-220.

## FU-settings-per-key-limits: operator limits per setting

**Idea:** Environment variables that set the lowest and highest value of a single setting (SEC-TGT-142 as written), beyond the fixed bounds and the lock list.

**Why deferred:** Owner decision 2026-11-03 (`32-module-admin-settings.md` Q2): about 70 more variables for little gain; `DBLOOM_SETTINGS_LOCK` is the operator's fence.

**Related:** `32-module-admin-settings.md`, `12-settings.md` section 2.
