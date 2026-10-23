# 15 — Triage of the open LegacyAdmin issues

**Status: DRAFT, machine-triaged, not reviewed by the owner.** Result of the request to check whether the open issues of LegacyAdmin are reflected in the SPEC or matter for DBLoom (`OPEN.md` item 21). The full register is `reviews/wave6-open-issues-triage.tsv`.

## 1. Method and limits

- **Input:** all 852 open issues of `legacyadmin/legacyadmin` on 2026-10-23, read with the `gh` client. The number differs from the 823 quoted by the owner (probably counted at another time). Pull requests are not included. For each issue the title, labels, date, comment count and the first 700 characters of the body were used. Comments were not read.
- **Triage:** 17 subagents on the Haiku model, 50 issues each, each reading the SPEC (files 00 to 14) with keyword searches. Each gave one verdict per issue: COVERED (a SPEC ID already covers it), GAP-BUG (a legacy defect the SPEC does not mention), GAP-FEATURE (a request the SPEC does not mention), IRRELEVANT, or UNCLEAR. Issue text was treated as untrusted data.
- **Checks after the run:** every issue has exactly one verdict (852 of 852, no duplicates, none missing). The orchestrator spot-checked 30 rows (14 GAP-BUG, 8 COVERED, 8 IRRELEVANT) and flagged rows mechanically (below). **The verdicts were not otherwise reviewed.**
- **Known error classes:**
  - **PHP or build specifics counted as defects.** 195 rows mention PHP, Twig, Composer, deprecations, jQuery, webpack or similar; 48 of them are GAP-BUG or GAP-FEATURE and probably belong under IRRELEVANT (column `flags` = `php-or-build`). The keyword match is crude, so some are real defects. They are flagged, not removed.
  - **Wrong references.** #19915 (AI assistant) was marked COVERED by FR-TGT-210 to 214, but those are the dropped vector requirements; the AI sidebar is `OPEN.md` item 19. #19261 (error when viewing a VECTOR column) is covered only by the decision to drop vectors. Both are flagged `wrong-ref`.
  - **Truncated bodies.** Several verdicts rest on the title and 700 characters; some agents said so.
- **Proposed requirements:** the "DBLoom shall" sentences in the register are the wording of the agents, not SPEC requirements.

## 2. Result

| Verdict | Count |
|---|---|
| COVERED | 127 |
| GAP-BUG | 291 |
| GAP-FEATURE | 188 |
| IRRELEVANT | 202 |
| UNCLEAR | 44 |
| Total | 852 |

By area:

| Area | COVERED | GAP-BUG | GAP-FEATURE | IRRELEVANT | UNCLEAR |
|---|---|---|---|---|---|
| behaviour | 43 | 84 | 35 | 16 | 20 |
| data | 17 | 109 | 24 | 8 | 6 |
| ui | 28 | 75 | 112 | 32 | 10 |
| security | 37 | 23 | 15 | 9 | 2 |
| other | 2 | 0 | 2 | 137 | 6 |

479 issues (291 bugs, 188 features) are marked as not reflected in the SPEC. The share of bugs (about a third) is higher than a "conservative" instruction should give, which is one more reason to read the register before using it.

## 3. Priority candidates

GAP-BUG or GAP-FEATURE rows without the PHP flag that carry a `confirmed` label or have at least 8 comments: 132. The 40 with the most comments:

