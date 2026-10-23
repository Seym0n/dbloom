import { useQuery } from '@tanstack/react-query'
import { Plus, Trash2, X } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Select } from '~/components/ui/select'
import { getDatabases, getTables } from '~/server/browse.functions'
import { REFERENTIAL_ACTIONS, type FkDef } from '~/server/structure/types'
import { t } from '~/i18n'
import { CellError, Field } from './field'
import { keys } from './invalidate'
import { newKey, type Draft, type FieldErrors, type FkRow } from './model'
import { useColumnNames } from './use-structure'

function FkCard({
  row,
  index,
  db,
  tableName,
  draft,
  setDraft,
  errors,
  disabled,
}: {
  row: FkRow
  index: number
  db: string
  tableName: string
  draft: Draft
  setDraft: (next: Draft) => void
  errors: FieldErrors
  disabled?: boolean
}) {
  const def = row.def
  const err = (path: string) => errors[`fks.${index}.${path}`]
  const databases = useQuery({ queryKey: keys.databases, queryFn: () => getDatabases() })
  const tables = useQuery({
    queryKey: keys.tables(def.refDb || '\u0000'),
    queryFn: () => getTables({ data: { db: def.refDb } }),
    enabled: def.refDb !== '',
  })
  const self = def.refDb === db && def.refTable === tableName
  const remote = useColumnNames(self ? '' : def.refDb, self ? '' : def.refTable)
  const ownColumns = draft.columns
    .filter((c) => !c.removed && c.def.name !== '')
    .map((c) => c.def.name)
  const refColumns = self ? ownColumns : (remote.data ?? [])

  const patch = (next: Partial<FkDef>) =>
    setDraft({
      ...draft,
      fks: draft.fks.map((f) => (f.key === row.key ? { ...f, def: { ...f.def, ...next } } : f)),
    })

  const pairCount = Math.max(def.columns.length, def.refColumns.length)
  const setPair = (j: number, local: string | undefined, remoteName: string | undefined) => {
    const columns = def.columns.slice()
    const refs = def.refColumns.slice()
    while (columns.length < pairCount) columns.push('')
    while (refs.length < pairCount) refs.push('')
    if (local !== undefined) columns[j] = local
    if (remoteName !== undefined) refs[j] = remoteName
    patch({ columns, refColumns: refs })
  }
  const removePair = (j: number) =>
    patch({
      columns: def.columns.filter((_, k) => k !== j),
      refColumns: def.refColumns.filter((_, k) => k !== j),
    })

  return (
    <li className="flex flex-col gap-3 rounded-[var(--radius-card)] bg-raised p-3">
      <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-4">
        <Field label={t('structure.fk.name')} error={err('name')}>
          {(p) => (
            <Input
              {...p}
              value={def.name ?? ''}
              placeholder={t('structure.index.nameAuto')}
              disabled={disabled}
              onChange={(e) => patch({ name: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </Field>
        <Field label={t('structure.fk.refDb')} error={err('refDb')}>
          {(p) => (
            <Select
              {...p}
              value={def.refDb}
              disabled={disabled}
              onChange={(e) =>
                patch({
                  refDb: e.target.value,
                  refTable: '',
                  refColumns: def.columns.map(() => ''),
                })
              }
            >
              <option value="">{t('structure.choose')}</option>
              {(databases.data ?? []).map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('structure.fk.refTable')} error={err('refTable')}>
          {(p) => (
            <Select
              {...p}
              value={def.refTable}
              disabled={disabled || def.refDb === ''}
              onChange={(e) =>
                patch({ refTable: e.target.value, refColumns: def.columns.map(() => '') })
              }
            >
              <option value="">{t('structure.choose')}</option>
              {def.refTable !== '' && !(tables.data ?? []).some((x) => x.name === def.refTable) && (
                <option value={def.refTable}>{def.refTable}</option>
              )}
              {(tables.data ?? [])
                .filter((x) => x.kind === 'table')
                .map((x) => (
                  <option key={x.name} value={x.name}>
                    {x.name}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <div className="flex justify-end md:pt-[26px]">
          <Button
            variant="ghost"
            className="h-10"
            disabled={disabled}
            onClick={() => setDraft({ ...draft, fks: draft.fks.filter((f) => f.key !== row.key) })}
          >
            <Trash2 size={14} aria-hidden />
            {t('structure.remove')}
            <span className="sr-only"> {def.name ?? t('structure.fk.title')}</span>
          </Button>
        </div>
      </div>

      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t('structure.fk.pairs')}</legend>
        {Array.from({ length: pairCount }, (_, j) => (
          <div key={j} className="flex flex-wrap items-start gap-2">
            <div className="min-w-[150px] flex-1">
              <Select
                compact
                aria-label={t('structure.fk.localColumn', { n: j + 1 })}
                aria-invalid={Boolean(err(`columns.${j}`))}
                aria-describedby={err(`columns.${j}`) ? `${row.key}-c${j}-err` : undefined}
                value={def.columns[j] ?? ''}
                disabled={disabled}
                onChange={(e) => setPair(j, e.target.value, undefined)}
              >
                <option value="">{t('structure.choose')}</option>
                {(def.columns[j] ?? '') !== '' && !ownColumns.includes(def.columns[j] ?? '') && (
                  <option value={def.columns[j]}>{def.columns[j]}</option>
                )}
                {ownColumns.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
              <CellError id={`${row.key}-c${j}-err`} error={err(`columns.${j}`)} />
            </div>
            <span aria-hidden className="pt-1.5 text-muted">
              →
            </span>
            <div className="min-w-[150px] flex-1">
              <Select
                compact
                aria-label={t('structure.fk.refColumn', { n: j + 1 })}
                aria-invalid={Boolean(err(`refColumns.${j}`))}
                value={def.refColumns[j] ?? ''}
                disabled={disabled || def.refTable === ''}
                onChange={(e) => setPair(j, undefined, e.target.value)}
              >
                <option value="">{t('structure.choose')}</option>
                {(def.refColumns[j] ?? '') !== '' &&
                  !refColumns.includes(def.refColumns[j] ?? '') && (
                    <option value={def.refColumns[j]}>{def.refColumns[j]}</option>
                  )}
                {refColumns.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
              <CellError id={`${row.key}-r${j}-err`} error={err(`refColumns.${j}`)} />
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('structure.fk.removePair', { n: j + 1 })}
              disabled={disabled || pairCount === 1}
              onClick={() => removePair(j)}
            >
              <X size={14} aria-hidden />
            </Button>
          </div>
        ))}
        {err('refColumns') && pairCount > 0 && (
          <p className="text-xs text-negative">{t(err('refColumns')!.key)}</p>
        )}
        <div>
          <Button
            disabled={disabled}
            onClick={() =>
              patch({ columns: [...def.columns, ''], refColumns: [...def.refColumns, ''] })
            }
          >
            <Plus size={14} aria-hidden />
            {t('structure.fk.addPair')}
          </Button>
        </div>
      </fieldset>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {(['onDelete', 'onUpdate'] as const).map((field) => (
          <Field
            key={field}
            label={t(field === 'onDelete' ? 'structure.fk.onDelete' : 'structure.fk.onUpdate')}
          >
            {(p) => (
              <Select
                {...p}
                value={def[field]}
                disabled={disabled}
                onChange={(e) => patch({ [field]: e.target.value } as Partial<FkDef>)}
              >
                {REFERENTIAL_ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {t(
                      `structure.fk.action.${a === 'set null' ? 'setNull' : a === 'no action' ? 'noAction' : a}`,
                    )}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ))}
      </div>
    </li>
  )
}

export function FkEditor(props: {
  db: string
  tableName: string
  draft: Draft
  setDraft: (next: Draft) => void
  errors: FieldErrors
  disabled?: boolean
}) {
  const { draft, setDraft, disabled } = props
  return (
    <div className="flex flex-col gap-3 px-6">
      {draft.fks.length === 0 && <p className="text-sm text-muted">{t('structure.fk.empty')}</p>}
      <ul className="flex flex-col gap-3">
        {draft.fks.map((row, index) => (
          <FkCard key={row.key} row={row} index={index} {...props} />
        ))}
      </ul>
      <div>
        <Button
          disabled={disabled}
          onClick={() =>
            setDraft({
              ...draft,
              fks: [
                ...draft.fks,
                {
                  key: newKey(),
                  def: {
                    columns: [''],
                    refDb: props.db,
                    refTable: '',
                    refColumns: [''],
                    onDelete: 'restrict',
                    onUpdate: 'restrict',
                  },
                },
              ],
            })
          }
        >
          <Plus size={14} aria-hidden />
          {t('structure.fk.add')}
        </Button>
      </div>
    </div>
  )
}
