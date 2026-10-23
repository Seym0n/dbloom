# Wave 3 review: 2FA, WebAuthn, TOTP window, library versions

Scope: `05-security-auth.md`, `09-diagrams.md` (section 9.16). Related conflicts: CF-003, CF-004, CF-005 in `10-conflicts.md`. All items verified against code in the 5.2.3 tree (no `vendor/`).

| Item | Result | Recorded as |
|---|---|---|
| 2FA enablement (CF-003) | Verified: route `routes.php:141`; remove requires `check(true)` (`TwoFactorController.php:43-52`); `writable` from type `db` (`TwoFactor.php:69`); backends `TwoFactor.php:129-155`; check at `AuthenticationPlugin.php:333`; cache `TwoFactor.php:229-233`. Existing FR-SAU-045..051 and DATA-SAU-047 covered parts; refined, not duplicated. | FR-SAU-209 (new); FR-SAU-048 corrected ("TOTP/HOTP" -> TOTP only) |
| WebAuthn variants (CF-004) | Verified selection `WebAuthn.php:64`; CustomServer has no signature/sign-count check and host-only origin (`CustomServer.php:76-110`); library variant delegates to `loadAndCheckAssertionResponse` (`WebauthnLibServer.php:145-150`), behaviour not verifiable. | FR-SAU-210 (new); FR-SAU-059 corrected (CustomServer only); diagram note in 09 section 9.16 corrected |
| TOTP window (CF-005) | Verified `Application.php:42` `setWindow(8)`; step length in library, 30 s assumed. | SEC-SAU-325 (new) |
| Library versions | `composer.json`: google2fa-qrcode suggest ^2.1 (l.102), dev ^2.1 (119), conflict <2.1 (89); bacon suggest ^2.0 (103), dev ^2.0 or ^3.0 (108), conflict <2.0 (88); u2f-php-server suggest (104), dev ^1.2 (109); webauthn-lib suggest (105), dev ^3.3.2 (126). None in `require`. | DEP-SAU-091 (new) |

Findings beyond the brief: `getMissingDeps()` does not report `web-auth/webauthn-lib` or the XMLWriter/imagick requirement; bacon suggest constraint (^2.0) is narrower than its dev constraint (^2.0 || ^3.0).

Not done: README ID ranges and the 00-overview ID index were not edited (out of the permitted files); new IDs: FR-SAU-209, FR-SAU-210, SEC-SAU-325, DEP-SAU-091 should be added there.
