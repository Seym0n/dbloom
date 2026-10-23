import { describe, expect, test } from 'vitest'
import { parseJsonPlan, parseMysqlTree, parsePlan, type PlanNode } from '~/lib/sql/plan-tree'

const walk = (n: PlanNode, f: (n: PlanNode) => void) => {
  f(n)
  n.children.forEach((c) => walk(c, f))
}

const MYSQL_ANALYZE = `-> Limit: 10 row(s)  (cost=102 rows=10) (actual time=0.31..0.35 rows=10 loops=1)
    -> Sort: c.name, limit input to 10 row(s) per chunk  (cost=102 rows=1000) (actual time=0.3..0.31 rows=10 loops=1)
        -> Filter: (c.id > 5)  (cost=102 rows=333) (actual time=0.04..0.2 rows=995 loops=1)
            -> Table scan on c  (cost=102 rows=1000) (actual time=0.03..0.15 rows=1000 loops=1)
`

describe('MySQL EXPLAIN ANALYZE text', () => {
  test('indentation builds the tree', () => {
    const root = parseMysqlTree(MYSQL_ANALYZE)!
    expect(root.label).toBe('Limit')
    expect(root.children).toHaveLength(1)
    const sort = root.children[0]!
    expect(sort.label).toBe('Sort')
    expect(sort.children[0]!.label).toBe('Filter')
    const scan = sort.children[0]!.children[0]!
    expect(scan.label).toBe('Table scan on c')
    expect(scan.table).toBe('c')
    expect(scan).toMatchObject({
      cost: 102,
      rows: 1000,
      actualRows: 1000,
      loops: 1,
      actualTimeMs: 0.15,
    })
  })

  test('siblings and never executed', () => {
    const t = `-> Nested loop inner join  (cost=2 rows=2)
    -> Table scan on a  (cost=1 rows=1)
    -> Single-row index lookup on b using PRIMARY (id=a.id)  (cost=1 rows=1) (never executed)
`
    const root = parseMysqlTree(t)!
    expect(root.children).toHaveLength(2)
    expect(root.children[0]!.label).toBe('Table scan on a')
    expect(root.children[1]!.neverExecuted).toBe(true)
    expect(root.children[1]!.table).toBe('b')
  })

  test('plain text without arrows is not a plan', () => {
    expect(parseMysqlTree('id\tselect_type\n1\tSIMPLE')).toBeUndefined()
    expect(parsePlan('id\tselect_type')).toBeUndefined()
  })
})

describe('JSON plans', () => {
  test('MySQL EXPLAIN FORMAT=JSON', () => {
    const raw = JSON.stringify({
      query_block: {
        select_id: 1,
        cost_info: { query_cost: '1.00' },
        table: {
          table_name: 'customer',
          access_type: 'const',
          key: 'PRIMARY',
          rows_examined_per_scan: 1,
          cost_info: { prefix_cost: '0.00' },
        },
      },
    })
    const root = parsePlan(raw)!
    expect(root.label).toBe('query block')
    expect(root.cost).toBe(1)
    expect(root.children[0]).toMatchObject({
      label: 'customer',
      accessType: 'const',
      rows: 1,
      table: 'customer',
    })
  })

  test('nested loop with two tables and a subquery', () => {
    const raw = JSON.stringify({
      query_block: {
        select_id: 1,
        nested_loop: [
          { table: { table_name: 'a', access_type: 'ALL', rows_examined_per_scan: 10 } },
          { table: { table_name: 'b', access_type: 'ref', rows_examined_per_scan: 2 } },
        ],
        attached_subqueries: [{ select_id: 2, table: { table_name: 'c', access_type: 'index' } }],
      },
    })
    const root = parseJsonPlan(raw)!
    const names: string[] = []
    walk(root, (n) => {
      if (n.table) names.push(n.table)
    })
    expect(names).toEqual(['a', 'b', 'c'])
  })

  test('MariaDB ANALYZE FORMAT=JSON carries the r_ fields', () => {
    const raw = JSON.stringify({
      query_optimization: { r_total_time_ms: 0.01 },
      query_block: {
        select_id: 1,
        r_loops: 1,
        r_total_time_ms: 0.2,
        table: {
          table_name: 'customer',
          access_type: 'ALL',
          r_loops: 1,
          rows: 1000,
          r_rows: 1000,
          r_total_time_ms: 0.15,
          attached_condition: '(customer.id > 5)',
        },
      },
    })
    const root = parseJsonPlan(raw)!
    expect(root.actualTimeMs).toBe(0.2)
    expect(root.children[0]).toMatchObject({
      rows: 1000,
      actualRows: 1000,
      actualTimeMs: 0.15,
      loops: 1,
    })
    expect(root.children[0]!.detail).toContain('where')
  })

  test('unknown shapes give undefined', () => {
    expect(parseJsonPlan('{"x":1}')).toBeUndefined()
    expect(parseJsonPlan('not json')).toBeUndefined()
    expect(parsePlan('[1,2]')).toBeUndefined()
  })
})
