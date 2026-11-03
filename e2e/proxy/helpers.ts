import { execFileSync } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { resolve } from 'node:path'

export const ORIGIN_HOST = 'dbloom.test'
export const TARGETS = {
  traefik: { port: 18443, tls: true },
  caddy: { port: 19443, tls: true },
  traefikHttp: { port: 18080, tls: false },
  direct: { port: 3300, tls: false },
} as const
export type Target = keyof typeof TARGETS

export type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string }

/** One request to 127.0.0.1:<port> with a chosen Host header; self-signed certificates accepted. */
export function send(
  target: Target,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer; host?: string } = {},
): Promise<Reply> {
  const t = TARGETS[target]
  const make = t.tls ? httpsRequest : httpRequest
  return new Promise((resolveReply, reject) => {
    const req = make(
      {
        host: '127.0.0.1',
        port: t.port,
        path,
        method: opts.method ?? 'GET',
        headers: { host: opts.host ?? ORIGIN_HOST, ...opts.headers },
        ...(t.tls ? { rejectUnauthorized: false, servername: ORIGIN_HOST } : {}),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolveReply({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', reject)
    req.end(opts.body)
  })
}

const file = resolve('deploy/proxy/compose.proxy.yaml')

/** Debug access-log lines of the app (`client` is the effective client address). */
export function appLog(): { path?: string; client?: string; msg?: string }[] {
  const out = execFileSync('docker', ['compose', '-f', file, 'logs', '--no-log-prefix', 'app'], { encoding: 'utf8' })
  return out
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return {}
      }
    })
}

/** Effective client address the app saw for a request with a unique path marker. */
export async function clientSeenFor(target: Target, headers: Record<string, string>): Promise<string | undefined> {
  const marker = `/spoof-${Math.random().toString(36).slice(2)}`
  await send(target, marker, { headers })
  for (let i = 0; i < 10; i++) {
    const hit = appLog().find((l) => l.msg === 'request' && l.path === marker)
    if (hit) return hit.client
    await new Promise((r) => setTimeout(r, 200))
  }
  return undefined
}
