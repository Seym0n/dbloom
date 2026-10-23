import { randomBytes } from 'node:crypto'
import type { PlanWarning, Statement } from './types'

export const PLAN_TTL_MS = 10 * 60_000

export type StoredPlan = {
  planId: string
  sessionId: string
  statements: Statement[]
  warnings: PlanWarning[]
  statementsHash: string
  /** Fingerprint of the table at preview time; set for plans that alter or rename a table. */
  fingerprint?: string
  db?: string
  table?: string
  createdAt: number
  expiresAt: number
}

export type NewPlan = Omit<StoredPlan, 'planId' | 'sessionId' | 'createdAt' | 'expiresAt'>

/**
 * In-memory plans, scoped by session id (SEC-TGT-114). A plan is single use and lives 10 minutes.
 * The client only ever holds the opaque plan id.
 */
export class PlanStore {
  private plans = new Map<string, StoredPlan>()

  constructor(
    private now: () => number = Date.now,
    private ttlMs = PLAN_TTL_MS,
  ) {}

  create(sessionId: string, data: NewPlan): StoredPlan {
    this.sweep()
    const createdAt = this.now()
    const plan: StoredPlan = {
      ...data,
      planId: randomBytes(16).toString('base64url'),
      sessionId,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    }
    this.plans.set(plan.planId, plan)
    return plan
  }

  /** The plan if it belongs to this session and has not expired; the same answer for every other case. */
  get(sessionId: string, planId: string): StoredPlan | undefined {
    const plan = this.plans.get(planId)
    if (!plan) return undefined
    if (this.now() >= plan.expiresAt) {
      this.plans.delete(planId)
      return undefined
    }
    return plan.sessionId === sessionId ? plan : undefined
  }

  /** Removes the plan so it cannot run twice. */
  consume(planId: string): void {
    this.plans.delete(planId)
  }

  /** Called when a session ends. */
  dropSession(sessionId: string): void {
    for (const [id, plan] of this.plans) if (plan.sessionId === sessionId) this.plans.delete(id)
  }

  sweep(): void {
    const now = this.now()
    for (const [id, plan] of this.plans) if (now >= plan.expiresAt) this.plans.delete(id)
  }

  get size(): number {
    return this.plans.size
  }
}

/** Process-wide store; swept every minute. Session end should call `planStore.dropSession`. */
export const planStore = new PlanStore()
setInterval(() => planStore.sweep(), 60_000).unref()
