import { describe, expect, it } from 'vitest'
import { classifyChange, maxClass } from '../src/server/rows/classes'
import type { FkInfo, Identity, RowChange, RowTable } from '../src/server/rows/types'
import { col, tbl } from './rows-a-helpers'

const g = (s: string) => ({ t: 'v' as const, v: s })
const target = (id: string) => ({ key: { id: g(id) }, old: { name: g('x') } })
const pk: Identity = { kind: 'primary', columns: ['id'] }
const unique: Identity = { kind: 'unique', columns: ['id'] }
const allCols: Identity = { kind: 'all-columns', columns: ['id', 'name'] }
const base = tbl([col('id', 'int'), col('name', 'char')], { primaryKey: ['id'] })
const cascadeIn = (o: Partial<FkInfo>): FkInfo => ({
  name: 'fk_orders',
  columns: ['customer_id'],
  refDb: 'shop',
  refTable: 'orders',
  refColumns: ['id'],
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
  ...o,
})

const insert = (n: number, ignore = false): RowChange => ({
  op: 'insert',
  ignore,
  rows: Array.from({ length: n }, () => ({ name: { t: 'v', v: 'a' } })),
})
const update = (n: number, set: string[] = ['name']): RowChange => ({
  op: 'update',
  set: Object.fromEntries(set.map((c) => [c, { t: 'v' as const, v: '1' }])),
  targets: Array.from({ length: n }, (_, i) => target(String(i))),
})
const del = (n: number): RowChange => ({
  op: 'delete',
  targets: Array.from({ length: n }, (_, i) => target(String(i))),
})

const cls = (t: RowTable, id: Identity, c: RowChange) => classifyChange(t, id, c)

describe('class table of FR-ROW-020', () => {
  it('insert needs no confirmation, however many rows', () => {
    expect(cls(base, pk, insert(1)).class).toBe('none')
    expect(cls(base, pk, insert(100)).class).toBe('none')
    expect(cls(base, pk, insert(100)).reasons).toEqual([])
  })

  it('insert with IGNORE on a non-transactional engine is soft', () => {
    const myisam = { ...base, engine: 'MyISAM', transactional: false }
    expect(cls(myisam, pk, insert(1, true))).toMatchObject({
      class: 'soft',
      reasons: ['engine-nontransactional'],
    })
    expect(cls(base, pk, insert(1, true)).class).toBe('none')
    expect(cls(myisam, pk, insert(1, false)).class).toBe('none')
  })

  it('update of one row by primary or unique key is none; of several rows soft', () => {
    expect(cls(base, pk, update(1)).class).toBe('none')
    expect(cls(base, unique, update(1)).class).toBe('none')
    expect(cls(base, pk, update(2))).toMatchObject({ class: 'soft', reasons: ['bulk'] })
    expect(cls(base, pk, update(1000)).class).toBe('soft')
  })

  it('delete of one row by key is soft; of two or more hard', () => {
    expect(cls(base, pk, del(1))).toMatchObject({ class: 'soft', reasons: ['delete'] })
    expect(cls(base, unique, del(1)).class).toBe('soft')
    expect(cls(base, pk, del(2))).toMatchObject({ class: 'hard', reasons: ['delete', 'bulk'] })
  })

  it('any write by all-columns identity is hard, with the hint to add a key', () => {
    for (const change of [update(1), del(1)]) {
      const out = cls(base, allCols, change)
      expect(out.class).toBe('hard')
      expect(out.reasons).toContain('no-key')
      expect(out.warnings.map((w) => w.code)).toContain('no-key')
    }
    expect(cls(base, allCols, update(1)).warnings[0]!.message).toMatch(/primary key/)
  })

  it('a delete with an ON DELETE CASCADE referencing table is hard and lists the table', () => {
    const t = { ...base, incoming: [cascadeIn({ onDelete: 'CASCADE' })] }
    const out = cls(t, pk, del(1))
    expect(out.class).toBe('hard')
    expect(out.reasons).toContain('cascade')
    expect(out.cascadeTables).toEqual([{ db: 'shop', table: 'orders', fk: 'fk_orders' }])
    // a restricting or SET NULL rule does not cascade
    expect(
      cls({ ...base, incoming: [cascadeIn({ onDelete: 'SET NULL' })] }, pk, del(1)).class,
    ).toBe('soft')
    expect(cls({ ...base, incoming: [cascadeIn({})] }, pk, del(1)).class).toBe('soft')
  })

  it('an update cascades only when it touches the referenced columns; an insert never', () => {
    const t = { ...base, incoming: [cascadeIn({ onUpdate: 'CASCADE', onDelete: 'CASCADE' })] }
    expect(cls(t, pk, update(1, ['name'])).class).toBe('none')
    expect(cls(t, pk, update(1, ['id']))).toMatchObject({ class: 'hard', reasons: ['cascade'] })
    expect(cls(t, pk, insert(3)).class).toBe('none')
  })

  it('non-transactional engines get the no-rollback warning for several statements', () => {
    const myisam = { ...base, engine: 'MyISAM', transactional: false }
    const out = cls(myisam, pk, update(3))
    expect(out.class).toBe('soft')
    expect(out.reasons).toEqual(['bulk', 'no-rollback'])
    expect(out.warnings.map((w) => w.code)).toEqual(['no-rollback'])
    expect(cls(myisam, pk, update(1)).warnings).toEqual([])
    expect(cls(myisam, pk, insert(2)).warnings.map((w) => w.code)).toEqual(['no-rollback'])
    expect(cls(base, pk, update(3)).warnings).toEqual([])
  })

  it('counts the statements', () => {
    expect(cls(base, pk, insert(4)).statements).toBe(4)
    expect(cls(base, pk, del(7)).statements).toBe(7)
  })

  it('refuses views and rows without an identity', () => {
    expect(() => cls({ ...base, kind: 'view' }, pk, insert(1))).toThrow(/read-only/)
    expect(() => cls(base, { kind: 'none', reason: 'no-key-unsafe-columns' }, del(1))).toThrow()
    expect(cls(base, { kind: 'none', reason: 'no-key-unsafe-columns' }, insert(1)).class).toBe(
      'none',
    )
  })

  it('maxClass orders none < soft < hard', () => {
    expect(maxClass('none', 'soft')).toBe('soft')
    expect(maxClass('hard', 'soft')).toBe('hard')
    expect(maxClass('none', 'none')).toBe('none')
  })
})
