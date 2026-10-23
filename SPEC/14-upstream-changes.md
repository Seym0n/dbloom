# 14 — Upstream changes after LegacyAdmin 5.2.3 (behaviour, data handling, UI)

**Status: DRAFT, derived from upstream change lists, not from the source tree.** Subsystem code `UPD`. These requirements describe what LegacyAdmin changed after the release the rest of this SPEC describes (5.2.3, 2025-10-08). They are not DBLoom requirements. Their use is to decide, per item, whether DBLoom copies the new behaviour, keeps the old one, or ignores it (see section 6).

**Sources and limits.**
- **5.2.x line:** a triage of the 620 commits on the `QA_5_2` branch after the `RELEASE_5_2_3` tag, plus the pending 5.2.4 ChangeLog, made in an earlier session (transcript `a0a9c080-c06f-4290-8ada-71d002454ba4`, 2026-10-23, via the `gh` client). About 330 commits (translations, CI, tests, lint, release scripts, dependency bumps, internal refactors) were skipped as not user-visible. The numbers in the "Source" column are upstream issue or pull-request numbers as that triage listed them. Where one source cell lists several numbers for several items, the mapping of number to item was not kept and is approximate. The commit texts themselves were not re-read for this file.
- **6.0 line:** `CHANGELOG-6.0.md` on the `master` branch, read on 2026-10-23. LegacyAdmin 6.0 is **not released**: the LegacyAdmin downloads page lists it as "In Development, not yet ready for production use" (PHP 8.2 or newer, below 8.4; MySQL/MariaDB 5.5 or newer), and the changelog still has the date placeholder `YYYY-MM-DD`. Its Fixed, Deprecated and Security sections are **empty**, so no 6.0 bug fixes are listed there. `master` is about 9,346 commits ahead of 5.2.3; those commits were not mined.
- **Evidence rule:** the SPEC rule is "only code of the source tree counts" (`README.md`). These items have no code evidence in the 5.2.3 tree and none was checked in the newer code. Treat every item as "reported by upstream", not as verified behaviour.
- **Relation to DBLoom:** DBLoom is a new implementation (SEC-TGT-110). Most items below concern PHP code that DBLoom does not reuse; they matter as a list of user-visible problems that upstream found and fixed, and as a hint of where the legacy behaviour was wrong.

## 1. Behaviour

| ID | Requirement (upstream, after 5.2.3) | Source |
|---|---|---|
| FR-UPD-001 | Query encryption: encrypted queries shall be sent as POST requests. | 5.2.x #20091 |
| FR-UPD-002 | A warning shall be shown when `$cfg['URLQueryEncryptionSecretKey']` is invalid. | 5.2.x #20092 |
| FR-UPD-003 | Two-factor authentication settings shall be preserved when the user saves a partial set of preferences, for both session and database storage. | 5.2.x #19925 |
| FR-UPD-004 | An invalid `$cfg['Export']['format']` shall no longer silently become `sql`. | 5.2.x #20105 |
| FR-UPD-005 | The Processes page shall hide only `Sleep` processes and inactive `Daemon` processes. | 5.2.x #20255 |
| FR-UPD-006 | The Events page shall be disabled when the event scheduler is off. | 5.2.x #20227 |
| FR-UPD-007 | The SQL mode shall be set for the SQL parser when the connection is made, so the parser matches the server. | 5.2.x #20061 |
| FR-UPD-008 | Users whose password contains a single quote shall be creatable. | 5.2.x #20246 |
| FR-UPD-009 | Role handling on MariaDB and the grant collation error shall be fixed; the user link on the Processes page shall work. | 5.2.x #19879, #19923, #20259 |
| FR-UPD-010 | `innodb_version` shall not be reported as an unknown system variable on MariaDB 10.10 and later. | 5.2.x #20262 |
| FR-UPD-011 | A descending index shall stay descending when edited, and an index shall be addable with a collation. | 5.2.x #19956, #19749 |
| FR-UPD-012 | Renaming a timestamp column shall work. | 5.2.x #19740 |
| FR-UPD-013 | The count of rows shown shall be right when a column alias shadows a column name; the inline-edit confirmation shall show the right query. | 5.2.x #20278, #20279 |
| FR-UPD-014 | Role based authentication shall be supported for MySQL 8.x and compatible servers. | 6.0 #18812 |
| FR-UPD-015 | SET queries shall be roll-back-able. | 6.0 #18349 |
| FR-UPD-016 | The `SHA2` function shall be supported. | 6.0 #17809 |
| FR-UPD-017 | Shared bookmarks shall be switchable with `$cfg['AllowSharedBookmarks']` (default true). | 6.0 #18223 |
| FR-UPD-018 | Database server info and web server info shall be separately configurable with `$cfg['ShowServerInfo']`. | 6.0 #18225 |
| FR-UPD-019 | The Routines page shall have paging. | 6.0 #16500 |
| FR-UPD-020 | Deleting a foreign key shall keep the user on the same page. | 6.0 #19651 |
| FR-UPD-021 | The query generator shall support `BETWEEN` and `NOT BETWEEN`, prevent duplicate `IN`/`NOT IN` values, simplify the `IN`/`NOT IN` criteria text, hide input that does not fit the chosen operator, and disable the search input on unary operators; the operators `= ''` and `!= ''` shall be made more obvious. | 6.0 #19352, #19327, #19294, #19513, #19536, #19542 |
| FR-UPD-022 | The security header `Permissions-Policy` shall be sent. | 6.0 #17009 |
| FR-UPD-023 | The Captcha setting shall also work with Cloudflare Turnstile (an example is provided); the label "reCaptcha" is replaced by "Captcha". | 6.0 #18098, #18365 |
| FR-UPD-024 | Top-menu links shall force a full page reload, and the navigation sidebar links shall not use AJAX. | 6.0 #18136, #18652 |
| FR-UPD-025 | PSR-15 middleware shall be supported, and `Application::run()` is wrapped by an HTTP handler; connection errors are raised as exceptions instead of warnings. | 6.0 #18589, #18576, #17399 |
| FR-UPD-026 | Removed: the Query-By-Example feature, the auto-saved-query warning popup, "Drop Protocol version", and the `public/show_config_errors.php` file. | 6.0 #18430, #19408, #19409, #18587 |

