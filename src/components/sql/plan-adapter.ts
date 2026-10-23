import { parsePlan, type PlanNode as TreeNode } from '~/lib/sql/plan-tree'

/** Display shape of the explain view; built from package B's tree (src/lib/sql/plan-tree.ts). */
export type PlanNode = {
  label: string
  /** Short facts such as "rows 120", "type ref", "cost 3.4". */
  facts: string[]
  children: PlanNode[]
}

const MAX_NODES = 2000

function convert(n: TreeNode, budget: { n: number }): PlanNode {
  const facts: string[] = []
  if (n.accessType) facts.push(`type ${n.accessType}`)
  if (n.rows !== undefined) facts.push(`rows ${n.rows}`)
  if (n.cost !== undefined) facts.push(`cost ${n.cost}`)
  if (n.actualRows !== undefined) facts.push(`actual rows ${n.actualRows}`)
  if (n.actualTimeMs !== undefined) facts.push(`actual time ${n.actualTimeMs} ms`)
  if (n.loops !== undefined) facts.push(`loops ${n.loops}`)
  if (n.neverExecuted) facts.push('never executed')
  if (n.detail) facts.push(n.detail)
  const children: PlanNode[] = []
  for (const c of n.children) {
    if (budget.n++ > MAX_NODES) break
    children.push(convert(c, budget))
  }
  const label = n.table && n.table !== n.label ? `${n.label} ${n.table}` : n.label
  return { label, facts, children }
}

/** Returns the plan tree, or an empty list when the output has an unknown shape (the raw text is still shown). */
export function buildPlan(raw: string): PlanNode[] {
  try {
    const root = parsePlan(raw)
    return root ? [convert(root, { n: 0 })] : []
  } catch {
    return []
  }
}

/** Pretty JSON for the raw view when the output is JSON; otherwise the text unchanged. */
export function prettyRaw(raw: string): string {
  if (!raw.trimStart().startsWith('{')) return raw
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
