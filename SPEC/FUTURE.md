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
