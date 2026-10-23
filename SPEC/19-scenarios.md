# 19 — End-to-end scenarios

**Status: first draft (2026-10-23), written by the assistant from the decided requirements; the owner has not reviewed it.** Answer to `OPEN.md` item 3. Each scenario follows one user through a whole task and ends with acceptance criteria that a browser test can check. Where the SPEC gives no answer, the scenario says so and the question is collected in section 3 as a gap; the steps marked *(proposal)* are the assistant's suggestion, not a decision.

Modes: **A** = account mode (log in to DBLoom, then connect to a target), **D** = direct mode (log in with the target server's own account), **S** = stateless store mode (DEP-TGT-125). Layout terms follow UI-TGT-001 (left sidebar, tabs in the centre, assistant on the right).

## 1. Scenarios

### SCN-001 First-run setup (mode A or D; not in stateless mode)
*Actor:* the operator, right after deployment. *Before:* the container runs with `.env`; the setup token is in the console output (DEP-TGT-100).
1. The operator opens the address. DBLoom shows the welcome step with the store mode and the token field (UI-TGT-002 step 1). A wrong token shows the same page again and is rate-limited (DEP-TGT-123).
2. With the right token, step 2 offers direct or account mode, preselected from `.env` if set.
3. Step 3 shows the site configuration with prefilled defaults and the read-only status of the `.env`-only settings, including a check of the public origin against the browser address.
4. Mode A only: step 4 creates the first administrator (user name, password, second factor, recovery codes shown once).
5. Step 5 confirms; the token is consumed and the setup routes return 404.

*Accept when:* nothing is stored before step 5; a second visit to the setup address gives 404; a restart does not show setup again; in stateless mode there is no setup page; the administrator can log in with the new account (SCN-002).
*Requirements:* DEP-TGT-100, 123, 125; UI-TGT-002; SEC-TGT-014, 019.

### SCN-002 Log in to DBLoom (mode A)
*Actor:* a user with an account and a second factor.
1. The user opens DBLoom. The login page names the active mode (SEC-TGT-019) and asks for user name and password.
2. After the password, DBLoom asks for the second factor (passkey or TOTP; recovery code as fallback).
3. On success DBLoom creates a new session (new cookie value, SEC-TGT-040) and shows the connection picker: saved personal profiles and "connect to a new server".
4. On a wrong password or code the page gives one message that does not say which part failed; repeated failures slow down (SEC-TGT-017).

*Accept when:* the session cookie is `__Host-`, `HttpOnly`, `Secure`, `SameSite`; the pre-login cookie value is not accepted after login; five wrong passwords for one account and for one address are delayed, and the response for an unknown user looks the same as for a known one; no credential appears in logs or the audit record (SEC-TGT-023).
*Requirements:* SEC-TGT-010 to 017, 023, 040.

### SCN-003 Connect to a target and switch targets (mode A)
1. The user chooses a saved profile (credential source B, SEC-TGT-024) or types host, port, user name and password (source A). DBLoom normalises the target (DATA-TGT-095) and checks it against the allow-list (SEC-TGT-030).
2. DBLoom connects (TLS verified by default, SEC-TGT-032; connect timeout, SEC-TGT-033). The left sidebar shows the server's databases; the top of the sidebar shows the target name and the DBLoom user.
3. The user opens a second target. Both stay connected in the session (SEC-TGT-010); the user switches between them in the sidebar.
4. A refused host (for example loopback), a wrong password and an unreachable server give the same kind of error text that does not reveal which one it was (DATA-TGT-095, SEC-TGT-031).

*Accept when:* the target password is held only in session memory (source A) and is gone after logout; with source B it is encrypted in the store (SEC-TGT-022); a host on the deny list is refused before any connection is made; the target name is visible on every screen of that target.
*Switching (decided with G6; "Ok", 2026-10-23, closing behaviour as proposed):* a target switcher at the top of the left sidebar shows the current target with a label or colour, lists the targets held by the session and the saved profiles, and offers "Connect to a new server" and, per entry, "Open in new browser tab". Choosing another target changes the target of this browser tab only, reloads the tree and closes the open centre tabs of the old target, after asking if any has unsaved edits or typed SQL. A browser tab keeps its target across a reload (an identifier only, in `sessionStorage`, checked on the server; never credentials, SEC-TGT-021). Disconnecting a target sends tabs that used it back to the connection picker with a message. *Decided (G6):* the active target belongs to the browser tab, not to the session. Each tab shows its target on every screen, and switching in one tab does not change another tab. A request names its target explicitly and is checked against the targets held by the session (SEC-TGT-010, 116).

### SCN-004 Log in directly to a target (mode D)
1. The login page shows server, user name and password, plus the direct-mode warning (SEC-TGT-018).
2. DBLoom normalises the target, checks the allow-list, and tries to connect. On success the session is created and the user lands on the server's database list; DBLoom has no account of its own for this user.
3. Failures look the same whatever the cause; attempts are rate-limited by address and by normalised target and user name, so DBLoom cannot be used to guess passwords of other servers (SEC-TGT-018).

*Accept when:* startup refuses direct mode with free-form targets and no allow-list or acknowledgement setting; no second-factor step appears; stateful mode saves preferences under the key of DATA-TGT-094, stateless mode saves none.
*Requirements:* SEC-TGT-018, 020, 023, 030 to 033; DATA-TGT-094, 095.

### SCN-005 Open a table (A, D)
1. In the left tree the user clicks a table. A new tab opens in the centre showing the data grid (UI-TGT-001): first page of rows, column headers, row selection, sortable columns, long values cut with a way to see the rest.
2. The user sorts by a column, filters rows, and moves to the next page.
3. The user opens the structure view of the same table in another tab.

*Accept when:* all names used in the request were checked against what the server reports (SEC-TGT-116); values are shown escaped, including binary and HTML-looking content (SEC-TGT-070, 112); the SQL that DBLoom ran can be shown; a table the user may not read gives an error from the server, not a DBLoom-level guess (SEC-TGT-062).
*Gap:* G8 (page size, total row count on large tables).

### SCN-006 Edit a row (A, D)
1. In the grid the user edits one cell, or opens the row in a form, and saves.
2. If the connection is read-only (SEC-TGT-052), the edit controls are disabled and say why.
3. DBLoom builds an `UPDATE` with parameters and identifier quoting from the central builder (SEC-TGT-051, 117), identifying the row by the rule of G1 (decided: primary key, else a unique key whose columns are all NOT NULL, else the confirmed single-row edit below), and checks the values in the WHERE clause that the user saw, so a row changed by someone else is not overwritten silently (G2, decided).
4. On success the grid shows the new value and the statement that ran; on a conflict or an error the user sees the server's message and the unchanged data.
5. A delete, or an update that would touch many rows, asks for confirmation through the server-side two-step token (SEC-TGT-052).

*Accept when:* a forged request without the CSRF token changes nothing (SEC-TGT-042); a user without the UPDATE privilege gets the server's refusal; a table with no usable key opens the confirmation of G1 (no key, the exact statement with `LIMIT 1`, the number of matching rows, a hint to add a primary key, no "don't ask again") and the edit is refused when the table has FLOAT/DOUBLE, JSON, geometry or large BLOB/TEXT columns or hidden columns, or is a view; generated columns are never written; two users editing the same row cannot overwrite each other silently once G2 is decided.

### SCN-007 Run SQL in the SQL tab (A, D)
1. The user opens a SQL tab, types one or several statements and runs them.
2. DBLoom applies the read-only guard and the destructive-statement confirmation (SEC-TGT-052), the statement timeout and the maximum result size (same requirement).
3. Results appear as grids, one per result set, with the number of rows and the time taken; errors show the server's message with the position.
4. The statement is added to the history, with its target (DATA-TGT-094), if the store exists; in stateless mode it is kept for the session only.

*Accept when:* a `DROP`, `TRUNCATE`, or `DELETE` without a condition is not run before the confirmation; a statement over the timeout is stopped and the user is told (SEC-TGT-033); SQL text is never stored in the browser (owner decision on stateless mode, DEP-TGT-125).

### SCN-008 Export (A, D)
1. From a table, a result, or a database, the user chooses Export, selects the format (SQL, CSV or JSON, `18-scope-triage.md`), the scope and the options.
2. DBLoom streams the file to the browser; the file name is derived safely from the table or database name and the response sets the type and `Content-Disposition` (SEC-TGT-072).
3. The user can cancel; a failure half-way is shown in the UI and the partial file is not offered as complete (G4, decided).

*Accept when:* a table called `../x";.csv` produces a harmless file name; CSV cells that start with `=`, `+`, `-` or `@` are protected by default as decided in G4; the export of a large table does not load all rows into memory; a read-only connection can export; the export is written to the audit log with user, target and object.
*Requirements:* SEC-TGT-072; formats in `18-scope-triage.md`.

### SCN-009 Session expires (A, D, S)
1. The user is idle. At the idle timeout (default 30 minutes, administrators 15; ST-069) or the absolute lifetime (12 hours, administrators 4; ST-070) the session ends on the server.
2. The next request gets one "session ended" response, identical for an expired, unknown, revoked or forged session (G10, decided), not a half-working page. The page shows a sign-in dialog over the current content (G3, decided) with neutral wording, for example "Your session has ended. Sign in again to continue. Unsaved work on this page is kept." (it never says "because of inactivity"). Typed SQL and unsaved edits stay in the page's memory, are not written to browser storage, and are not sent again automatically.
3. After signing in again (mode A: password and factor; mode D: target credentials), the user can resend the action deliberately. The target connections of the old session were closed and their credentials discarded (SEC-TGT-020).
4. In stateless mode a restart of the DBLoom process ends every session in the same way (DEP-TGT-125) and the user sees the same dialog; while the server is down (a redeploy), the page shows "Server not reachable, retrying" with a bounded number of retries and no sign-in dialog, and the session-ended dialog follows once the server answers (G10, decided).

*Accept when:* an expired session cookie never reaches an application route; the old session cannot be reused after the new login; the expiry is audited; a request that was in flight at expiry is not run with the old credentials.
*Gaps:* G3, G9 (warning before expiry).

### SCN-010 Log out (A, D)
1. The user chooses Log out. DBLoom ends the server-side session, closes all target connections of the session, discards held target credentials, and clears the cookie.
2. Other browser tabs of the same session show the sign-in page on their next request.

*Accept when:* a copy of the old cookie is refused afterwards; the logout is a state-changing request with CSRF protection and not a GET (SEC-TGT-042).

### SCN-011 Ask the assistant (A, D) — sketch
1. The user types a question in the right sidebar, for example "which orders are over 90 days old and unpaid?".
2. The assistant answers using the schema it may see, proposes a query, and cites the tables and columns it used. The user can open the query in a SQL tab to review and run it.
3. The user expands the assistant to the modal for a longer exchange and returns it to the side (UI-TGT-001).

4. The assistant runs the query through a tool call; the result appears inline as a table with the SQL, and a button opens the full result in a new tab of the same browser tab (FR-TGT-250). Values of columns marked as PII are shown to the user but never sent to the AI service (SEC-TGT-158).

*Accept when:* the inline table and the new-tab result show the same rows; a PII column's values never appear in the outbound request to the AI service; the assistant cannot run a data-changing statement; each statement it runs is in the audit log. *Not yet specified:* the AI service, what else is sent besides the schema, and prompt-injection handling (`OPEN.md` item 19).

## 2. Coverage

| Task named by the owner | Scenario |
|---|---|
| log in | SCN-002 (A), SCN-004 (D), SCN-001 (first run) |
| open a table | SCN-005 |
| edit a row | SCN-006 |
| export | SCN-008 |
| session expiry | SCN-009 |
| switch server, log out, run SQL, assistant | SCN-003, SCN-010, SCN-007, SCN-011 |

Not covered yet: user administration (invites, disabling users; FR-TGT-101 to 105), administrator settings and step-up (FR-TGT-141, SEC-TGT-143), import, structure changes (create, alter and drop tables), account recovery, and the other server-level screens (users and privileges, monitor, variables).

## 3. Gaps found by writing the scenarios

Each is a question the SPEC does not answer. The proposal is the assistant's suggestion.

| ID | Gap | Proposal |
|---|---|---|
| G1 | A table without a primary key: how is a row identified for edit and delete? Legacy (5.2.3, checked in `Util.php` and `Sql.php`): a primary key or else a unique key is used; with neither, the row actions (grid edit, Edit, Copy, Delete) are hidden by default with a notice, and only the setting `RowActionLinksWithoutUnique` (default off) enables them, using a WHERE clause on all column values with `LIMIT 1` and a warning of "undesired behavior". | **DECIDED (owner, 2026-10-23, accepted the recommendation of the Opus review).** Primary key; else a UNIQUE key whose columns are all NOT NULL; else the grid is read-only and a single edit needs a per-edit confirmation (the exact statement with `LIMIT 1`, the number of matching rows, a hint to add a primary key, no "don't ask again"). The row count is checked before the write; more than one match is allowed only because every column was compared exactly. Refused (use the SQL tab) when the table has FLOAT/DOUBLE, JSON, geometry or large BLOB/TEXT columns or columns the grid did not select; views are read-only in the grid; generated columns are never written. No administrator setting like LegacyAdmin's `RowActionLinksWithoutUnique`. |
| G2 | Concurrent edits: nothing says a changed row must not be overwritten silently. | **DECIDED (assistant, on the owner's instruction of 2026-10-23 to decide the remaining gaps; the owner may change it).** An edit or delete is written as `UPDATE`/`DELETE` whose WHERE clause holds the key of G1 plus the values the user saw for the columns being changed (all exactly comparable columns for a full-row form). The server's found-rows count is used, not the changed-rows count, so saving an unchanged value is not reported as a conflict (to be tested with `mysql2`). Zero rows: DBLoom re-reads the row and shows "This row was changed by someone else" with the current values, or "This row no longer exists"; the user can reload the row, or overwrite with an explicit second click, which resends with the current values as the old ones. |
| G3 | What the user keeps when the session expires during work. | **DECIDED (assistant, on the owner's instruction of 2026-10-23 to decide the remaining gaps; the owner may change it).** Sign-in dialog over the page; unsaved text and edits stay in page memory only, never in browser storage; nothing is replayed automatically and the CSRF token is renewed at sign-in. After sign-in the user resends deliberately. If a different DBLoom user (account mode) or a different target user (direct mode) signs in, the unsaved work is discarded. |
| G4 | Export of large data: limits, cancel, partial failure, CSV formula characters, export of a result set (not just a table). | **DECIDED (assistant, on the owner's instruction of 2026-10-23 to decide the remaining gaps; the owner may change it).** (1) Exports stream with back-pressure and never hold the whole result in memory. (2) The user can cancel; DBLoom then stops the statement on the target server. (3) A failure half-way ends the response abnormally, so the browser shows a failed download, and the UI shows the error; a partial file is never announced as complete and no length is promised in advance. (4) CSV: cells that begin with `=`, `+`, `-`, `@`, tab or carriage return are protected against spreadsheet formulas by default; the export dialog has a switch to turn that off. (5) A result set or a query can be exported: DBLoom re-runs the statement under the read-only guard, the statement timeout and the export timeout (default 30 minutes, an administrator setting within `.env` bounds); at most two exports per user at a time. (6) The request size cap of ST-018 does not apply to downloads. (7) Every export is audited with user, target, object, format and row count. |
| G5 | The target connection drops while the session lives (server restart, `wait_timeout`). Source A: the password is in session memory, so a silent reconnect is possible; is it allowed? | **DECIDED (assistant, on the owner's instruction of 2026-10-23 to decide the remaining gaps; the owner may change it).** When the target connection is found dead, DBLoom reconnects once silently with the held credentials (source A from session memory, source B from the vault), restores the selected database and the read-only mode, and tells the user if an open transaction or session variables were lost. A statement that failed because the connection dropped is never replayed automatically. If the reconnect fails, the user sees "Connection lost" with a Retry button; there is no retry loop. The same applies in direct mode. |
| G6 | In account mode with several targets, is the active target per session or per browser tab? A session-wide choice lets one tab change what another tab writes to. | **DECIDED (owner, 2026-10-23, option 2).** The active target belongs to the browser tab and is shown on every screen; switching in one tab does not affect another; every request carries its target and the server checks it against the targets of the session. Direct mode has one target, so it does not apply there. |
| G7 | Where the user lands after login: connection picker, last target, or the last tab. | **DECIDED (owner, 2026-10-23), account mode:** after login the user is at the connection picker. Still a proposal: the last used target is preselected, and open tabs are not restored. In direct mode the login already names the target, so the user lands on its database list. |
| G8 | Page size, sorting limits and how the total row count is shown on large tables (exact counts are slow). | **DECIDED (assistant, on the owner's instruction of 2026-10-23 to decide the remaining gaps; the owner may change it).** Default page size 50, choices 25, 50, 100, 250 and 500, maximum 1000 (an administrator setting within `.env` bounds). Tables show an estimated total ("about N rows", from the server's statistics) with an "Exact count" action; filtered views and results show no total until the user asks. Paging and sorting run on the server (`ORDER BY`, `LIMIT`, `OFFSET`), and past 100000 rows the grid suggests a filter or the SQL tab. |
| G9 | Warning before the idle timeout expires. | **DECIDED (assistant, on the owner's instruction of 2026-10-23 to decide the remaining gaps; the owner may change it).** Two minutes before the idle timeout a notice shows the time left and a "Stay signed in" button, which renews the idle timer but never goes past the absolute lifetime. Five minutes before the absolute lifetime ends the notice says when the session will end and that signing in again is needed (it cannot be extended). Only requests the user caused count as activity, not background refreshes, so an open page cannot keep a session alive by itself; the times come from the server's clock. |
| G10 | The stateless restart message: what a user sees when the process restarted under them. | **DECIDED (owner, 2026-10-23).** The same "session ended" dialog as SCN-009 with neutral wording; one identical response for every invalid session; while the server is down show "Server not reachable, retrying" (bounded) instead. |

## 4. How these scenarios are used

- Each scenario becomes at least one browser test (Playwright or similar; the tool is not chosen) and the acceptance criteria are its assertions. A requirement that appears in no scenario still needs its own test (`11-target-security.md`, verification fields).
- A scenario whose steps need a gap decided stays marked until the owner decides; the gap rows are copied into `OPEN.md` item 3.
- The scenarios say what the user sees, not how the page is drawn; wireframes belong to `OPEN.md` item 7.
