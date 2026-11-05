import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const file = resolve('deploy/proxy/compose.proxy.yaml')
const compose = (...args: string[]) => execFileSync('docker', ['compose', '-f', file, ...args], { stdio: 'inherit' })

/** Builds the image and starts app + Traefik + Caddy + nginx; tears everything down afterwards (set KEEP_PROXY=1 to keep). */
export default function setup() {
  compose('up', '--build', '-d', '--wait', 'app')
  compose('up', '-d', '--wait', 'traefik', 'caddy', 'nginx')
  return () => {
    if (!process.env.KEEP_PROXY) compose('down', '-v', '--remove-orphans')
  }
}
