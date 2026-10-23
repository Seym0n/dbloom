import { describe, expect, test } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { keys, refreshAfterStructure } from '~/components/structure/invalidate'
import {
  buildCreateInput,
  type Draft,
  diffToOps,
  draftFromDefinition,
  duplicateIndexKeys,
  emptyDraft,
  hasFourByteChars,
  moveItem,
  newKey,
  removeColumn,
  setColumnName,
  togglePrimaryKey,
  typeDisabledReason,
  validateDraft,
} from '~/components/structure/model'
import { describeRefusal } from '~/components/structure/refusal'
import {
  CAPABILITY_KEYS,
  previewInput,
  type Capabilities,
  type TableDefinition,
} from '~/server/structure/types'

const caps = (over: Partial<Capabilities> = {}): Capabilities =>
  ({
    ...Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, true])),
    ...over,
  }) as Capabilities

const current = (): TableDefinition => ({
  db: 'shop',
  name: 'customer',
  columns: [
    {
      name: 'id',
      type: 'bigint',
      unsigned: true,
      nullable: false,
      autoIncrement: true,
      default: { kind: 'none' },
    },
    { name: 'name', type: 'varchar', length: 100, nullable: false, default: { kind: 'none' } },
    { name: 'note', type: 'text', nullable: true, default: { kind: 'none' } },
  ],
  indexes: [
    { kind: 'primary', parts: [{ column: 'id' }] },
    { kind: 'index', name: 'idx_name', parts: [{ column: 'name' }] },
  ],
  fks: [],
  checks: [{ name: 'chk_id', sql: 'id > 0' }],
  engine: 'InnoDB',
})

describe('validateDraft', () => {
  test('an empty new table has an inline error on the name only', () => {
    const errors = validateDraft({ db: 'shop', tableName: '', draft: emptyDraft(), caps: caps() })
    expect(Object.keys(errors)).toEqual(['name'])
    expect(errors['name']?.key).toBe('structure.err.required')
  })

  test('a valid draft has no errors', () => {
    const errors = validateDraft({
      db: 'shop',
      tableName: 'customer',
      draft: emptyDraft(),
      caps: caps(),
    })
    expect(errors).toEqual({})
  })

  test('duplicate column names, unknown index columns and a second primary key are flagged', () => {
    const draft = emptyDraft()
    draft.columns.push({
      key: newKey(),
      ref: 'ID',
      def: { name: 'ID', type: 'int', nullable: true, default: { kind: 'none' } },
    })
    draft.indexes.push({
      key: newKey(),
      def: { kind: 'primary', parts: [{ column: 'id' }] },
    })
    draft.indexes.push({
      key: newKey(),
      def: { kind: 'index', name: 'ix', parts: [{ column: 'missing' }] },
    })
    const errors = validateDraft({ db: 'shop', tableName: 't', draft, caps: caps() })
    expect(errors['columns.1.name']?.key).toBe('structure.err.duplicate')
    expect(errors['indexes.1.kind']?.key).toBe('structure.err.onePrimary')
    expect(errors['indexes.2.parts.0.column']?.key).toBe('structure.err.unknownColumn')
  })

  test('a missing capability marks the type', () => {
    const draft = emptyDraft()
    draft.columns[0]!.def = {
      name: 'doc',
      type: 'json',
      nullable: true,
      default: { kind: 'none' },
    }
    const errors = validateDraft({
      db: 'shop',
      tableName: 't',
      draft,
      caps: caps({ 'type-json': false }),
    })
    expect(errors['columns.0.type']?.key).toBe('structure.unsupported')
    expect(typeDisabledReason('json', caps({ 'type-json': false }))).toBe('structure.unsupported')
    expect(typeDisabledReason('int', caps())).toBeNull()
  })
})

describe('buildCreateInput', () => {
  test('produces an input the server schema accepts', () => {
    const draft = emptyDraft()
    draft.name = 'customer'
    const input = buildCreateInput('shop', draft)
    expect(previewInput.safeParse(input).success).toBe(true)
  })
})