## 2. Data handling

| ID | Requirement (upstream, after 5.2.3) | Source |
|---|---|---|
| DATA-UPD-001 | Export: geometry and binary fields shall be exported in the XML, PHP, MediaWiki, Texy!, CSV, YAML and LaTeX formats. The PDF export shall show `[GEOMETRY]` and `[BLOB]`. Geometry values shall not be quoted. | 5.2.x #20131, #19942 |
| DATA-UPD-002 | Trigger exports shall include `DELIMITER $$`. | 5.2.x #20131, #19942 (mapping approximate) |
| DATA-UPD-003 | Data-only exports shall skip `CREATE DATABASE`. | 5.2.x #19084 |
| DATA-UPD-004 | Export file names shall allow more characters, and compressed columns shall be detected on MariaDB. | 5.2.x #20240 (mapping approximate) |
| DATA-UPD-005 | Import: a CSV with more decimals than the column has shall not cause an error. | 5.2.x #19966 |
| DATA-UPD-006 | Import: a CSV column whose content exceeds the maximum length shall become `TEXT` instead of `VARCHAR`. | 5.2.x #19939 |
| DATA-UPD-007 | Import: numeric strings shall be kept as strings in XML imports; XML import shall work with no database selected and shall handle binary and geometry columns. | 5.2.x #20284, #20170, #20132 |
| DATA-UPD-008 | Types: `VECTOR` columns shall be creatable and changeable and have a description; `XMLTYPE` and `INET4` shall be supported; `UUID_v4()` and `UUID_v7()` shall be recognised; JSON columns shall work on MariaDB. | 5.2.x #19970, #20150 |
| DATA-UPD-009 | The configuration-storage (`la_*`) tables shall be created with `utf8mb4`. | 5.2.x |
| DATA-UPD-010 | Privacy: map tiles shall be loaded from openstreetmap.org with the required referrer; the user-agent shall be null when not defined. | 5.2.x #20241 |
| DATA-UPD-011 | The `pma` user shall be in only one group, and the user name shall be escaped in the group lookup. | 5.2.x #20163, #20165 |
| DATA-UPD-012 | Database search shall optionally support binary data. | 6.0 #19287 |
| DATA-UPD-013 | Import: `INSERT IGNORE INTO` shall be supported for imports that are not table imports. | 6.0 #19525 |
| DATA-UPD-014 | JSON exports shall use the content type `application/json` instead of `text/plain`. | 6.0 #19398 |
| DATA-UPD-015 | ODS exports shall include column headers by default. | 6.0 #19947 |
| DATA-UPD-016 | Search input field types shall match the column types (integer and float); integer fields shall use `inputmode` numeric. | 6.0 #17765, #17753 |

## 3. User interface

