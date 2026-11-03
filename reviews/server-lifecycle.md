# Graceful shutdown and instance lock (FR-SVR-013, 014; task 5)

Checked 2026-11-03 against nitro 3.0.260903-beta, srvx 1.0.6, Node 24.19, built output run with `node .output/server/index.mjs`.

## 1. How the Nitro node server can be closed without a hack
- The node preset calls `serve({ port, fetch, ... })` (srvx) and wraps `server.close` only to fire the Nitro `close` hook (`setupCloseHooks`). The server object is not exposed. We do not touch it (owner decision: no listener wrapper).
- srvx's node adapter calls `gracefulShutdownPlugin` when the server is created. It registers `SIGINT` and `SIGTERM` handlers that call `server.close()` (stop listening, close idle keep-alive connections, wait for active requests), print progress to stderr, and force-close (`server.close(true)`) after `SERVER_SHUTDOWN_TIMEOUT` seconds (default 5). When the server has closed, `useNitroHooks().callHook("close")` runs. Nothing exits the process afterwards.
- Two things srvx does not do for us: (a) the timeout default (5 s) is not `DBLOOM_SHUTDOWN_SECONDS`; (b) a second signal does not exit (only a second `SIGINT` forces the close; `SIGTERM` is ignored once closing).
- What works, and is what we use: a Nitro runtime plugin (`src/server/startup-plugin.ts`, production only) that
  1. sets `process.env.SERVER_SHUTDOWN_TIMEOUT` from `DBLOOM_SHUTDOWN_SECONDS` (plugins run inside `useNitroApp()`, before `serve()`; the srvx plugin reads the variable when the server is constructed);
  2. registers its own `SIGTERM`/`SIGINT` handler (runs first, being registered earlier): `setShuttingDown()` (readiness 503), `shutdown.begin` log, safety timer, and "second signal exits 1 at once";
  3. hooks `nitro.hooks.hook('close', ...)`: when srvx has drained the server, the cleanup steps run, then `exit(0)`.
- Order seen in the logs: `shutdown.begin` -> (srvx drains) -> `io.job.interrupted` -> `io.temp.removed` -> `sessions.closed` -> store step -> `shutdown.done` -> exit 0.
- Limitation to document: srvx skips its signal handler when `CI` or `TEST` is set in the environment (`process.env.CI || process.env.TEST`). Then nothing closes the server. The controller sets `drains: false` in that case and runs the cleanup steps at once without draining in-flight requests. The container must not set `CI` or `TEST`; the integration tests set both to the empty string.
- Dev (`vite dev`): handlers and the env variable are installed only when `NODE_ENV=production`; the `close` hook does nothing unless a signal was received (a dev reload closes the server too).

## 2. Readiness during shutdown
- `server.close()` stops listening, so a NEW connection after the signal is refused. Readiness is observable only on a connection that is already open and mid-request: Node's `closeIdleConnections` leaves connections with a request in progress alone. The integration test holds a probe connection with a half-sent `GET /api/ready` (headers without the final blank line), sends SIGTERM, completes the request, and gets 503 `"ready":false` while an upload is still in flight. Orchestrators that probe over fresh connections see "connection refused", which is also not-ready.
- For the deploy guide: there is no window where the port still accepts but reports 503 (as with a preStop sleep).

## 3. Sequence (src/server/lifecycle/shutdown.ts)
Steps are registered by the module that owns the resource (registry on `globalThis`, because of several bundles):

| order | step | owner | action |
|---|---|---|---|
| 10 | `io-jobs` | `io/http.ts` `getIoServices` | `JobRegistry.interruptAll()`: abort signal, cancel hook, state `interrupted` for queued/running/paused jobs; one `io.job.interrupted` log line per job |
| 20 | `sessions` | `runtime.ts` | `SessionManager.closeAll()`: cancel running SQL, end every target pool, wipe vault keys; session rows stay |
| 30 | `io-temp` | `io/http.ts` | `TempStore.removeAll()`: all staged and spool files (the jobs end with the process) |
| 40 | `store` | `runtime.ts` | release the lock row, `PRAGMA wal_checkpoint(TRUNCATE)`, close (no `-wal`/`-shm` left) |

