# Nitro / h3 peer address and forwarded headers (FR-SVR-018, task 2)

Checked 2026-11-02 against h3 2.0.8, srvx (Node adapter), nitro 3.0.260903-beta, @tanstack/start-server-core in `node_modules`.

- Runtime gives: TanStack `getRequest()` returns the srvx Node request. The TCP peer is `request.runtime.node.req.socket.remoteAddress`. `request.ip` is the same value when srvx `trustProxy` is unset. Nitro's node preset does not set `trustProxy` (grep of nitro dist: no hit), so srvx ignores forwarded headers for `ip` and for the request URL (`hops = 0`).
- Does h3 trust X-Forwarded-For by itself: no. `getRequestIP` (h3 and the TanStack copy) reads `x-forwarded-for` only with `{ xForwardedFor: true }` and then returns the LEFTMOST entry (spoofable). The old callers passed `config.trustProxy`, so with the proxy flag any client could choose its address. Without the flag it returns `request.context?.clientAddress || request.ip`.
- Other defaults to know: TanStack `getRequestProtocol` and `getRequestUrl` read `x-forwarded-proto` by default (`xForwardedProto !== false`); `getRequestHost` reads `x-forwarded-host` only with the option. srvx `request.url` uses `x-forwarded-proto`/`-host` only for trusted hops (none here).
- How DBLoom reads the peer: `src/server/net/current.ts` `peerAddress()`: socket `remoteAddress` first, then `request.ip`; missing gives `unknown`. `clientAddress()` then applies the trusted-proxy rule (rightmost untrusted entry).
- Enforcement: ESLint `no-restricted-imports` (getRequestIP, getRequestHost, getRequestProtocol, getRequestUrl) and `no-restricted-syntax` (forwarded header literals) outside `src/server/net/`; backup `tests/net-no-forwarded-readers.test.ts`.
- Not yet verified here: behaviour in `vite dev` and under a real proxy (task 8 proxy suite). If `request.runtime` is absent the fallback is `request.ip`.
