# Review log wave 1 - 01-configuration.md

Reviewer scope: `E:\dbloom\SPEC\01-configuration.md` only. Evidence checked against `legacy-release` (source `doc/` ignored).

## 1. Method
- Re-read all of `Config.php`, `Validator.php`, `ConfigFile.php`, `UserPreferences.php`, `ServerConfigChecks.php`, `ConfigGenerator.php`, `FormProcessing.php`, `Setup/Index.php`, the setup controllers, `setup/*.php`, `Common.php::run`, `config.values.php`, `Settings\Server` and `Settings` setters (defaults extracted programmatically), `VersionInformation`, `HttpRequest`, `Relation` (cache/zero-conf), `ManageController`.
- Spot-checked about 45 requirements (target was 15).

## 2. Findings and fixes (existing IDs, all marked "(corrected in review wave 1)")
| ID | Finding | Fix |
|---|---|---|
| FR-CFG-001 | Omitted that `Servers` is stripped from defaults, that config.inc.php values are merged raw, and cited wrong lines (Common.php 287-294). | Rewritten; correct lines; services.php container link. |
| FR-CFG-002 | `baseSettings` is snapshotted after `checkSystem()` (includes runtime facts), not only after the file merge. | Rewritten. |
| FR-CFG-005 | "reject/silently discard" ambiguous. | Silent discard. |
| FR-CFG-009 | Claimed `load()` returns false on include failure; it returns true (false only for missing/unreadable source). | Rewritten, added `[conferr]` iframe behaviour. |
| CON-CFG-020 | "lowercase-SHA-like MD5" nonsense; matching rules imprecise. | Precise match order, ServerDefault default 1. |
| FR-CFG-021 | Did not say invalid index is kept and error is E_USER_WARNING on PHP >= 8.4. | Added. |
| DATA-CFG-022, CON-CFG-024, DATA-CFG-025, DATA-CFG-026 | Claimed coercion/whitelisting of config.inc.php values by `Settings`; `Settings` is only ever built with `[]` (Config.php:312, ConfigFile.php:93). Also DATA-CFG-025 misdescribed storage-table semantics (any value is string-cast). | Corrected; defaults for SignonCookieParams added. |
| DATA-CFG-023 | Defaults incomplete. | Full server default list. |
| CON-CFG-027 | `OBGZip` misspelt, citation range too short, list incomplete. | Fixed to `OBGzip`, 21-369, fuller enum list. |
| DATA-CFG-028 | Minor citation tightening. | Updated. |
| FR-CFG-012 | `$isMinimumCommon` / server 0 behaviour missing. | Added. |
| FR-CFG-035, FR-CFG-036 | Type derivation not specified; validation vs save-time errors conflated (semantic validation never blocks save). | Clarified. |
| FR-CFG-040, FR-CFG-041 | validate() also returns `true`; assignment list incomplete/wrong (Import regexes, extra numeric validators), typo "regex-funded". | Rewritten with exact lists, messages, limits. |
| FR-CFG-044 | Output for no-validator case is JSON-encoded string. | Fixed. |
| FR-CFG-047, FR-CFG-048 | "exactly four pages / home" naming; edit/revert keep non-existent id. | Fixed. |
| FR-CFG-053 | `strtr('*/','-')` replaces only `*`, not `*/`. | Fixed. |
| FR-CFG-056 | Insecure-connection notice is unconditional; version-check outcomes unspecified. | Fixed. |
| SEC-CFG-058/060/061/062/063/064/065 | Severity (notice vs error), conditions (AllowRoot AND AllowNoPassword; ssl falsy; Store != 0), TempDir notice always shown, show_config_errors does no refusal, CookieSameSite default Strict. | Fixed. |
| FR-CFG-068/070, DATA-CFG-069, CPT-CFG-071 | Dangling citation form `libs.../Relation.php`; 19 tables vs 18 feature classes; zero-conf probe order. | Full paths, corrected counts. |
| FR-CFG-073 | Pruning evidence missing (Table.php). | Added. |
| FR-CFG-075 | Claimed entry files refuse without `LEGACYADMIN`; show_config_errors/setup entry files define it. | Fixed. |
| FR-CFG-077 | `OBGZip` spelling, browser list, upload fallback precision. | Fixed. |
| NFR-CFG-082, INT-CFG-083 | Garbled wording; | Rewritten. |
| INT-CFG-084 | Said `Core::run()`; it is `Common::run()`; "force re-read" is only a comment. | Fixed. |
| Coverage | Wrong path `libraries/controllers/CheckRelationsController.php`. | Corrected. |
| Gaps | Dogmatic-mode remark dropped; MemoryLimit gap resolved; new gaps 10-11 added. | Rewritten. |

## 3. New requirements (all "(added in review wave 1)")
DEP-CFG-085, DEP-CFG-086, DEP-CFG-087, FR-CFG-088, INT-CFG-089 (vendor config, autoloader, sample file, bootstrap order, connection params);
DATA-CFG-090..094 (directive groups with defaults and valid ranges: general/runtime, login/cookie/captcha, navigation, browse/edit, language/theme/titles);
FR-CFG-095..098 (user-preference stores, pages/routes, manage import/export, Config get/set);
FR-CFG-099, UI-CFG-100 (setup wizard flow, form notation);
FR-CFG-101, INT-CFG-102, SEC-CFG-103, SEC-CFG-104 (version check, proxy settings, TrustedProxies, blowfish_secret handling);
NFR-CFG-105 (error behaviour summary for missing/invalid config);
CON-CFG-106 (config.default.php is a non-loaded mirror guarded by a unit test).

## 4. Unresolved / cross-file issues
1. Mixed ID prefixes: several FR-type behaviours carry CON/CPT/UI prefixes (CON-CFG-020, CPT-CFG-071, CON-CFG-072, CON-CFG-024). Left unchanged (no renumbering allowed); a later wave may re-type them.
2. `NFR-CC-007` (00-overview.md:28) duplicates FR-CFG-013/FR-CFG-095; consider cross-referencing.
3. Several other SPEC files reference `libraries/config.default.php` as the source of defaults (00, 03, 04, 05, 06, 07, 08). It exists but is not loaded at runtime; the effective source is `Config/Settings.php`. See CON-CFG-106. 03-database-table.md cites CON-CFG-027 for the MaxRows list - still valid.
4. Doc statements in the security/auth files about `blowfish_secret` and `Core::getIp` should reference SEC-CFG-104 / SEC-CFG-103 and not restate with different values; not verified in those files.
5. `Settings` sub-objects (`Export`, `Import`, `Schema`, `SQLQuery`, `Console`, `Transformations`) defaults not enumerated (see Gaps #2); 04-io-formats.md may be the right home.
6. Because `config.inc.php` values bypass `Settings` coercion (DATA-CFG-022), any other SPEC file claiming "invalid values fall back to default" for user-config values should be re-checked.
