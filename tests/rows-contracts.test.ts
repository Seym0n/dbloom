import { describe, expect, it } from 'vitest'
import { hashStatements } from '../src/server/guard/confirm-token'
import { changeRowsInput, filterWithinLimits, getRowsInput } from '../src/server/rows/types'
import type { FilterNode } from '../src/server/rows/types'
import type { Statement } from '../src/server/structure/types'

const base: Statement = {
  sql: 'DELETE FROM `d`.`t` WHERE `id` <=> ?',
  kind: 'rowDelete',
  class: 'soft',
  effect: 'x',
}

describe('rows contracts (task 0)', () => {
  it('hashStatements: params change the hash, absent params leave it as before', () => {
    const plain = hashStatements([base])
    expect(hashStatements([{ ...base, params: undefined }])).toBe(plain)
    const one = hashStatements([{ ...base, params: ['1'] }])
    expect(one).not.toBe(plain)
    expect(hashStatements([{ ...base, params: ['2'] }])).not.toBe(one)
    expect(hashStatements([{ ...base, params: [Buffer.from([1])] }])).not.toBe(
      hashStatements([{ ...base, params: [Buffer.from([2])] }]),
    )
  })

  it('rejects fields that carry SQL (FR-ROW-026)', () => {
    const ok = { db: 'd', table: 't', page: 0, pageSize: 50 }
    expect(getRowsInput.safeParse(ok).success).toBe(true)
    for (const bad of ['where', 'sql', 'orderBy', 'limit', 'class']) {
      expect(getRowsInput.safeParse({ ...ok, [bad]: 'x' }).success).toBe(false)
    }
    const change = { op: 'delete', targets: [{ key: { id: { t: 'v', v: '1' } }, old: {} }] }
    expect(changeRowsInput.safeParse({ db: 'd', table: 't', change }).success).toBe(true)
    expect(changeRowsInput.safeParse({ db: 'd', table: 't', change, class: 'none' }).success).toBe(
      false,
    )
  })

  it('filter limits: depth and duplicate IN values', () => {
    const cond: FilterNode = { type: 'condition', column: 'a', op: '=', values: ['1'] }
    let node: FilterNode = { type: 'group', op: 'and', children: [cond] }
    expect(filterWithinLimits(node)).toBe(true)
    let deep: FilterNode = cond
    for (let i = 0; i < 5; i++) deep = { type: 'group', op: 'or', children: [deep] }
    expect(filterWithinLimits(deep)).toBe(false)
    node = {
      type: 'group',
      op: 'and',
      children: [{ ...cond, op: 'in', values: ['1', '1'] }],
    } as never
    expect(filterWithinLimits(node)).toBe(false)
  })
})
