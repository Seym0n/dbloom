// `npm run build`: the app and the CLI bundle. On Windows the first step sometimes fails with EBUSY while nitro copies a
// traced package (a file scanner or an indexer holds the fresh copy). That one failure, and only that one, is tried again
// a few times after a short wait; every other failure stops at once with its own output. The same script runs in CI and
// in the image build, where EBUSY does not occur and nothing changes.
import { spawn } from 'node:child_process'

const STEPS = [
  { name: 'app', args: ['vite', 'build'] },
  { name: 'cli', args: ['vite', 'build', '--config', 'vite.cli.config.ts'] },
]
const ATTEMPTS = 4
const WAIT_MS = 3000

function run(args) {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, { stdio: ['inherit', 'pipe', 'pipe'], shell: process.platform === 'win32' })
    const take = (stream, sink) =>
      stream.on('data', (chunk) => {
        out += chunk.toString()
        if (out.length > 200_000) out = out.slice(-100_000)
        sink.write(chunk)
      })
    take(child.stdout, process.stdout)
    take(child.stderr, process.stderr)
    child.on('close', (code) => resolve({ code: code ?? 1, out }))
    child.on('error', () => resolve({ code: 1, out }))
  })
}

for (const step of STEPS) {
  for (let attempt = 1; ; attempt += 1) {
    const { code, out } = await run(step.args)
    if (code === 0) break
    if (!/EBUSY/.test(out) || attempt >= ATTEMPTS) process.exit(code)
    console.warn(`\nbuild step "${step.name}" hit EBUSY (attempt ${attempt} of ${ATTEMPTS}); trying again in ${WAIT_MS / 1000} s`)
    await new Promise((r) => setTimeout(r, WAIT_MS))
  }
}
