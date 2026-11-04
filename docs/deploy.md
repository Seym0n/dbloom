# Deploying DBLoom

DBLoom ships as one Docker image. It listens on plain HTTP and expects a reverse proxy in front that terminates TLS. The reference deployment is Docker Compose on Coolify (its built-in proxy is Traefik); the same rules apply to nginx, Caddy, Apache or any other proxy. One instance only, with one volume.

The image never contains a proxy. Everything the proxy must do is listed in [What the proxy must do](#what-the-proxy-must-do).

## Quick start

Local trial, loopback only:

```sh
cp .env.example .env   # set DBLOOM_PUBLIC_ORIGIN and DBLOOM_TRUST_PROXY, see below
docker compose -f compose.yaml -f compose.local.yaml up --build
```

`compose.yaml` publishes no port (`expose: 3000`); `compose.local.yaml` adds `127.0.0.1:3000:3000`. The compose file refuses to start without `DBLOOM_PUBLIC_ORIGIN` and `DBLOOM_TRUST_PROXY`, because the image binds `0.0.0.0` and the start rules then require both.

Required for a container:

| Variable | Value |
|---|---|
| `DBLOOM_PUBLIC_ORIGIN` | `https://dbloom.example.com` (scheme and host, no path; `https` unless the host is loopback) |
| `DBLOOM_TRUST_PROXY` | CIDR list of the proxy network, for example `172.18.0.0/16`. The legacy value `true` still works for one release with a warning and means "any private-range peer". |

Everything else has a default. The full list is in the [variable reference](#variable-reference).

## Coolify

The steps below follow Coolify's usual flow; menu names can differ between Coolify versions, check them against yours. The Coolify side was not run during development.

1. New resource from your Git repository, build pack **Docker Compose** (uses `compose.yaml`) or **Dockerfile**.
2. Domain: set the public domain with `https://`. Coolify's proxy routes to container port 3000 and obtains the certificate.
3. Environment variables: set `DBLOOM_PUBLIC_ORIGIN` to the same URL as the domain and `DBLOOM_TRUST_PROXY` to the Coolify proxy network (find the subnet with `docker network inspect coolify`). Add the others you need.
4. Persistent storage: keep the named volume mounted at `/data`. It holds the store, the setup token and the import spool.
5. Health check: the image has a Docker `HEALTHCHECK` that works as is. If Coolify runs its own check from the proxy network, set `DBLOOM_PROBE_ALLOW` to that network and `DBLOOM_PROBE_HOSTS` to the container address; other peers get an empty 404 from `/api/health` and `/api/ready`.
6. One replica. Two instances on one store are detected: the second exits with `Another DBLoom instance uses this store`.
7. Deploy, then open the domain. In account mode the first visit runs the setup wizard; print the token with `docker exec <container> node .output/cli/dbloom.mjs setup-token`.

Check what the app sees: `docker exec <container> node .output/cli/dbloom.mjs exposure` prints bind, origin, hosts, proxies, HSTS, probe lists, login mode, store mode and the warnings that apply. The same report is logged at startup.

## What the proxy must do

DBLoom trusts forwarded headers only from the addresses in `DBLOOM_TRUST_PROXY`, and takes the client address as the rightmost entry of `X-Forwarded-For` that is not a trusted proxy. For that to be safe the proxy must:

1. **Forward the original `Host`** (with the port when it is not the default). A `Host` that is not in `DBLOOM_ALLOWED_HOSTS` (default: the origin host) gets 421.
2. **Set `X-Forwarded-For` from the real peer**, replacing any client-sent value. Traefik and Caddy do this by default for untrusted clients; in nginx use `proxy_set_header X-Forwarded-For $remote_addr;` and not `$proxy_add_x_forwarded_for`.
3. **Set `X-Forwarded-Proto`** to the scheme the client used. If a trusted proxy reports `http` while the origin is `https`, credential pages and functions are refused (403).
4. **Not publish the app port.** The container must be reachable only through the proxy. A direct hit from an untrusted peer ignores every forwarded header, but the port should still be closed.
5. **Cap request bodies.** The proxy is the primary size limit. The app only caps its own endpoints (1 MiB for server functions, 64 KiB for other routes; uploads have their own limit).
6. **Raise the read timeout for large imports.** Traefik's default `readTimeout` is 60 s and covers the whole request body (docs v3.6, not timed in the suite); Node's own request timeout is 300 s. An import that needs longer than the proxy allows is cut by the proxy. Set `entryPoints.<name>.transport.respondingTimeouts.readTimeout` (Traefik) or `proxy_read_timeout` and `client_max_body_size` (nginx).
7. **Redirect http to https**, and leave HSTS to the app (it sets `Strict-Transport-Security` on an `https` origin).

Tested reference configurations, run by `npm run test:e2e:proxy` (CI on `main`):

| Proxy | Scope | Config |
|---|---|---|
| Traefik 3 | full suite | `deploy/proxy/traefik/dynamic.yml` |
| Caddy 2 | headers and forwarding | `deploy/proxy/caddy/Caddyfile` |
| nginx 1 | headers, forwarding, body cap | `deploy/proxy/nginx/default.conf` |

Apache is not tested. Use `ProxyPreserveHost On`, set `X-Forwarded-For` and `X-Forwarded-Proto` yourself (`RequestHeader set`), and apply points 4 to 7.

Test-only lines in those files (marked in comments): every `Host` is forwarded so the app's own 421 is exercised, and a header-triggered router simulates a wrong scheme.

## Topologies

| # | Topology | TLS ends | Bind | Trusted proxy | Warnings DBLoom shows |
|---|---|---|---|---|---|
| 1 | Loopback plus SSH tunnel or VPN (preferred) | at the tunnel, or not at all | `127.0.0.1` (default) | none | none |
| 2 | Private network behind a TLS proxy with IP allow-list | proxy | `0.0.0.0` in the container | proxy CIDR | none when configured correctly |
| 3 | Internet-facing behind a TLS proxy with mTLS or an identity-aware proxy and enforced 2FA | proxy | `0.0.0.0` in the container | proxy CIDR | free-form targets, target TLS off, private targets allowed, wildcards |
| 4 | Direct TLS on the internet | not supported (`DBLOOM_TLS=own` is refused) | | | |

Edge and serverless hosting are not supported. Every topology prints its warnings in the exposure report; `npm run exposure` (or the `dbloom exposure` command in the container) shows them.

## Behaviour to know

- **Origin rule.** Every POST needs a matching `Origin` or `Sec-Fetch-Site: same-origin`. Scripts and `curl` against the API must send `Origin`.
- **Direct mode login page.** The servers named in `DBLOOM_DIRECT_TARGETS` are offered as suggestions in the server field. With `DBLOOM_LOGIN_RECALL=true` the page also remembers the last server and user name in the browser (local storage, no password, no token) and fills them in again when that server is still on the list. Off by default; with it off the page reads and writes nothing.
- **Cookies** are always `Secure` (the `__Host-` prefix needs it). `http://localhost` works in Chrome and Firefox, not in Safari. Sub-path deployment is not supported.
- **Headers sent:** HSTS (https origin only, one year, no preload; see `DBLOOM_HSTS*`), nosniff, no-referrer, noindex, COOP, Permissions-Policy. CORS is off; `OPTIONS` answers 405. CSP is planned for the `hardening` module.
- **Known deviations:** built files under `/assets/*` are served before the request gate (public build output); there is no slow-read protection.
- **Logging:** JSON lines on stdout with `X-Request-Id`, secrets redacted. Level `debug` in production needs `DBLOOM_ALLOW_DEBUG=true`; at debug level the access line also carries the client address.
- **Stateless mode** (`DBLOOM_STORE=none`) keeps nothing on disk and is always direct mode; combining it with account mode is refused at startup. `read_only: true` in the compose file works in both modes (writes go to `/data` and `/tmp`).
- **Shutdown.** On SIGTERM readiness turns 503, in-flight requests finish for up to `DBLOOM_SHUTDOWN_SECONDS` (default 25; compose waits 30 s), running imports and exports are marked `interrupted` (not persisted across the restart), pools close and the store closes. Do not set `CI` or `TEST` in the container: the server then skips its signal handling.

## Audit log

- **Where it goes.** Every audit event is one JSON line on stdout (`"audit":"<event>"`), always. In addition, installs with a store (account mode, and direct mode with `DBLOOM_STORE` not `none`) write each event to the `audit_log` table in the store; stateless installs (`DBLOOM_STORE=none`) have stdout only. Administrators read the table at `/admin/audit` (account mode); direct mode has no viewer.
- **Retention.** `DBLOOM_AUDIT_RETENTION_DAYS` (90 to 1095, default 365; a value outside the range refuses startup). The purge runs at start and then every 24 hours, deletes older rows in batches and writes one `audit.purge` row with the count. A change of the variable applies at the next run or restart.
- **External copy.** `DBLOOM_AUDIT_SINK=file:/absolute/path` appends one JSON line per event (mode 0600, one `fsync` per second). The app user must be able to write the path; with `read_only: true` mount a volume there. If the file cannot be written, events wait in memory (10 000 at most, oldest dropped and counted), the write is retried every 5 s, and `/admin/audit` shows the banner; an `audit.sink` row records each change of state. Rotate with `copytruncate`: a renamed file keeps being written until the next restart. This copy, kept on storage the app cannot rewrite, is the tamper-resistant record; see the next point.
- **Append-only is a database rule, not a seal.** Triggers refuse `UPDATE` and refuse `DELETE` of rows younger than the retention cutoff. Anyone who holds the store file can drop the triggers. There is no hash chain.
- **Addresses.** `DBLOOM_AUDIT_ANONYMISE_IP` (`off`, `truncate`, `hash`) applies to the table, the exports and the file copy, not to the stdout line. `hash` uses a subkey of the server key; without a server key (direct mode) it uses a key made at each start, so values do not match across restarts.
- **Size.** About 150 to 200 bytes of payload per statement-level row, and `fields` is capped at 8 KiB. Rows live in the store volume: size the volume for your traffic and retention, and back it up as described below.
- **Export.** Administrators export CSV or NDJSON from the viewer (needs a recent second factor; at most 1 000 000 rows, never older than the retention window). On the host: `docker exec <container> node .output/cli/dbloom.mjs audit export --since 2026-10-01 --format csv > audit.csv`. Both write an `audit.export` row before the first line.
- **Administrators reach the admin pages from any address.** Restricting the administration pages (users, audit log) to named networks is not built yet (it is deferred; see `SPEC/FUTURE.md`). Until it ships, keep them behind your proxy's own access rules if you need that.
- **Downgrade.** The audit table is schema version 6 and the notice memory schema version 7. An older program refuses to open a store of a newer version; restore the pre-upgrade backup to go back.

## Security notices for administrators

- **What raises one.** A burst of failed sign-in steps for one account or from one address (`DBLOOM_NOTICE_BURST_FAILURES` within `DBLOOM_NOTICE_BURST_MINUTES`), and a completed sign-in from a network the account has not used for `DBLOOM_NOTICE_LOCATION_DAYS`. Every active administrator gets the notice; it shows on the Users page, where it can be dismissed. Nothing is sent by email. The first sign-in of an account raises no new-location notice.
- **What the server remembers.** For each account the /24 (IPv4) or /48 (IPv6) networks of completed sign-ins, for the configured number of days, in the store. The memory goes with the account and is purged daily. Failed-attempt counts live in memory only and start again after a restart. This is personal data of your users: mention it in your own privacy notice if you need one.
- **Addresses in notices** follow `DBLOOM_AUDIT_ANONYMISE_IP`.
- **Behind a proxy** the address is the one the proxy reports (`DBLOOM_TRUST_PROXY`); without a correct proxy setting every user looks like they come from the proxy and no new location is ever seen.

## Exposure page

- **What it shows.** `/admin/exposure` (administrators, account mode) lists the exposure report of the running process, the same lines and warnings as `docker exec <container> node .output/cli/dbloom.mjs exposure` for the same environment, marked "as at start". It adds warnings that depend on the running state: no second factor enforced, first-run setup still open, a failing external audit sink, and "administration pages are reachable from any address" (until the administration plane ships), and a status block with readiness, login mode, store state, schema version, version and audit sink status. No secret and no key value is shown.
- **Banner.** On a non-loopback bind, administrators see a banner on the connection home and on the admin pages while any warning is unacknowledged. It never blocks use, and ordinary users never see it. On a loopback-only bind the warnings are listed but no banner is raised.
- **Acknowledging.** An administrator can acknowledge a warning on the page. This is recorded as `exposure.ack` in the audit log (and refused when the audit log cannot be written). The acknowledgement lasts until the next restart; the warning then shows again. It never hides the warning from the page.
- **Readiness detail.** `/api/ready` returns its detail body (state, mode, store, version) to loopback peers and to a request carrying a valid administrator session cookie; every other caller gets the fixed `{"ready":...}` body.

## Settings and maintenance mode

- **The page.** `/admin/settings` (administrators, account mode) lists the 40 account-mode settings with the value in effect, where it comes from (built-in default, operator default from `.env`, set on the page, or limited by the operator), the allowed range and the stored value when it differs. Direct and stateless installs have no settings page. Settings that only the environment can set (for example the authenticator code tolerance and the hashing cost) are listed read-only.
- **Limits.** Each setting has a lowest and highest value fixed in the program. A value outside them is refused, never cut to fit. A few settings take their limit from the environment: the required second-factor scope and roles (a floor the page cannot lower), the grace period (a ceiling), and the allowed second factors and sign-in credentials (the page can only narrow the list). For every other setting the environment variable is the default.
- **Locks.** `DBLOOM_SETTINGS_LOCK` (comma separated setting names, for example `mfaScope,loginFailures`) fixes those settings at their environment value or default: the page shows them read-only and a stored value is ignored. An unknown name refuses start. The names are the ones `dbloom settings list` prints.
- **Changing a setting.** Every change needs a recent second factor and writes an audit row (`settings.change`, `settings.reset`) with the old and the new value **before** the value is stored. When the audit row cannot be written, nothing is changed and the page says so. Two administrators editing the same setting: the second save is refused and the page shows the value that is stored now. A stored value that falls outside a limit that was tightened later is applied clamped and noted once in the audit log (`settings.clamped`); the stored value is not rewritten and the page shows both.
- **Narrowing.** Before the allowed second factors or sign-in credentials are narrowed, the page asks the server how many active users would be left with no allowed option. A count above zero refuses the change.
- **Sign-in notice and banner.** The notice (at most 300 characters) is shown above the sign-in form to everyone; the banner (at most 500) after sign-in. Both are plain text: markup is shown as typed. `DBLOOM_LOGIN_NOTICE` sets the default of the notice and is the only source in direct mode; the banner exists in account mode only.
- **Maintenance mode.** Switched on from the page (optionally with an end time), it refuses every non-administrator: sign-in is refused after the password or passkey proved the user, and every server function and download answers "maintenance". Sessions that are already open are kept, only blocked. Administrators and the command line are exempt, and `/api/health` and `/api/ready` are not affected. The end time is checked on every request, so it ends by itself even across a restart. `DBLOOM_MAINTENANCE=true` forces it on and the page cannot switch it off. Schema changes need no switch: a migration runs before the server starts listening. Maintenance mode does not exist in direct mode.
- **Getting back in.** On the host, `dbloom settings list` prints every setting with its source and lock; `dbloom settings reset <key>` removes a stored value (the same limits and locks apply, no step-up, audited as `cli`); `dbloom maintenance off` removes the stored switch. A running server picks a change made from the command line up within a few seconds.
- **Not on the page yet.** The settings of target policy, import and export, history and display (SPEC/12 sections 3.3 to 3.5) are still read from the environment only; they move to the page when their modules read them through the settings resolver (`SPEC/FUTURE.md`, FU-settings-ext).

## Protected settings and auto-revert

- **Which settings.** Ten settings can lock administrators out if set wrongly: `mfaScope`, `mfaRoles`, `mfaFactors`, `primaryCredentials`, `loginFailures`, `loginBackoffCapMs`, `loginWindowMs`, `loginAddressFailures`, `adminSessionIdleMs`, `adminSessionAbsoluteMs`. The settings page marks each with "reverts in N minutes unless confirmed after signing in again".
- **What happens on a change.** A protected change applies at once (after the usual second factor) and is audited as `settings.pending`. If nobody confirms it, the server puts the previous value back at the deadline and audits `settings.revert`. A second change to the same key moves the deadline and keeps the first original value.
- **Confirming.** An administrator signs in again (a session started after the change), opens `/admin/settings` and presses Confirm (`settings.confirm`). The session that made the change cannot confirm it, so a change that breaks sign-in cannot be confirmed by accident. Revert now (`settings.cancel`) puts the old value back without a second factor. Other admin pages show one line with a link while a change waits.
- **The deadline.** `DBLOOM_AUTOREVERT_MINUTES` (1 to 15, default 5; environment only). The deadline is an absolute time in the store: a restart keeps it, a change that is overdue at start is reverted before the server listens, and nobody has to be signed in. The revert audit row is best effort: a failing audit sink does not stop the revert.
- **Getting back in.** `dbloom settings pending` lists waiting changes. `dbloom settings reset <key>` and `dbloom maintenance off` mark the waiting change `superseded`: nothing is restored later. If a protected change locks everybody out, wait for the deadline or run the reset on the host.
- **Not included.** No countdown on the page and no count of affected users (`SPEC/FUTURE.md`, FU-protect-impact-count, FU-protect-cooling-off, FU-protect-versioned-rollback).

## AI assistant

- **What it is.** A sidebar where a user asks questions about the data of the connection they are using. The assistant writes SQL and calls two tools: `describe_tables` (schema only) and `run_query` (one statement). It is off until an administrator connects an AI service. Nothing is sent anywhere before that, and opening the sidebar sends nothing.
- **Connecting a service.** Any OpenAI-compatible chat API with tool calling. `DBLOOM_AI_BASE_URL` (https, for example `https://api.example.com/v1`; plain http only with `DBLOOM_AI_ALLOW_PRIVATE=true`), `DBLOOM_AI_API_KEY` or `DBLOOM_AI_API_KEY_FILE` (a Docker secret; never both), and the model name in `DBLOOM_AI_MODEL` or on `/admin/assistant`. The address and the key are environment-only on purpose: a stolen session must not be able to redirect personal data. The key is never shown, never logged and never sent anywhere but the `Authorization` header of that service. Redirects are refused. Private and loopback addresses are refused unless `DBLOOM_AI_ALLOW_PRIVATE=true` (a local model server such as Ollama).
- **Through a proxy.** DBLoom has no proxy setting of its own for this. Node's own support applies: set `NODE_USE_ENV_PROXY=1` and `HTTPS_PROXY` (and `NO_PROXY`) in the environment of the container.
- **Personal data.** An administrator marks columns as `db.table.column`, where a part may be `*` (for example `*.*.email`, `shop.customers.*`), on `/admin/assistant` or in `DBLOOM_PII_COLUMNS` (the environment list is always added to the stored markings). A value of a marked column never goes to the AI service: it gets a token such as `<email:ab12:3>`, the same token for the same value inside one conversation. The user sees the real values on screen. The assistant can use a token in a `WHERE ... = '<token>'` and DBLoom puts the real value in. Comparisons that could reveal a value (`LIKE`, ranges, functions, `MIN`, `MAX`, a guessed literal) are refused. When DBLoom cannot tell where an output column comes from (a view, a statement its parser cannot read), only column names and the row count are sent. **Columns that are not marked are not protected**, and neither is personal data inside free text or JSON: mark what matters.
- **No markings yet.** Until an administrator marks columns or says "there is no personal data here" for a connection, the assistant only gets column names and row counts for it, and the sidebar says so.
- **Approval.** In **manual** mode every call to the database waits for the user's Approve, with the statement as it will run. In **auto** mode (chosen per conversation, manual by default) reads run on their own; `INSERT` and `UPDATE` always ask, and `DELETE`, schema changes, privileges and several statements are never run by the assistant: they open in an SQL tab, unrun. `describe_tables` reads the schema only and needs no approval. An administrator can switch auto mode off for everybody (setting "Users may let the assistant run queries without asking each time"). A call that waits is dropped after 10 minutes, on Stop, and when the user writes a new message.
- **What is kept.** Account mode keeps the conversations of a user: text, the SQL in token form, the outcome and the row count. **Never result rows and never the tokens.** After a restart the tokens are gone: the conversation reopens as text and an old token in a statement is refused. Conversations follow the audit retention (`DBLOOM_AUDIT_RETENTION_DAYS`) and the user can delete them earlier. Direct and stateless installs keep conversations in server memory for the session only.
- **Audit.** `assistant.call`, `assistant.approve`, `assistant.deny`, `assistant.refuse`, `assistant.mode` and `assistant.rule`, each with the SQL in token form and never a value or a row. Where the audit table exists a row that cannot be written stops the call (a write is audited before it runs). In stateless mode only the standard output and the file sink get them.
- **Limits.** `DBLOOM_AI_MAX_STEPS` (default 8) model-to-tool round trips per message, `DBLOOM_AI_MAX_ROWS` (default 50, at most 200) rows of one result for the assistant, 20 messages per user per 10 minutes, 60 seconds per request to the service, 2 MiB per answer.
- **Injected instructions.** Everything the database returns is passed on as data in a fixed envelope, and the assistant's text is shown as plain text with a few safe Markdown forms (no HTML, no images, links only on click). The assistant cannot change the mode, the markings or an approval; the only things it can do are the two tools, under the rules above.
- **Working in the database.** The assistant uses the user's own connection and rights; anything the target forbids stays forbidden. A read-only connection refuses an approved write.

## Backup, upgrade, rollback

- **Back up the `/data` volume and the server key.** The store holds users, factors and encrypted profiles; the key (`DBLOOM_SECRET_KEY` or the file in `DBLOOM_SECRET_KEY_FILE`) lives outside the volume on purpose. Without the key, TOTP secrets and recovery codes in a backup are unusable; with the volume alone, nobody can read them. Store them in different places.
- **Rotate the server key:** set the new key as `DBLOOM_SECRET_KEY` and the old one as `DBLOOM_SECRET_KEY_PREVIOUS`, restart, run `node .output/cli/dbloom.mjs rotate-secret`, then remove the previous key.
- **Upgrade:** build or pull the new image and redeploy. Take a volume backup first.
- **Rollback:** redeploy the previous image. If a newer version changed the store, restore the pre-upgrade backup instead; whether an older version can open a newer store is not tested.
- **Container commands** (run as the app user, `docker exec <container> node .output/cli/dbloom.mjs <command>`): `setup-token`, `recover <user>`, `sessions revoke <user>`, `rotate-secret`, `exposure`, `audit export`, `settings list`, `settings reset <key>`, `settings pending`, `maintenance off`.

## Variable reference

Generated from `src/server/env-registry.ts` by `node scripts/gen-env-docs.mjs`; CI fails when this table is out of date. `.env.example` is generated from the same registry.

<!-- env-table:start -->
| Variable | Type | Default | Description |
|---|---|---|---|
| **Listener** | | | |
| `DBLOOM_HOST` | string | `127.0.0.1` | Bind address. A non-loopback value needs DBLOOM_PUBLIC_ORIGIN and DBLOOM_TRUST_PROXY. The image sets 0.0.0.0. |
| `PORT` | int (1 to 65535) | `3000` | Listen port. |
| `DBLOOM_PUBLIC_ORIGIN` | string |  | Public origin scheme://host[:port], no path. https unless the host is loopback. Required for account mode and non-loopback bind. |
| `DBLOOM_ALLOWED_HOSTS` | list |  | Comma separated Host values answered (default: host of the origin). Wildcards only on a loopback bind. |
| `DBLOOM_TRUST_PROXY` | list |  | Trusted reverse proxies as CIDR list, e.g. 10.0.0.0/8,172.16.0.0/12. Legacy `true` is accepted with a warning. |
| `DBLOOM_PROXY_HOPS` | int (0 to 16) | `0` | Optional number of trusted proxy hops in X-Forwarded-For (0 = rightmost untrusted entry). |
| `DBLOOM_TLS` | enum (proxy, own) | `proxy` | TLS is terminated by a `proxy`. `own` is reserved and refused. |
| `DBLOOM_HSTS` | enum (on, off) | `on` | Strict-Transport-Security on https origins. `off` is allowed with a warning. |
| `DBLOOM_HSTS_MAX_AGE` | int (0 to 63072000) | `31536000` | HSTS max-age in seconds. |
| `DBLOOM_HSTS_SUBDOMAINS` | bool | `false` | Add includeSubDomains to HSTS. |
| **Lifecycle** | | | |
| `DBLOOM_SHUTDOWN_SECONDS` | int (1 to 300) | `25` | Grace period for in-flight requests after SIGTERM (keep below the container stop grace). |
| `DBLOOM_LOG_LEVEL` | enum (debug, info, warn, error) | `info` | Log level. |
| `DBLOOM_ALLOW_DEBUG` | bool | `false` | Allow log level debug when NODE_ENV=production (warning). |
| `DBLOOM_PROBE_HOSTS` | list | `localhost,127.0.0.1` | Host values the health probes answer for. |
| `DBLOOM_PROBE_ALLOW` | list | `127.0.0.0/8,::1/128` | Peers (CIDR) allowed to call the probes. |
| **Limits** | | | |
| `DBLOOM_BODY_LIMIT_FUNCTIONS_KIB` | int (16 to 65536) | `1024` | Request body cap of server functions in KiB. |
| `DBLOOM_BODY_LIMIT_OTHER_KIB` | int (1 to 1024) | `64` | Request body cap of every other route in KiB. |
| **Store** | | | |
| `DBLOOM_STORE` | string | `sqlite` | `none` runs stateless (direct mode only, nothing persisted). |
| `DBLOOM_DATA_DIR` | path | `./data` | Store directory (the compose file mounts a volume at /data). |
| **Audit** | | | |
| `DBLOOM_AUDIT_SINK` | string | `stdout` | Extra audit destination: `stdout` (default, the audit JSON line always goes to stdout) or `file:/absolute/path` (append only, mode 0600, one JSON line per event). A failing file is buffered and retried; see the deploy guide. |
| `DBLOOM_AUDIT_ANONYMISE_IP` | enum (off, truncate, hash) | `off` | Address in stored, exported and file-sink audit records: `off`, `truncate` (IPv4 /24, IPv6 /48) or `hash` (HMAC under a server key subkey). The stdout line keeps the address. |
| **Notices** | | | |
| `DBLOOM_NOTICE_BURST_FAILURES` | int (3 to 20) | `10` | Failed sign-in steps for one account or one address within the window that raise a notice to administrators. |
| `DBLOOM_NOTICE_BURST_MINUTES` | int (1 to 60) | `10` | Window in minutes for the failed-attempt notice. |
| `DBLOOM_NOTICE_LOCATION_DAYS` | int (7 to 365) | `90` | Days an account remembers the networks (/24 IPv4, /48 IPv6) it signed in from; a sign-in from another network raises a notice to administrators. |
| **Audit** | | | |
| `DBLOOM_AUDIT_RETENTION_DAYS` | int (90 to 1095) | `365` | Days the audit log keeps rows; older rows are purged daily (the purge is itself audited). |
| **Settings** | | | |
| `DBLOOM_SETTINGS_LOCK` | list |  | Setting keys (e.g. mfaScope,loginFailures) the settings page shows read-only at their `.env` value or default; a stored value is ignored. An unknown key refuses startup. |
| `DBLOOM_MAINTENANCE` | bool | `false` | Maintenance mode forced on: users are refused, administrators and the CLI are not. The settings page cannot switch it off. |
| `DBLOOM_LOGIN_NOTICE` | string |  | Plain text shown above the sign-in form (at most 300 characters, no control characters). Default of the setting; the page may override it. |
| **Targets** | | | |
| `DBLOOM_DIRECT_TARGETS` | list |  | Direct mode: servers users may connect to, host:port list (SEC-TGT-018). |
| `DBLOOM_DIRECT_FREE_FORM_ACK` | bool | `false` | Direct mode: accept free-form targets (only behind other protections). |
| `DBLOOM_ALLOW_LOOPBACK` | bool | `false` | Allow loopback target addresses (SEC-TGT-030). |
| `DBLOOM_ALLOW_PRIVATE` | bool | `false` | Allow private target addresses (SEC-TGT-030). |
| `DBLOOM_TARGET_TLS` | enum (verify, skip-verify, off) | `verify` | TLS to targets. |
| `DBLOOM_CONNECT_TIMEOUT_SECONDS` | int | `10` | Connect timeout to targets in seconds. |
| `DBLOOM_READ_ONLY` | bool | `false` | Force every session read-only. |
| `DBLOOM_STATEMENT_TIMEOUT_SECONDS` | int | `30` | Statement timeout in seconds (greater than zero). |
| **Sessions** | | | |
| `DBLOOM_SESSION_IDLE_MINUTES` | int | `30` | Idle session timeout in minutes. |
| `DBLOOM_SESSION_ABSOLUTE_HOURS` | int | `12` | Absolute session lifetime in hours. |
| **Import and export** | | | |
| `DBLOOM_TEMP_DIR` | path |  | Staging and spool files; default <data dir>/tmp. |
| `DBLOOM_TEMP_QUOTA_MIB` | int (1 to 10000000) | `10240` | Total size of staged and spooled files in MiB. |
| `DBLOOM_IMPORT_MAX_MIB` | int (1 to 2048) | `2048` | Upper bound of the upload size in MiB. |
| `DBLOOM_IMPORT_DIR` | path |  | Enables importing files from a server folder. Absolute path. |
| `DBLOOM_UPLOAD_DIR` | path |  | Reported by the setup wizard only (auth/setup.ts). |
| **Account mode** | | | |
| `DBLOOM_LOGIN_MODE` | enum (account, direct) |  | Login mode: account or direct. Unset lets the setup wizard choose. |
| `DBLOOM_AUTO_SETUP` | enum (direct) |  | Headless direct-mode install (CI, e2e): `direct`. |
| `DBLOOM_SETUP_TOKEN` | secret |  | Fixed setup token (otherwise one is generated and printed). |
| `DBLOOM_SETUP_TOKEN_MINUTES` | int |  | Lifetime of the generated setup token. |
| `DBLOOM_SETUP_NETWORKS` | list |  | CIDR list that may reach setup (empty = any address). |
| `DBLOOM_ADMIN_NETWORKS` | list |  | CIDR list of administration networks (default loopback). |
| `DBLOOM_SECRET_KEY` | secret |  | Server key (base64) for account mode. Never commit. |
| `DBLOOM_SECRET_KEY_FILE` | path |  | File holding the server key. |
| `DBLOOM_SECRET_KEY_PREVIOUS` | secret |  | Previous server key during rotation. |
| `DBLOOM_MFA_SCOPE` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_MFA_ROLES` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_MFA_GRACE_DAYS` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_MFA_FACTORS` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_PRIMARY_CREDENTIALS` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_TOTP_WINDOW` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_PASSWORD_MIN_LENGTH` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_BREACHED_LIST` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_BREACHED_CHECK` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_ARGON2_MEMORY_MIB` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_ARGON2_PASSES` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_ARGON2_PARALLELISM` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_VAULT_ARGON2_MEMORY_MIB` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_VAULT_ARGON2_PASSES` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_VAULT_ARGON2_PARALLELISM` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_TEMP_PASSWORD_HOURS` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_ADMIN_SESSION_IDLE_MINUTES` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_ADMIN_SESSION_ABSOLUTE_HOURS` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_SESSIONS_PER_USER` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_SESSIONS_PER_ADMIN` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_SESSIONS_AT_LIMIT` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_LOGIN_FAILURES` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_LOGIN_BACKOFF_CAP_MINUTES` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_LOGIN_WINDOW_MINUTES` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_LOGIN_ADDRESS_FAILURES` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_INVITE_HOURS` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_RECOVERY_LINK_HOURS` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_VAULT_PASSPHRASE_MIN` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_VAULT_AUTOLOCK_MINUTES` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_PERSONAL_PROFILES` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_ALLOW_EMPTY_TARGET_PASSWORD` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_DENY_ROOT_TARGET` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_LOGIN_RECALL` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_STEPUP_MINUTES` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_AUTOREVERT_MINUTES` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_ASSISTANT_ENABLED` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_AI_MODEL` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_ASSISTANT_AUTO_ALLOWED` | string |  | Auth setting override (file 26); validated by the auth module. |
| `DBLOOM_ASSISTANT_HIDE_PII_NAMES` | string |  | Auth setting override (file 26); validated by the auth module. |
| **AI assistant** | | | |
| `DBLOOM_AI_BASE_URL` | string |  | Base URL of an OpenAI-compatible chat API (https://host/v1). Empty = the assistant is unavailable and nothing is sent anywhere. |
| `DBLOOM_AI_API_KEY` | secret |  | API key of the AI service. Never shown, never logged. |
| `DBLOOM_AI_API_KEY_FILE` | path |  | File holding the API key (Docker secret). |
| `DBLOOM_AI_ALLOW_PRIVATE` | bool | `false` | Allow the AI endpoint on a private or loopback address (a local model server). |
| `DBLOOM_AI_MAX_ROWS` | int (1 to 200) | `50` | Rows of one result that may go to the AI (PII cells as tokens). |
| `DBLOOM_AI_MAX_STEPS` | int (1 to 20) | `8` | Model-to-tool round trips for one user message. |
| `DBLOOM_PII_COLUMNS` | list |  | Columns whose values the AI never sees, as db.table.column (a part may be *), for example `*.*.email,shop.customers.*`. Added to the markings kept in the store. |
| **SQL** | | | |
| `DBLOOM_SQL_DISABLED` | bool | `false` | Turns the SQL module off. |
| `DBLOOM_SQL_PARSER` | string |  | `off` is the parser kill switch. |
| `DBLOOM_SQL_ROW_CAP` | int |  | Result row cap. |
| `DBLOOM_SQL_RESPONSE_MB` | int |  | Response size cap in MB. |
| `DBLOOM_SQL_CELL_KB` | int |  | Cell size cap in KB. |
| `DBLOOM_SQL_MAX_STATEMENTS` | int |  | Statements per run. |
| `DBLOOM_SQL_MAX_CONCURRENT_RUNS` | int |  | Concurrent runs per session. |
| **Rows** | | | |
| `DBLOOM_ROWS_MAX_PAGE_SIZE` | int |  | Largest page size. |
| `DBLOOM_ROWS_EXACT_COUNT_THRESHOLD` | int |  | Exact count threshold. |
| `DBLOOM_ROWS_VIEW_COUNT_CAP` | int |  | Count cap of views. |
| `DBLOOM_ROWS_CELL_BYTES` | int |  | Cell size cap in bytes. |
| `DBLOOM_ROWS_UPLOAD_BYTES` | int |  | Cell upload cap in bytes. |
| `DBLOOM_ROWS_BULK_SIZE` | int |  | Bulk operation size. |
| `DBLOOM_ROWS_INSERT_ROWS` | int |  | Rows per insert form. |
<!-- env-table:end -->
