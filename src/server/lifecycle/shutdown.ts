import { log as defaultLog, type Logger } from '../log'
import { setShuttingDown } from './readiness'

/**
 * Graceful shutdown (FR-SVR-014). Two parts:
 * - the step registry: every module that owns a resource (jobs, pools, temp files, store, instance lock) registers a
 *   step; the registry lives on `globalThis` because the built server holds several bundles;
 * - the controller: reacts to `SIGTERM`/`SIGINT` (installed by the Nitro startup plugin), flips readiness, and runs
 *   the steps once the HTTP server has drained (Nitro `close` hook, fired by srvx after `server.close()`).
 */
export type ShutdownStep = {
  name: string
  /** Lower runs first. Jobs 10, sessions and pools 20, temp files 30, store 40, instance lock 50. */
  order: number
  run: () => void | Promise<void>
}

const KEY = Symbol.for('dbloom.shutdown.steps')
const registry = (): Map<string, ShutdownStep> => {
  const g = globalThis as unknown as Record<symbol, Map<string, ShutdownStep> | undefined>
  return (g[KEY] ??= new Map())
}

/** Registering a name again replaces the step (the runtime is rebuilt in dev and in tests). */
export function registerShutdownStep(step: ShutdownStep): void {
  registry().set(step.name, step)
}
export function unregisterShutdownStep(name: string): void {
  registry().delete(name)
}
export function registeredShutdownSteps(): ShutdownStep[] {
  return [...registry().values()].sort((a, b) => a.order - b.order)
}
/** Tests only. */
export function clearShutdownSteps(): void {
  registry().clear()
}

/** Runs the steps in order; a failing step is logged and never stops the rest. Returns the names that failed. */
export async function runShutdownSteps(steps: ShutdownStep[], logger: Logger = defaultLog): Promise<string[]> {
  const failed: string[] = []
  for (const step of steps) {
    try {
      await step.run()
      logger.info('shutdown.step', { step: step.name })
    } catch (error) {
      failed.push(step.name)
      logger.error('shutdown.step failed', { step: step.name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return failed
}

export type ShutdownOptions = {
  /** Grace for in-flight requests (`DBLOOM_SHUTDOWN_SECONDS`). */
  graceMs: number
  /**
   * True when srvx's own signal handler drains the server and Nitro fires `close` afterwards. False (srvx disables it
   * when `CI` or `TEST` is set): the steps run at once, without draining.
   */
  drains: boolean
  /** Ends the process; code 0 after a clean stop, 1 after a forced one. */
  exit: (code: number) => void
  steps?: () => ShutdownStep[]
  log?: Logger
  /** Extra time after the grace before the safety timer forces the sequence (srvx closes the server at the grace). */
  slackMs?: number
}

export type ShutdownController = {
  /** Wired to `SIGTERM` and `SIGINT`. */
  onSignal(signal: string): void
  /** Wired to the Nitro `close` hook (the server stopped listening and drained or was forced). */
  onServerClosed(): void
  /** True after the first signal. */
  begun(): boolean
}

export function createShutdownController(options: ShutdownOptions): ShutdownController {
  const logger = options.log ?? defaultLog
  const steps = options.steps ?? registeredShutdownSteps
  let began = false
  let running: Promise<void> | undefined
  let timer: NodeJS.Timeout | undefined

  const run = (code: number): Promise<void> => {
    running ??= (async () => {
      if (timer) clearTimeout(timer)
      const failed = await runShutdownSteps(steps(), logger)
      logger.info('shutdown.done', { failed: failed.length, exitCode: failed.length ? 1 : code })
      options.exit(failed.length ? 1 : code)
    })()
    return running
  }

  return {
    begun: () => began,
    onSignal(signal) {
      if (began) {
        logger.warn('shutdown.forced', { signal, reason: 'second signal' })
        options.exit(1)
        return
      }
      began = true
      setShuttingDown()
      logger.info('shutdown.begin', { signal, graceSeconds: Math.round(options.graceMs / 1000), drains: options.drains })
      if (!options.drains) {
        void run(0)
        return
      }
      // Safety net: if `close` never fires (a hung connection srvx could not force), run the steps anyway.
      timer = setTimeout(() => {
        logger.warn('shutdown.forced', { reason: 'grace exceeded' })
        void run(1)
      }, options.graceMs + (options.slackMs ?? 5_000))
      timer.unref()
    },
    onServerClosed() {
      if (!began) return // dev reload or a test closing the server: not a shutdown
      void run(0)
    },
  }
}

/** Process wiring: signals to the controller. Returns an uninstall function for tests. */
export function installSignalHandlers(controller: ShutdownController, proc: Pick<NodeJS.Process, 'on' | 'off'> = process): () => void {
  const handlers = (['SIGTERM', 'SIGINT'] as const).map((sig) => {
    const h = () => controller.onSignal(sig)
    proc.on(sig, h)
    return [sig, h] as const
  })
  return () => {
    for (const [sig, h] of handlers) proc.off(sig, h)
  }
}

/** Exit that lets the last log lines reach stdout first. */
export function exitAfterFlush(code: number): void {
  const done = () => process.exit(code)
  try {
    if (process.stdout.write('', done) === false) process.stdout.once('drain', done)
  } catch {
    done()
  }
  setTimeout(done, 500).unref()
}