| ID | Requirement (upstream, after 5.2.3) | Source |
|---|---|---|
| UI-UPD-001 | EXPLAIN and ANALYZE query results shall have a Refresh button; a loading overlay shall be shown during export. | 5.2.x #20087 |
| UI-UPD-002 | Clicking a table name shall browse from the first row; table comments shall be shown as preformatted text; the grid-edit hint shall be shown for truncated values. | 5.2.x #19946, #19944, #20161 |
| UI-UPD-003 | Autocomplete suggestions shall be sorted and limited to the screen height. | 5.2.x #20227 |
| UI-UPD-004 | Lao shall be added as a language. | 5.2.x |
| UI-UPD-005 | Theme colour modes shall be supported, with a colour-mode toggle in the top navigation bar. | 6.0 #18257, #18649 |
| UI-UPD-006 | A user account menu button shall be at the top right. | 6.0 #18799 |
| UI-UPD-007 | The Change Password, Add Index and Page settings dialogs shall be modals, and the Change Password modal UI improved. | 6.0 #17116, #17125, #17127, #17561 |
| UI-UPD-008 | The SQL message card shall be redesigned, the NULL display improved, theme card heights improved, and the Settings export page made responsive. | 6.0 #18439, #17278, #17280, #17801 |
| UI-UPD-009 | The User Groups form and the database and table privileges pages shall be redesigned. | 6.0 (commits 835fc27, 624126e) |
| UI-UPD-010 | The SQL box shall offer "Format as a single line"; routine, event and trigger editors shall have a format button; the query generator shall have a Copy Query button. | 6.0 #19308, #18916, #19555 |
| UI-UPD-011 | Export as text shall have a copy-to-clipboard button. | 6.0 #18537 |
| UI-UPD-012 | Browse shall show a formatted number for Total; the insert-row table shall have a Go button at the top; table views shall have show-create-table shortcuts; the table comment field shall be a textarea. | 6.0 #18668, #19751, #19812, #19564 |
| UI-UPD-013 | The main page shall show the host name. | 6.0 #19691 |
| UI-UPD-014 | Charts shall use Chart.js instead of jqPlot; the SVG GIS viewer mouse-wheel zoom direction is inverted; jQuery UI tooltips are replaced by Bootstrap tooltips. | 6.0 #19214, #18124, #19550 |
| UI-UPD-015 | Smaller changes: textareas resize vertically only; label column width is minimised in Routine, Event and Trigger modals and limited in create-view; better tab key handling on the login form. | 6.0 #18311, #18310, #18703, #17632 |

## 4. Platform and build (not user-visible behaviour)

| ID | Requirement (upstream, after 5.2.3) | Source |
|---|---|---|
| CPT-UPD-001 | 5.2.x: PHP 8.5 and 8.6 deprecations fixed, PHP 8.6 supported, Twig 3.27 allowed. | 5.2.x #19883 and others |
| CPT-UPD-002 | 6.0: minimum PHP 8.2.0 (the downloads page says below 8.4), Node 20 for the build, the PHP sodium extension required, BaconQrCode v2 dropped, the Recode extension dropped. | 6.0 #19243, #19852, #17752, #19854, #18547 |
| CPT-UPD-003 | 6.0: webpack bundler, JavaScript converted to TypeScript, new directory structure, public files moved to `public/`, `composer.lock` under version control, `url.php` and `js/messages.php` turned into routes. | 6.0 #17361, #18300, #18512, #18145, #18747, #17676, #17677 |
| CPT-UPD-004 | 6.0: minimum database server stays MySQL/MariaDB 5.5 (per the downloads page). | legacyadmin.net/downloads |

## 5. Considered and skipped

- **5.2.x, optional fixes:** JavaScript and CodeMirror errors (`data is undefined`), the Firefox and Chromium drag-and-drop difference, stale grid-edit state after an AJAX refresh, less memory for simulate-query, a cached foreign-key display lookup, `LIMIT 1` and `LIMIT 0` on some metadata queries. Recorded only here, not as requirements.
- **Not user-visible:** tests, PHPUnit 9 to 13, Windows CI, coverage, lint, psalm baselines, `create-release.sh`, Yarn and composer bumps, Selenium, the InnoDB methods, `DbiDummy`, docs typos, credits and Weblate translation commits.
- **6.0, internal:** refactors of file-import name generation, recent and favourite tables buttons and the GIS editor modal; bumps of `js-cookie`, OpenLayers and similar libraries; CODE_OF_CONDUCT. The 6.0 changelog lists no Fixed, Deprecated or Security entries.

## 6. Open points

- **Disposition per item (DBLoom keep, replace or drop)** is not decided; it belongs to the scope work in `OPEN.md` item 1. Items that look most relevant to DBLoom: FR-UPD-014 (roles on MySQL 8), FR-UPD-022 (`Permissions-Policy`, compare SEC-TGT-043), FR-UPD-003 (state lost on partial saves, compare the state-store items 12 and 13), FR-UPD-017 (shared bookmarks switch), DATA-UPD-001 to DATA-UPD-004 (binary and geometry export), DATA-UPD-010 (map tile privacy) and FR-UPD-026 (Query-By-Example removed).
- **Verification:** the commit texts of the 5.2.x line and the 6.0 `master` commits were not read; the 6.0 changelog is a draft and may change before release. Re-check when 6.0.0 is released.
- **6.0 bug fixes:** none are listed in the changelog. Finding them needs a pass through the `master` history after 5.2.3, which has not been done. Say if it should be.
- **Mapping:** the issue numbers in grouped source cells are not tied to single items (see "Sources and limits").
