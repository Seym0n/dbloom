/**
 * Plain entry for lifecycle tests: starts the BUILT server and, because Windows cannot deliver `SIGTERM` to a child
 * process, forwards `process.send('SIGTERM')` as `process.emit('SIGTERM')`. That runs the very handlers a real signal
 * runs (srvx's graceful shutdown and the DBLoom shutdown controller); nothing in the server changes. Not shipped.
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

process.on('message', (message) => {
  if (message === 'SIGTERM' || message === 'SIGINT') process.emit(message)
})
await import(pathToFileURL(resolve('.output/server/index.mjs')).href)