describe('draft edits', () => {
  test('renaming a column follows it into indexes', () => {
    const draft = emptyDraft()
    const key = draft.columns[0]!.key
    const next = setColumnName(draft, key, 'customer_id')
    expect(next.columns[0]!.def.name).toBe('customer_id')
    expect(next.indexes[0]!.def.parts[0]!.column).toBe('customer_id')
  })

  test('togglePrimaryKey adds and removes a column; an empty key disappears', () => {
    const draft = emptyDraft()
    const without = togglePrimaryKey(draft, 'id')
    expect(without.indexes).toHaveLength(0)
    const again = togglePrimaryKey(without, 'id')
    expect(again.indexes[0]!.def.kind).toBe('primary')
  })

  test('removing a new column drops it from indexes; removing an existing one only marks it', () => {
    const fresh = emptyDraft()
    expect(removeColumn(fresh, fresh.columns[0]!.key).indexes).toHaveLength(0)
    const existing = draftFromDefinition(current())
    const marked = removeColumn(existing, existing.columns[2]!.key)
    expect(marked.columns[2]!.removed).toBe(true)
    expect(removeColumn(marked, marked.columns[2]!.key).columns[2]!.removed).toBe(false)
  })

  test('moveItem moves and ignores out-of-range moves', () => {
    expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1])
    const same = [1, 2, 3]
    expect(moveItem(same, 0, 5)).toBe(same)
  })

  test('duplicateIndexKeys finds an index that repeats the start of another', () => {
    const idx = (name: string, ...cols: string[]) => ({
      key: name,
      def: { kind: 'index' as const, name, parts: cols.map((column) => ({ column })) },
    })
    const found = duplicateIndexKeys([idx('a', 'x'), idx('b', 'x', 'y'), idx('c', 'z')])
    expect([...found].sort()).toEqual(['a', 'b'])
  })
})

describe('diffToOps', () => {
  const edit = (change: (d: Draft) => void) => {
    const draft = draftFromDefinition(current())
    change(draft)
    return diffToOps(current(), draft, caps())
  }

  test('an untouched table has no operations', () => {
    expect(edit(() => {})).toEqual([])
  })

  test('a removed column becomes dropColumn', () => {
    expect(edit((d) => (d.columns[2]!.removed = true))).toEqual([
      { op: 'dropColumn', name: 'note' },
    ])
  })

  test('a pure rename becomes renameColumn', () => {
    const ops = edit((d) => {
      d.columns[2]!.def.name = 'remark'
    })
    expect(ops).toEqual([{ op: 'renameColumn', from: 'note', to: 'remark' }])
  })

  test('a changed type becomes modifyColumn and a new column addColumn after the last one', () => {
    const ops = edit((d) => {
      d.columns[1]!.def.length = 200
      d.columns.push({
        key: newKey(),
        ref: 'age',
        def: { name: 'age', type: 'int', nullable: true, default: { kind: 'none' } },
      })
    })
    expect(ops.map((o) => o.op)).toEqual(['modifyColumn', 'addColumn'])
    expect(ops[1]).toMatchObject({ op: 'addColumn', after: 'note' })
  })

  test('a changed option becomes setOptions with only that option', () => {
    const ops = edit((d) => {
      d.options.comment = 'customers'
    })
    expect(ops).toEqual([{ op: 'setOptions', options: { comment: 'customers' } }])
  })
})

describe('refreshAfterStructure', () => {
  test('a dropped table leaves the cache, the table list is invalidated', async () => {
    const client = new QueryClient()
    client.setQueryData(keys.rows('shop', 'customer'), [1])
    client.setQueryData(keys.tables('shop'), [1])
    await refreshAfterStructure(client, { action: 'dropTable', db: 'shop', table: 'customer' })
    expect(client.getQueryData(keys.rows('shop', 'customer'))).toBeUndefined()
    expect(client.getQueryState(keys.tables('shop'))?.isInvalidated).toBe(true)
  })
})

describe('hasFourByteChars (column comment warning)', () => {
  test('flags characters above U+FFFF only', () => {
    expect(hasFourByteChars('')).toBe(false)
    expect(hasFourByteChars('plain text, ü, € and 日本語')).toBe(false)
    expect(hasFourByteChars('￿')).toBe(false)
    expect(hasFourByteChars('party \u{1F389}')).toBe(true)
    expect(hasFourByteChars('\u{10000}')).toBe(true)
  })
})

describe('describeRefusal', () => {
  const fail = (m: string) => new Error(m)

  test('known codes become translated text without the code prefix', () => {
    for (const code of [
      'stale_plan',
      'plan_expired',
      'read-only',
      'token-missing',
      'token-invalid',
      'token-expired',
      'token-used',
      'system_schema',
      'not_found',
      'kind_mismatch',
    ]) {
      const r = describeRefusal(fail(`${code}: raw server text`))
      expect(r.code).toBe(code)
      expect(r.message).not.toContain(`${code}:`)
      expect(r.message).not.toContain('raw server text')
      expect(r.message.length).toBeGreaterThan(10)
    }
  })

  test('a new preview is offered for stale and expired plans', () => {
    expect(describeRefusal(fail('stale_plan: x')).offerNewPreview).toBe(true)
    expect(describeRefusal(fail('plan_expired: x')).offerNewPreview).toBe(true)
    expect(describeRefusal(fail('read-only: x')).offerNewPreview).toBe(false)
    expect(describeRefusal(fail('not_found: x')).offerNewPreview).toBe(false)
  })

  test('unknown codes show the message, plain errors stay as they are', () => {
    expect(describeRefusal(fail('invalid: Duplicate column names')).message).toBe(
      'Duplicate column names',
    )
    expect(describeRefusal(fail('Network down')).message).toBe('Network down')
    expect(describeRefusal('nope').message).not.toBe('')
  })
})
