/**
 * Runtime side of the exposure page (SPEC/31 FR-AEX-002, 005): warnings that depend on stored or live state, and the
 * acknowledgements. The pure environment report stays in `exposure.ts`. An acknowledgement lives in memory for the life
 * of the process on purpose: a restart shows the warning again (ST-032). It is audited first, as a required write.
 */
import { auditRequired as writeRequired } from './audit'
import { isLoopbackBind, type ExposureReport, type ExposureWarning } from './exposure'

export type RuntimeProbe = {
  /** `account` once setup completed in account mode; anything else has no administrators. */
  mode: () => 'account' | 'direct' | 'setup' | 'stateless'
  mfaScope: () => string
  sink: () => { sink: string; state: string }
}

export type ExposureItem = ExposureWarning & {
  source: 'environment' | 'runtime'
  /** Set while acknowledged in this process. */
  acknowledged?: { by: string; at: number }
}

export type ExposureView = {
  /** When the environment report was built (process start). */
  asOf: number
  lines: ExposureReport['lines']
  items: ExposureItem[]
  /** The banner for administrators: raised only off loopback and while something is unacknowledged. */
  banner: { raised: boolean; count: number }
}

export class UnknownWarning extends Error {
  constructor() {
    super('No such warning is active')
    this.name = 'UnknownWarning'
  }
}

/** Warnings that need live state. Account mode only; before setup only "setup still open" applies. */
export function runtimeWarnings(probe: RuntimeProbe): ExposureWarning[] {
  const out: ExposureWarning[] = []
  const mode = probe.mode()
  if (mode === 'setup') out.push({ id: 'setup-open', text: 'First-run setup is still open' })
  if (mode === 'account') {
    if (probe.mfaScope() === 'none') out.push({ id: 'no-mfa', text: 'No second factor is enforced for sign-in' })
    out.push({ id: 'admin-any-address', text: 'Administration pages are reachable from any address' })
  }
  const sink = probe.sink()
  if (sink.sink === 'file' && sink.state === 'degraded') out.push({ id: 'audit-sink-degraded', text: 'The external audit sink is failing' })
  return out
}

/** The banner rule as a pure function (FR-AEX-004). */
export function bannerOf(host: string, items: ExposureItem[]): { raised: boolean; count: number } {
  const count = items.filter((i) => !i.acknowledged).length
  return { raised: !isLoopbackBind(host) && count > 0, count }
}

export type ExposureStateDeps = {
  report: ExposureReport
  host: string
  startedAt: number
  probe: RuntimeProbe
  now?: () => number
  /** The required audit write; the default is the one of `audit.ts`. */
  auditRequired?: (event: string, fields: Record<string, string | number | boolean | undefined>) => void
}

export type ExposureState = {
  view(): ExposureView
  /** Throws `UnknownWarning` for an id that is not active now, and whatever `auditRequired` throws (then nothing is recorded). */
  acknowledge(actor: { id: string; name: string }, warningId: string): void
}

export function createExposureState(d: ExposureStateDeps): ExposureState {
  const now = () => (d.now ?? Date.now)()
  const write = d.auditRequired ?? writeRequired
  const acks = new Map<string, { by: string; at: number }>()

  const active = (): { items: ExposureItem[] } => {
    const items: ExposureItem[] = [
      ...d.report.items.map((w) => ({ ...w, source: 'environment' as const })),
      ...runtimeWarnings(d.probe).map((w) => ({ ...w, source: 'runtime' as const })),
    ]
    // A warning that stopped being true loses its acknowledgement: if it comes back it is a new problem.
    const ids = new Set(items.map((i) => i.id))
    for (const id of acks.keys()) if (!ids.has(id)) acks.delete(id)
    return { items: items.map((i) => (acks.has(i.id) ? { ...i, acknowledged: acks.get(i.id)! } : i)) }
  }

  return {
    view() {
      const { items } = active()
      return { asOf: d.startedAt, lines: d.report.lines, items, banner: bannerOf(d.host, items) }
    },
    acknowledge(actor, warningId) {
      if (!active().items.some((i) => i.id === warningId)) throw new UnknownWarning()
      write('exposure.ack', { actor: actor.id, outcome: 'ok', subject: warningId })
      acks.set(warningId, { by: actor.name, at: now() })
    },
  }
}
