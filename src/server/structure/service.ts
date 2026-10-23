import type { TargetPool } from '../db/target-pool'
import { resolveTable } from '../db/schema'
import { getRuntime } from '../runtime'
import type { LiveSession } from '../sessions'
import {
  assertWritable,
  auditStructure,
  buildStatements,
  capabilitiesFor,
  createTokenIssuer,
  hashStatements,
  type TokenIssuer,
} from './deps'
import { executePlan } from './execute'
import { StructureRefusal, toClientError } from './errors'
import {
  databaseExists,
  fingerprint,
  introspectTable,
  readLists,
  readServerInfo,
} from './introspect'
import { planStore as defaultStore, type PlanStore } from './plans'
import {
  executeInput,
  previewInput,
  type BuildContext,
  type ExecuteInput,
  type ExecuteResult,
  type GuardContext,
  type PreviewInput,
  type PreviewResult,
  type StructureAuditEvent,
  type StructureLists,
  type TableDefinition,
} from './types'

// ---- Plain functions (testable without HTTP) --------------------------------------------------------

/** What the plain functions need from the request context. */
export type StructureEnv = {
  session: Pick<LiveSession, 'idHash' | 'target'> & { pool: TargetPool }
  guard: GuardContext
  tokens: TokenIssuer
  statementTimeoutMs: number
  plans?: PlanStore
  now?: () => number
}

const SYSTEM_SCHEMAS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys'])

const targetLabel = (t: StructureEnv['session']['target']) => `${t.host}${t.zone ?? ''}:${t.port}`

/** Names of the databases a request touches, for the system-schema rule (FR-STR-010). */
function databasesOf(input: PreviewInput): string[] {
  switch (input.action) {
    case 'createDatabase':
    case 'dropDatabase':
      return [input.name]
    case 'createTable':
      return [input.table.db]
    case 'renameTable':
      return input.newDb ? [input.db, input.newDb] : [input.db]
    default:
      return [input.db]
  }
}

function assertNotSystem(input: PreviewInput): void {
  if (databasesOf(input).some((d) => SYSTEM_SCHEMAS.has(d.toLowerCase()))) {
    throw new StructureRefusal('system_schema', 'System schemas cannot be changed')
  }
}

export async function listsImpl(env: StructureEnv): Promise<StructureLists> {
  return readLists(env.session.pool)
}

export async function previewImpl(env: StructureEnv, input: PreviewInput): Promise<PreviewResult> {
  try {
    const plans = env.plans ?? defaultStore
    const pool = env.session.pool
    assertNotSystem(input)

    // Existing names must exist on the server before they reach the builder (SEC-TGT-116).
    let current: TableDefinition | undefined
    let planDb: string | undefined
    let planTable: string | undefined
    switch (input.action) {
      case 'createDatabase':
        break
      case 'dropDatabase':
        if (!(await databaseExists(pool, input.name)))
          throw new StructureRefusal('not_found', 'Not found')
        break
      case 'createTable':
        if (!(await databaseExists(pool, input.table.db))) {
          throw new StructureRefusal('not_found', 'Not found')
        }
        planDb = input.table.db
        break
      case 'alterTable':
      case 'renameTable': {
        const read = await introspectTable(pool, input.db, input.table)
        if (input.action === 'alterTable' && read.unsupportedColumns.length > 0) {
          throw new StructureRefusal(
            'unsupported_column_type',
            'The table has column types this editor cannot express yet',
          )
        }
        current = read.def
        planDb = input.db
        planTable = input.table
        break
      }
      case 'truncateTable':
      case 'dropTable': {
        const resolved = await resolveTable(pool, input.db, input.table)
        const isView = resolved.kind === 'view'
        if (input.action === 'truncateTable' && isView) {
          throw new StructureRefusal('kind_mismatch', 'A view cannot be emptied')
        }
        if (input.action === 'dropTable' && (input.view ?? false) !== isView) {
          throw new StructureRefusal(
            'kind_mismatch',
            isView ? 'This is a view; drop it as a view' : 'This is a table, not a view',
          )
        }
        planDb = input.db
        planTable = input.table
        break
      }
    }

    const server = await readServerInfo(pool)
    const ctx: BuildContext = { server, capabilities: capabilitiesFor(server), current }
    if (input.action === 'createTable') {
      const lists = await readLists(pool)
      ctx.charsetDefaults = Object.fromEntries(
        lists.charsets.map((c) => [c.name, c.defaultCollation]),
      )
    }
    const built = buildStatements(input, ctx)
    const statementsHash = hashStatements(built.statements)
    const stored = plans.create(env.session.idHash, {
      statements: built.statements,
      warnings: built.warnings,
      statementsHash,
      ...(current ? { fingerprint: fingerprint(current) } : {}),
      ...(planDb !== undefined ? { db: planDb } : {}),
      ...(planTable !== undefined ? { table: planTable } : {}),
    })

    const confirmRequired = built.statements.some((s) => s.class === 'hard')
    const result: PreviewResult = {
      planId: stored.planId,
      statements: built.statements,
      warnings: built.warnings,
      confirmRequired,
      expiresAt: stored.expiresAt,
    }
    if (confirmRequired) {
      result.confirmToken = env.tokens.issue({
        sessionId: env.session.idHash,
        target: targetLabel(env.session.target),
        planId: stored.planId,
        statementsHash,
        expiresAt: stored.expiresAt,
      })
    }
    if (input.action === 'dropDatabase') result.confirmName = input.name
    if (input.action === 'dropTable' || input.action === 'truncateTable') {
      result.confirmName = input.table
    }
    return result
  } catch (error) {
    throw toClientError(error)
  }
}

