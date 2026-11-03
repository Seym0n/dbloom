import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const file = resolve('deploy/proxy/compose.proxy.yaml')
const compose = (...args: string[]) => execFileSync('docker', ['compose', '-f', file, ...args], { stdio: 'inherit' })

/** App, MySQL target and Traefik; torn down afterwards unless KEEP_PROXY is set. */
export default function setup() {
  compose('up', '--build', '-d', '--wait', 'app', 'mysql')
  compose('up', '-d', 'traefik')
  return () => {
    if (!process.env.KEEP_PROXY) compose('down', '-v', '--remove-orphans')
  }
}