| Issue | Verdict | Area | Comments | Title |
|---|---|---|---|---|
| #6267 | GAP-FEATURE | behaviour | 58 | Filling random test data in database |
| #14371 | GAP-BUG | data | 53 | Support expressions (functions) for field defaults (table definition), ALTER, INSERT, CREATE? |
| #17963 | GAP-BUG | behaviour | 42 | Sql connection errors |
| #14956 | GAP-FEATURE | data | 32 | Implement Page/Column Compression options |
| #16664 | GAP-BUG | data | 30 | Errors copying database: multiple primary keys |
| #15541 | GAP-BUG | security | 25 | restrict some types of uploads |
| #11983 | GAP-FEATURE | ui | 24 | Feature-Request: Pop-Out SQL Window |
| #12340 | GAP-FEATURE | ui | 23 | Request method to specify columns displayed in selected Designer tables |
| #15491 | GAP-FEATURE | security | 22 | Generate password complexity setting |
| #16084 | GAP-BUG | behaviour | 21 | Filters are applied after pagination in list of tables within database |
| #16013 | GAP-FEATURE | data | 21 | Be more friendly with binary uuid |
| #15777 | GAP-FEATURE | ui | 21 | Table grouping doesn't work |
| #15821 | GAP-BUG | data | 20 | ANSI_QUOTES - Mysql 8: Relations (foreign key constraints) not shown |
| #15387 | GAP-BUG | data | 19 | browse doesn't show all records |
| #14719 | GAP-FEATURE | ui | 19 | Create user form should support auth_socket by disabling password input |
| #13488 | GAP-BUG | behaviour | 19 | Cannot inline edit when a join is used in 4.7.2, works fine in 4.2.5 |
| #18162 | GAP-BUG | ui | 18 | Navigation panel settings icon issues |
| #17505 | GAP-BUG | ui | 18 | Unable to un fold the tree |
| #15242 | GAP-FEATURE | ui | 17 | Allow for tables and views in same branch in navigation tree view |
| #19962 | GAP-FEATURE | data | 16 | [Feat]: Import/Export Excel (Office Open XML) Files |
| #19556 | GAP-FEATURE | behaviour | 16 | Move default search operator for varchar columns into configurable options |
| #19368 | GAP-BUG | data | 16 | \r\n is replaced with \n when clicking on a value |
| #14507 | GAP-FEATURE | ui | 16 | Feature: Save width of columns |
| #19069 | GAP-BUG | behaviour | 15 | Status variables documentation links to dev.mysql.com are invalid |
| #16506 | GAP-BUG | behaviour | 15 | hide_db seems to not work |
| #16459 | GAP-BUG | security | 15 | Session problem on two servers on one IP and two ports |
| #20271 | GAP-BUG | ui | 14 | [Bug]: Filtered list of tables reduces on selecting tab |
| #17412 | GAP-BUG | ui | 14 | Unable to make primary key in structure section (more button) |
| #14159 | GAP-FEATURE | ui | 14 | Remove Backspace functionality |
| #12115 | GAP-BUG | data | 14 | Avoid removing invalid value for relations |
| #18130 | GAP-FEATURE | ui | 13 | Order by DESC as default on first click on column  |
| #16069 | GAP-BUG | security | 13 | Setting ssl_ca results in OpenSSL error. |
| #12167 | GAP-FEATURE | ui | 13 | Action column position |
| #6311 | GAP-FEATURE | ui | 13 | Export progress bar |
| #19614 | GAP-BUG | behaviour | 12 | Search, then Refresh -> loses search clauses |
| #15467 | GAP-FEATURE | ui | 12 | Confirm on insert new record |
| #15285 | GAP-FEATURE | behaviour | 12 | Disable SQL_CALC_FOUND_ROWS |
| #12277 | GAP-BUG | data | 12 | Visual enum editor adds extra (blank) values |
| #12237 | GAP-FEATURE | ui | 12 | Improve notification after drag and drop import |
| #18637 | GAP-FEATURE | ui | 11 | Check "Retain query box" by default |

## 4. Follow-up

The 132 priority candidates of section 3 were reviewed and turned into proposed requirements in `16-issue-requirements.md`. The 44 UNCLEAR rows were skipped by decision. The remaining 347 gap rows were then read in full (not only 700 characters) and handled in `17-issue-requirements-batch2.md`; the 48 PHP-flagged gap rows and the 44 UNCLEAR rows are the only ones not reviewed.

## 5. Open points

- The PHP-flagged gap rows that were not priority candidates, and the UNCLEAR rows, have not been reviewed.
- Re-run the flagged rows (`php-or-build`, `wrong-ref`) with the full issue text and comments. The 44 UNCLEAR rows are skipped by decision.
- Decide the disposition of the GAP rows together with the scope work (`OPEN.md` item 1).
