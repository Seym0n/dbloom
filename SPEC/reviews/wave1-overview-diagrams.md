# Review log wave 1 - 00-overview.md and 09-diagrams.md

Source: legacy-release (code only; `doc/` ignored). Spot-checked well over 15 claims against code (index.php, Common.php, Routing.php, DatabaseInterface.php, Dbal/*, Session.php, Plugins/*, TwoFactor.php, AuthenticationCookie/Plugin, Export/Import/Sql controllers, Footer, Logging, config.default.php, vendor_config.php, constants.php, composer.json, package.json, sql/create_tables.sql, ConfigStorage/*).

## Findings and fixes

### 00-overview.md
1. NFR-CC-003 and CON-CC-006 cited `doc/` (forbidden evidence) - replaced with package.json/composer.json/LICENSE evidence (corrected).
2. SEC-CC-002 cited index.php as the include guard; real guards are `! defined('LEGACYADMIN') -> exit` in constants.php, config.values.php, routes.php, vendor_config.php, setup/lib/common.inc.php (corrected).
3. I18N-CC-005 used an undefined type `I18N` and pointed to 06-plugins.md section 6.7 (plugin inventory, unrelated) - renamed UI-CC-005, fixed references (corrected). Note: the old ID I18N-CC-005 is retired, no other file referenced it (grep).
4. NFR-CC-007 claimed cookie fallback; real: la_userconfig or $_SESSION['userconfig'] (corrected).
5. SEC-CC-008 said requests are refused; real: POST params stripped except ajax_request, AJAX gets "Error: Token mismatch"; GET unchecked (corrected).
6. INT-CC-004 lacked limits/error behaviour: added 50500 / "5.5.0", message, MariaDB detection (corrected).
7. NFR-CC-001 given exact message and composer constraint `^7.2.5 || ^8.0`.
8. Section 4 boot order was wrong (preferences before authentication); real order authenticate -> connect -> 2FA -> prefs. Plugin claim "everything is a plugin" was false for Auth/TwoFactor (no `Plugin` interface). Fixed.
9. Facts/counts: 955 PHP files (612 in libraries/classes), 77 JS files in js/src, 24 template folders; requirement count table did not match files (03: 63 vs 101, 06: 56 vs 67, 08: 48 vs 88, total ~520 vs 752) - replaced with measured snapshot.
10. Vague cross-cutting statements made precise.

### 09-diagrams.md
1. 9.1: Bootstrap "5.0" -> 5.3.8; control connection is always opened (controluser or second user link), not only with config storage; "955 classes" -> 612.
2. 9.2: controller-folder list was wrong (Status/Variables etc. are nested); Relation is in `ConfigStorage\Relation`; Tracker hook is in DatabaseInterface::tryQuery; boot order corrected.
3. 9.3: user preferences were drawn before authenticate; connection and 404/405 branches missing. Redrawn with line cites.
4. 9.4: Plugin interface members wrong (`isAvailable` static, `getProperties(): PluginPropertyItem`); AuthenticationPlugin and TwoFactorPlugin do not implement Plugin; `UploadProviderInterface/UploadProviderUpload` do not exist (real: UploadInterface, UploadNoplugin/Progress/Session); `exportSchema(TableSchema)` is `exportSchema($db): bool`; inventory lists were garbled (Htmlword/Odt/Texytext/Shp/Sql missing, "YAML Xml", fictitious Schema_*). Transformation count 26 -> 27. Redrawn.
5. 9.5 ER: schema has no foreign keys; most relation edges were invented; many columns wrong (usergroups.tab_allowed, relation.db_name, savedsearches, tracking, history). Rebuilt from DDL for all 19 tables with PK/UK.
6. 9.6 state: did not match code (no SessionExpired/Invalid2FA path). Rebuilt from authenticate/checkRules/connect/checkTwoFactor/logout.
7. 9.7 export: "Obeng target" nonsense, wrong controller namespace; redrawn from ExportController.
8. 9.8 SQL: Tracker was drawn called from ParseAnalyze; real hook is DatabaseInterface::tryQuery; history comes from Footer::setHistory -> Relation::setHistory. Redrawn.
9. 9.9 class: methods that do not exist (`getDbList`, `tryConnect`, `free`, `DbiMysqli.query`); DatabaseInterface holds DbiExtension; redrawn.
10. 9.10: routes cache lives in `libraries/cache/` (vendor_config.php:71), tmp/ is TEMP_DIR with twig cache; fixed.

## New IDs
- 00-overview.md: SEC-CC-009, SEC-CC-010, NFR-CC-011, NFR-CC-012, DEP-CC-013, DEP-CC-014, NFR-CC-015, NFR-CC-016 (all "added in review wave 1"). UI-CC-005 is a renamed ID.
- 09-diagrams.md: new views 9.12 (import sequence), 9.13 (route dispatch/cache state), 9.14 (config-storage feature map), 9.15 (Dbal layering).

## Unresolved / cross-file issues
- README.md: lists type "UI/UX" but IDs use "UI"; README says CC type is "used in 00-overview.md" while overview IDs use TYPE-CC-NNN - consider documenting this in README (I did not edit it).
- Other files citing `doc/*` (e.g. 07-frontend.md DEP-UIX-084 cites doc/themes.rst; 08-deployment-docs.md likely) must replace that evidence.
- 03-database-table.md: its ID grep shows 101 IDs but no line-start bullet pattern - check formatting consistency.
- 06-plugins.md has 76 ID lines but 67 unique IDs - possible duplicate IDs; section 6.4 title "credibility of a latent enumerations" is garbled.
- 05-security-auth.md / 04-io: check plugin inventories against Plugins/ listing (Transformations 27, Export 15, Import 7, TwoFactor 5) and that TwoFactor 'WebAuthn' is always listed as available.
- 08-deployment-docs.md should state that js/dist and themes/*/css are not in the source tree.
- 01-configuration.md FR-CFG-001 cites Common.php:287-294 for prefs after connection, consistent with this review.
- Requirement counts in 00-overview.md section 3 will drift as other waves add items; recompute at the end.
