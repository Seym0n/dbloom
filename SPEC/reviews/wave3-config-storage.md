# Wave 3 - configuration storage (01-configuration.md section 10)

Scope: six topics from the discussion (storage tables, setup, lookup, connection model, fallback/notice, layout persistence). Only `01-configuration.md` edited.

## Added (all marked "added in review wave 3")
DATA-CFG-108 (19 tables, scope per user/shared, DDL lines), DEP-CFG-109 (manual setup), FR-CFG-110 (CheckRelationsController, error 1044, DDL from create_tables.sql, not gated by ZeroConf), CON-CFG-111 (config.inc.php never written - definitive), FR-CFG-112 (lookup order, persistence of discovered DB via session cache), INT-CFG-113 (control connection model, fallback when control connection fails), SEC-CFG-114 (AllowArbitraryServer default false, login field, control credentials sent to typed host), FR-CFG-115 (session fallback, exact banner text, home-page incomplete-storage message), INT-CFG-116 (browser storage inventory), NFR-CFG-117 (degradation matrix), FR-CFG-118 (what UI action writes to which table; never-persisted state).

## Corrected / refined (marked)
CPT-CFG-071 (pointer), CON-CFG-072 (corrected: controller does not check ZeroConf), INT-CFG-083 (clarified), gap item 13.

## Findings that differ from the conflict file (10-conflicts.md, not edited)
- CF-006: default of AllowArbitraryServer verified false (Settings.php:2383-2389).
- CF-007: config.inc.php is never written; the storage is rediscovered per request (only `legacyadmin` or current DB) and via the session cache.
- CF-001: "Designer unavailable" is too strong; layouts fall back to browser IndexedDB (database.js:59-73, init.js:47). Also bookmarks have a shared mode (user = '').
- CF-008: localStorage is not an automatic fallback for preferences, but favourites (copy), NavigationWidth, Console options, monitor charts, saved query use it.
- Extra: with AllowArbitraryServer and controluser configured, controluser/controlpass are sent to the typed host (controlhost empty).
- Extra: wrong/unreachable controluser silently falls back to a second login-user connection.
- Extra: in-app created database gets server-default charset, not utf8/utf8_bin of the script.

## Not verified (no runtime)
All "Verification" lines are derived from code reading, not executed.