export async function executeImpl(env: StructureEnv, input: ExecuteInput): Promise<ExecuteResult> {
  const plans = env.plans ?? defaultStore
  const { session } = env
  const user = session.target.username
  const target = targetLabel(session.target)
  const plan = plans.get(session.idHash, input.planId)

  const refused = (): void => {
    if (!plan) return
    const worst = plan.statements.find((s) => s.class === 'hard') ?? plan.statements[0]
    if (!worst) return
    const event: StructureAuditEvent = {
      user,
      target,
      kind: worst.kind,
      class: worst.class,
      statementHash: plan.statementsHash,
      outcome: 'refused',
    }
    auditStructure(event)
  }

  try {
    // The guard comes first: a read-only session never touches the pool or the plan.
    assertWritable(env.guard)
  } catch (error) {
    refused()
    throw toClientError(error)
  }

  try {
    if (!plan) throw new StructureRefusal('plan_expired', 'The plan has expired or does not exist')
    if (plan.statements.some((s) => s.class === 'hard')) {
      env.tokens.verifyAndConsume(
        input.confirmToken,
        {
          sessionId: session.idHash,
          target,
          planId: plan.planId,
          statementsHash: plan.statementsHash,
        },
        (env.now ?? Date.now)(),
      )
    }
  } catch (error) {
    refused()
    throw toClientError(error)
  }

  // From here on the plan is spent, whatever happens.
  plans.consume(plan.planId)
  try {
    return await executePlan(
      { pool: session.pool, user, target, statementTimeoutMs: env.statementTimeoutMs },
      plan,
    )
  } catch (error) {
    if (error instanceof StructureRefusal) refused()
    throw toClientError(error)
  }
}

// ---- Server functions ---------------------------------------------------------------------------------

const tokens = createTokenIssuer()

export function envOf(session: LiveSession): StructureEnv {
  const { config } = getRuntime()
  return {
    session,
    guard: {
      forcedReadOnly: config.readOnly,
      sessionReadOnly: session.readOnly,
    },
    tokens,
    statementTimeoutMs: config.statementTimeoutMs,
  }
}

/** Rejects keys the schema would silently drop, so a request carrying a `sql` field fails (FR-STR-001). */
function rejectExtraKeys(raw: unknown, parsed: unknown, path = ''): void {
  if (Array.isArray(raw)) {
    raw.forEach((item, i) =>
      rejectExtraKeys(item, (parsed as unknown[] | undefined)?.[i], `${path}[${i}]`),
    )
    return
  }
  if (raw && typeof raw === 'object') {
    const kept = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
    for (const [key, value] of Object.entries(raw)) {
      if (!(key in kept)) throw new Error(`invalid_request: unknown field ${path}.${key}`)
      rejectExtraKeys(value, kept[key], `${path}.${key}`)
    }
  }
}

export function parsePreviewInput(raw: unknown): PreviewInput {
  const parsed = previewInput.parse(raw)
  rejectExtraKeys(raw, parsed)
  return parsed
}

export function parseExecuteInput(raw: unknown): ExecuteInput {
  const parsed = executeInput.parse(raw)
  rejectExtraKeys(raw, parsed)
  return parsed
}

/** Current definition of an existing table, for the alter designer and the foreign-key editor. */
export async function definitionImpl(
  env: StructureEnv,
  db: string,
  table: string,
): Promise<{ def: TableDefinition; unsupportedColumns: string[] }> {
  if (SYSTEM_SCHEMAS.has(db.toLowerCase())) {
    throw new StructureRefusal('system_schema', 'System schemas cannot be changed')
  }
  try {
    return await introspectTable(env.session.pool, db, table)
  } catch (error) {
    throw toClientError(error)
  }
}