- Jobs are interrupted only after the HTTP server has drained, so an export download still streaming is not cut by the interrupt.
- A failing step is logged and the rest run; the exit code is then 1. Safety timer: `DBLOOM_SHUTDOWN_SECONDS + 5 s` without a `close` hook forces the sequence (exit 1). Exit goes through `exitAfterFlush` (stdout flushed first).
- Second signal: `exit(1)` at once, no steps. The lock row stays and the next start takes it over (stale rules below).

## 4. Jobs "interrupted in the store": deviation to confirm
Import and export jobs live in the Node process only (SPEC/25 Q5); there is no jobs table, and a restart forgets them. So "marked interrupted in the store" is implemented as: new terminal job state `interrupted` (error code `interrupted`, UI text, 409 on the download route), set on every live job, visible to polling clients while the process answers, and recorded in the shutdown log (`io.job.interrupted`, `state:"interrupted"`). No migration. If the interrupted state should survive the restart (a banner "your import was interrupted"), that needs a small jobs table (migration 6) and a read at start: not done.

## 5. Instance lock (FR-SVR-013, DEP-TGT-150)
- Mechanism: row `instance_lock` in the existing `site` key/value table of the store: `{pid, host, startedAt, heartbeatAt, nonce}`. Acquire, heartbeat and release are `BEGIN IMMEDIATE` transactions, so two starters cannot both see a stale row and both take it (a lock file with exclusive create plus unlink, or a rename-over takeover, has that race). The row sits in the same volume as the data and needs no migration. A second process opens the store fine (WAL) but fails at the lock before it changes anything else.
- Taken in `getRuntime()` right after the store opens and before the start gate, only when `DBLOOM_STORE` is not `none`. Failure: `InstanceLockError` -> startup fails -> `DBLoom cannot start` log with the message -> exit 1. Message: `Another DBLoom instance uses this store: pid N on host H (started ..., last heartbeat S s ago). Stop it, or wait 30 s if it died.`
- Heartbeat every 10 s (timer unref'd). Stale when the heartbeat is older than 30 s (3 intervals); or the holder is on this host and is this pid (container restart: pid 1 again) or a pid that no longer exists (`process.kill(pid, 0)`). A holder on another host is judged by the heartbeat only (a recreated container has a new host name).
- Container restart with the same volume: `restart: unless-stopped` keeps the container (same host name, pid 1): taken over at once. A recreated container (new host name) after a crash waits up to 30 s; the restart policy retries meanwhile. After a clean stop the row is gone.
- Lost lock: if a heartbeat finds the row replaced (a long pause made it stale and another instance took over), the process logs `instance lock lost; stopping` and exits 1 in production.
- The auth CLI opens the store without the lock on purpose (admin commands against a running instance).
- Not covered: a store on a network file system with unreliable locking (SQLite warns about this too). The guide should say: local volume.

## 6. Tests
- `tests/server-lifecycle.test.ts` (23): sequencing with fakes, second signal, safety timer, `drains:false`, `interruptAll`, `TempStore.removeAll`, lock acquire/refuse/stale (heartbeat, dead pid, same pid, other host)/lost/release, two real connections to one file.
- `tests/server-lifecycle.integration.test.ts` (6) against the built server: SIGTERM with a request in flight (503 on a held connection, new connections refused, request completes, exit 0, no `-wal`/`-shm`, restart on the same directory), second signal (exit 1 within 3 s), stateless, second instance refused (names the pid), SIGKILL then takeover, running import job -> `io.job.interrupted` with state `interrupted`, temp dir empty (needs MySQL 8.4 on port 33064; skipped otherwise).
- Signals on Windows: Node cannot deliver `SIGTERM` to a child on Windows (`child.kill` terminates it hard). On Windows the child runs `tests/fixtures/serve-ipc.mjs` (test only, not in the build): it imports the built server and turns `process.send('SIGTERM')` into `process.emit('SIGTERM')`, which calls exactly the handlers a real signal calls (srvx's and ours). On POSIX the test sends a real signal to the unmodified entry. The POSIX path was not run on this machine (Windows).
