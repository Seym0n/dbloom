/**
 * The real TCP peer of a request, never a header value (reviews/server-nitro-peer.md): srvx Node request
 * `runtime.node.req.socket.remoteAddress`, then `request.ip` (equal because Nitro sets no srvx `trustProxy`).
 */
type NodeBacked = Request & {
  ip?: string
  runtime?: { node?: { req?: { socket?: { remoteAddress?: string } } } }
}

export function peerAddress(request: Request): string | undefined {
  const r = request as NodeBacked
  return r.runtime?.node?.req?.socket?.remoteAddress ?? r.ip
}
