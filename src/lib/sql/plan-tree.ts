/**
 * Pure parser from EXPLAIN / ANALYZE output to a tree (FR-SQL-021, spec 5.9). No Node imports: the browser
 * uses it to draw the plan. Unknown shapes give `undefined`, and the UI then shows the raw text only.
 */

export type PlanNode = {
  /** Short title: the operation (text plans) or `table_name` / block name (JSON plans). */
  label: string
  /** Rest of the line or a short summary of the node's facts. */
  detail?: string
  table?: string
  accessType?: string
  /** Estimated rows. */
  rows?: number
  cost?: number
  /** Measured by ANALYZE. */
  actualRows?: number
  actualTimeMs?: number
  loops?: number
  neverExecuted?: boolean
  children: PlanNode[]
}

const node = (label: string, extra: Partial<PlanNode> = {}): PlanNode => ({
  label,
  ...extra,
  children: [],
})

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

// ---- MySQL EXPLAIN [ANALYZE] text tree -----------------------------------------------------------------

const COST = /\(cost=([\d.eE+-]+) rows=([\d.eE+-]+)\)/
const ACTUAL = /\(actual time=([\d.eE+-]+)\.\.([\d.eE+-]+) rows=([\d.eE+-]+) loops=([\d.eE+-]+)\)/
const NEVER = /\(never executed\)/
const ON_TABLE = / on (`[^`]+`|[\w$]+)(?:\.(`[^`]+`|[\w$]+))?/

function fromTreeLine(body: string): PlanNode {
  const cost = COST.exec(body)
  const actual = ACTUAL.exec(body)
  const cut = cost ? body.indexOf(cost[0]) : actual ? body.indexOf(actual[0]) : body.length
  const head = body.slice(0, cut).trim()
  const colon = head.indexOf(':')
  const label = colon > 0 && colon < 60 ? head.slice(0, colon) : head
  const on = ON_TABLE.exec(head)
  const table = on ? (on[2] ?? on[1])?.replaceAll('`', '') : undefined
  const n = node(label, {
    ...(colon > 0 && colon < 60 && head.slice(colon + 1).trim()
      ? { detail: head.slice(colon + 1).trim() }
      : {}),
    ...(table ? { table } : {}),
  })
  if (cost) {
    const c = num(cost[1])
    const r = num(cost[2])
    if (c !== undefined) n.cost = c
    if (r !== undefined) n.rows = r
  }
  if (actual) {
    n.actualTimeMs = num(actual[2])
    n.actualRows = num(actual[3])
    n.loops = num(actual[4])
  }
  if (NEVER.test(body)) n.neverExecuted = true
  return n
}

/** Parses MySQL 8.4 `EXPLAIN FORMAT=TREE` / `EXPLAIN ANALYZE` text by the indentation of `->` lines. */
export function parseMysqlTree(text: string): PlanNode | undefined {
  const lines = text.split(/\r?\n/)
  const stack: { indent: number; node: PlanNode }[] = []
  let root: PlanNode | undefined
  let last: PlanNode | undefined
  for (const line of lines) {
    const m = /^(\s*)-> (.*)$/.exec(line)
    if (!m) {
      // continuation of the previous node (long expressions wrap in some servers)
      if (last && line.trim() !== '') last.detail = `${last.detail ?? ''} ${line.trim()}`.trim()
      continue
    }
    const indent = m[1]!.length
    const n = fromTreeLine(m[2]!)
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop()
    const parent = stack[stack.length - 1]?.node
    if (parent) parent.children.push(n)
    else if (!root) root = n
    else {
      // a second root: wrap both (should not happen)
      const wrap = node('plan', { children: [root, n] })
      root = wrap
    }
    stack.push({ indent, node: n })
    last = n
  }
  return root
}

// ---- JSON plans (MySQL EXPLAIN FORMAT=JSON, MariaDB EXPLAIN / ANALYZE FORMAT=JSON) -----------------------

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

function tableNode(t: Json): PlanNode {
  const name = typeof t.table_name === 'string' ? t.table_name : 'table'
  const access = typeof t.access_type === 'string' ? t.access_type : undefined
  const n = node(name, { table: name })
  if (access) n.accessType = access
  const rows = num(t.rows_examined_per_scan) ?? num(t.rows)
  if (rows !== undefined) n.rows = rows
  const cost = isObj(t.cost_info) ? num(t.cost_info.prefix_cost) : undefined
  if (cost !== undefined) n.cost = cost
  const ar = num(t.r_rows)
  if (ar !== undefined) n.actualRows = ar
  const at = num(t.r_total_time_ms)
  if (at !== undefined) n.actualTimeMs = at
  const loops = num(t.r_loops)
  if (loops !== undefined) n.loops = loops
  const bits: string[] = []
  if (typeof t.key === 'string') bits.push(`key ${t.key}`)
  if (typeof t.attached_condition === 'string') bits.push(`where ${t.attached_condition}`)
  if (typeof t.message === 'string') bits.push(t.message)
  if (bits.length > 0) n.detail = bits.join('; ')
  walkChildren(t, n)
  return n
}

/** Keys whose values hold nested plan parts. */
function walkChildren(obj: Json, parent: PlanNode): void {
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'table' && isObj(value)) parent.children.push(tableNode(value))
    else if (key === 'query_block' && isObj(value)) parent.children.push(blockNode(value, key))
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (!isObj(item)) continue
        if (key === 'nested_loop') {
          walkChildren(item, parent)
        } else if (
          'query_block' in item ||
          'table' in item ||
          'nested_loop' in item ||
          'query_specifications' in item
        ) {
          const wrap = node(key)
          walkChildren(item, wrap)
          if (wrap.children.length > 0) parent.children.push(wrap)
        } else if ('select_id' in item) {
          parent.children.push(blockNode(item, key))
        }
      }
    } else if (isObj(value) && key !== 'cost_info' && key !== 'used_columns') {
      if (
        'query_block' in value ||
        'table' in value ||
        'nested_loop' in value ||
        'select_id' in value
      ) {
        const wrap = 'select_id' in value ? blockNode(value, key) : node(key)
        if (!('select_id' in value)) walkChildren(value, wrap)
        parent.children.push(wrap)
      }
    }
  }
}

function blockNode(b: Json, label: string): PlanNode {
  const n = node(label === 'query_block' ? 'query block' : label)
  const id = num(b.select_id)
  if (id !== undefined) n.detail = `select #${id}`
  const cost = isObj(b.cost_info) ? num(b.cost_info.query_cost) : undefined
  if (cost !== undefined) n.cost = cost
  const t = num(b.r_total_time_ms)
  if (t !== undefined) n.actualTimeMs = t
  const loops = num(b.r_loops)
  if (loops !== undefined) n.loops = loops
  walkChildren(b, n)
  return n
}

export function parseJsonPlan(raw: string): PlanNode | undefined {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isObj(data)) return undefined
  const qb = data.query_block
  if (!isObj(qb)) return undefined
  const root = blockNode(qb, 'query_block')
  const opt = isObj(data.query_optimization)
    ? num(data.query_optimization.r_total_time_ms)
    : undefined
  if (opt !== undefined && root.actualTimeMs === undefined) root.actualTimeMs = opt
  return root
}

/** Detects the shape from the text: JSON object or `->` tree. */
export function parsePlan(raw: string): PlanNode | undefined {
  const t = raw.trimStart()
  if (t.startsWith('{')) return parseJsonPlan(raw)
  if (t.startsWith('->')) return parseMysqlTree(raw)
  return undefined
}
