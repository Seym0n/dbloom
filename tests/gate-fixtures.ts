import type { GateConfig, GateRequest } from '~/server/net/gate'

export const cfg = (over: Partial<GateConfig> = {}): GateConfig => ({
  trustedProxies: ['10.0.0.0/8'],
  trustProxyLegacy: false,
  proxyHops: 0,
  publicOrigin: 'https://db.example.org',
  allowedHosts: ['db.example.org'],
  probeHosts: ['localhost', '127.0.0.1'],
  probeAllow: ['127.0.0.0/8', '::1/128'],
  ...over,
})

export const req = (over: Partial<Omit<GateRequest, 'headers'>> & { headers?: Record<string, string> } = {}): GateRequest => {
  const { headers, ...rest } = over
  return {
    method: 'GET',
    pathname: '/',
    peer: '10.0.0.5',
    urlScheme: 'http',
    ...rest,
    headers: new Headers({ host: 'db.example.org', ...headers }),
  }
}
