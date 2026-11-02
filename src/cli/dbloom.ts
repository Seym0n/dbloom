import { main } from '~/server/auth/cli/main'

// The services write their audit lines with console.log; the CLI keeps stdout for its answer (token, link) only.
console.log = (...args: unknown[]) => void process.stderr.write(`${args.join(' ')}\n`)

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    process.stderr.write(`dbloom: ${error instanceof Error ? error.message : 'failed'}\n`)
    process.exitCode = 1
  },
)
