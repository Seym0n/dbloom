# Review wave 2 - README.md, 00-overview.md, 09-diagrams.md

Owner scope: only these three files were edited. Evidence rule: code only (source `doc/` ignored). Edits are marked "(corrected in review wave 2)" or "(added in review wave 2)"; no ID was renumbered.

## 1. README.md
- Type legend replaced by a table: intended meaning versus actual usage (UI is written `UI`, not `UI/UX`; CPT is "compatibility" in 01/02/03/05 but "concept" in 06 and mixed in 07/08; DEP also means dependency in 03/07; `CC` is a subsystem token in 00, not a type; `DEV` and `I18N` are not defined).
- Subsystem code table added (CC, CFG, SRV, DTB, IOX, SAU, PLG, UIX, DEP -> file) plus the numbering-block, range-shorthand and duplicate-topic conventions.
- The 08 owner renamed the ten subsystem-less IDs (`DEP-090` ... `DEP-162` -> `DEP-DEP-nnn`) and retyped the two DEV IDs during wave 2; README and 00-overview were aligned to that final state (no remaining special case).
- "Review waves" section added, pointing to `reviews/` and explaining the markers.

## 2. 00-overview.md
- Section 3 re-measured with a script from the files as they are now (IDs that open a bullet, heading or table row; ranges and references not counted): 01=107, 02=138, 03=117, 04=101, 05=124, 06=98, 07=118, 08=107, total 910 (wave-1 table: 752); 00 itself has 21 IDs. Per-type columns added. The counts will drift if other owners keep adding IDs; the script is deterministic (pattern `TYPE[-SUBSYS]-NNN`) and was re-run last.
- NFR-CC-007 kept, cross-referenced to FR-CFG-013 and FR-CFG-095 (authoritative), flagged as an overlap not to be counted twice.
- Added cross-cutting requirements: SEC-CC-017 (`isSuperUser()` = can read `mysql.user`, not `SUPER`; verified at `DatabaseInterface.php:1746-1766`, consumer `SqlController.php:155-159`), SEC-CC-018 (cookie encryption is sodium secretbox / XSalsa20-Poly1305, key rules, `paragonie/sodium_compat` required and `ext-sodium` only suggested; `Crypto.php` is URL-query encryption), CON-CC-019 (`config.default.php` is a non-loaded mirror; effective defaults from `Settings`; refers CON-CFG-106/107), CPT-CC-020 (PHP `^7.2.5 || ^8.0`, `PHP_VERSION_ID < 70205`, Bootstrap 5.3.8 at `package.json:19`, jQuery 3.7.1), INT-CC-021 (XML export needs a database, PDF needs TCPDF + curl, "Excel" is a CSV dialect and not XLSX, `UploadSession` is never selected so session upload progress does not work).
- Section 4 items 4 and 5 extended (2FA backends, Bootstrap version); section 5 rewritten to document the real type usage.
- New section 6: table of 25 known code defects/weaknesses, each with the requirement that records it, evidence and file. Sources: all wave-1 logs and the other wave-2 logs. The wave-1 suspicion "status quick-link flush sends GET" is listed as refuted (02 wave-2 log). The 25 rows were checked for ID existence by the generator script (it aborts if an ID is missing).
- New section 7: ID-to-file index (ranges per `TYPE-SUBSYS`) for all 910+21 IDs, plus the list of overlapping requirement groups.
- Claims checked in the three files: "XML/PDF export always available", "Excel = XLSX", "session upload progress works", "SUPER privilege", "config.default.php loaded", "Bootstrap 5.0", "PHP 7.1/7.2.0", "AES cookie encryption": none of them was present in 00/09/README after wave 1; they are now stated correctly (positively) in INT-CC-021, SEC-CC-017/018, CON-CC-019, CPT-CC-020 and in 09.

## 3. 09-diagrams.md
Corrected (code-verified in wave 2):
- 9.4 class diagram: `exportMetadata()` added (`ExportPlugin.php:193`); `ExportExcel` drawn as a subclass of `ExportCsv`; notes on conditional availability (`ExportXml.php:551-557`, `ExportPdf.php:334-337`, `Plugins.php:60-73,119-150`) and on upload backends (`Import/Ajax.php:42-60`: `UploadSession` never selected); 2FA text states that `application` is TOTP only (the plugin description string still says HOTP).
- 9.5 ER: re-checked `la_tracking`, `la_pdf_pages` (PK `page_nr` only), `la_table_coords`, `la_navigationhiding` against the DDL; cross-references to the new views.
- 9.6: link to the new 2FA view; note that credential cookies are issued before 2FA.
- 9.8 and 9.12: the SQL tab / query box posts to `/import` (`templates/sql/query.twig:1`, `ImportController.php:149-173`), not to `/sql`; `/sql` never splits statements; statement queue/50th-statement behaviour (`Import.php:222-262`) and `/import/simulate-dml` noted. This corrects an implicit assumption of the wave-1 diagram.
Added:
- 9.16 2FA sequence (TOTP window, WebAuthn assertion checks, no signature verification in `CustomServer`: the signature is decoded at `CustomServer.php:372` but never verified; server choice `WebauthnLibServer` vs `CustomServer`).
- 9.17 tracking capture sequence and `la_tracking` entity (hook in `DatabaseInterface::tryQuery`, `/*NOTRACK*/`, `FIND_IN_SET`).
- 9.18 designer pages/coordinates/settings entities and the global-name quirk.
- 9.19 server route catalogue (compared with `libraries/routes.php:145-203`; matches FR-SRV-057).
- 9.20 plugin selection/availability flow and upload-backend selection.
Not changed after check: 9.1-9.3, 9.7, 9.9-9.11, 9.13-9.15 (re-read, no divergence found against the facts verified above; deep line-by-line re-verification of 9.9 class members was not repeated).
Mermaid syntax was not rendered here (no renderer available); diagrams follow the syntax of the wave-1 diagrams.

## 4. Open items for other owners (not edited)
- `06-plugins.md` (CPT) and 04: ensure FR-IOX-001 "13 always, XML/PDF conditional" wording stays consistent with INT-CC-021 (it did at time of writing).
- Several files still cite `libraries/config.default.php` for defaults (see wave2-config-server.md section 3); valid values, but CON-CFG-107 is the preferred source.
- `08-deployment-docs.md` FR-DEP-055 wording "AES" was reported by the security reviewer; the 08 reviewer says it was aligned; not re-checked by me.
- FR-SAU-006 text still says "all failed logins" although the code does not log captcha/password-length rejections (listed in the defect table).
- Possible duplicate: SEC-SAU-319/320/323 repeat SEC-SRV-004 / SEC-DTB-005 / FR-SRV-017 (cross-referenced in the defect table).
