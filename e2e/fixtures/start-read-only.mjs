// Starts the already built server a second time (read-only instance for SCN-020).
// The first web server runs the build; this one waits until that server answers.
const wait = process.env.WAIT_FOR_URL
const deadline = Date.now() + 220_000
for (;;) {
  try {
    if ((await fetch(wait)).ok) break
  } catch {
    // not up yet
  }
  if (Date.now() > deadline) throw new Error(`timed out waiting for ${wait}`)
  await new Promise((resolve) => setTimeout(resolve, 500))
}
await import('../../.output/server/index.mjs')
