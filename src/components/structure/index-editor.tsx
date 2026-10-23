import { Plus, Trash2, X } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import { Select } from '~/components/ui/select'
import type { Capabilities, IndexDef } from '~/server/structure/types'
import { t } from '~/i18n'
import { CellError, Field } from './field'
import { duplicateIndexKeys, newKey, type Draft, type FieldErrors } from './model'

const KINDS: IndexDef['kind'][] = ['primary', 'unique', 'index', 'fulltext']

export function IndexEditor({
  draft,
  setDraft,
  errors,
  caps,
  disabled,
}: {
  draft: Draft
  setDraft: (next: Draft) => void
  errors: FieldErrors
  caps: Capabilities | undefined
  disabled?: boolean
}) {
  const columnNames = draft.columns
    .filter((c) => !c.removed && c.def.name !== '')
    .map((c) => c.def.name)
  const duplicates = duplicateIndexKeys(draft.indexes)
  const hideOk = caps ? caps['index-hide'] : true

  const patch = (key: string, next: Partial<IndexDef>) =>
    setDraft({
      ...draft,
      indexes: draft.indexes.map((i) => (i.key === key ? { ...i, def: { ...i.def, ...next } } : i)),
    })

  return (
    <div className="flex flex-col gap-3 px-6">
      {draft.indexes.length === 0 && (
        <p className="text-sm text-muted">{t('structure.indexes.empty')}</p>
      )}
      <ul className="flex flex-col gap-3">
        {draft.indexes.map((row, i) => {
          const def = row.def
          const err = (path: string) => errors[`indexes.${i}.${path}`]
          const primary = def.kind === 'primary'
          return (
            <li
              key={row.key}
              className="flex flex-col gap-3 rounded-[var(--radius-card)] bg-raised p-3"
            >
              <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-[minmax(0,1fr)_180px_auto_auto]">
                <Field label={t('structure.index.name')} error={err('name')}>
                  {(p) => (
                    <Input
                      {...p}
                      value={primary ? 'PRIMARY' : (def.name ?? '')}
                      disabled={disabled || primary}
                      placeholder={primary ? undefined : t('structure.index.nameAuto')}
                      onChange={(e) => patch(row.key, { name: e.target.value })}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  )}
                </Field>
                <Field label={t('structure.index.kind')} error={err('kind')}>
                  {(p) => (
                    <Select
                      {...p}
                      value={def.kind}
                      disabled={disabled}
                      onChange={(e) => patch(row.key, { kind: e.target.value as IndexDef['kind'] })}
                    >
                      {KINDS.map((k) => (
                        <option key={k} value={k}>
                          {t(`structure.index.kind.${k}`)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <div className="flex flex-col gap-1.5 md:pt-[26px]">
                  <label className="flex h-10 items-center gap-2 text-sm">
                    <Checkbox
                      checked={def.visibility === 'invisible'}
                      disabled={disabled || primary || !hideOk}
                      aria-describedby={!hideOk ? `${row.key}-hide-why` : undefined}
                      onChange={(e) =>
                        patch(row.key, { visibility: e.target.checked ? 'invisible' : 'visible' })
                      }
                    />
                    {t('structure.index.invisible')}
                  </label>
                  {!hideOk && (
                    <span id={`${row.key}-hide-why`} className="text-xs text-muted">
                      {t('structure.unsupported')}
                    </span>
                  )}
                </div>
                <div className="md:pt-[26px]">
                  <Button
                    variant="ghost"
                    className="h-10"
                    disabled={disabled}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        indexes: draft.indexes.filter((x) => x.key !== row.key),
                      })
                    }
                  >
                    <Trash2 size={14} aria-hidden />
                    {t('structure.remove')}
                    <span className="sr-only">
                      {' '}
                      {def.name ?? t(`structure.index.kind.${def.kind}`)}
                    </span>
                  </Button>
                </div>
              </div>

              <fieldset className="flex min-w-0 flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">{t('structure.index.columns')}</legend>
                {def.parts.map((part, j) => (
                  <div key={j} className="flex flex-wrap items-start gap-2">
                    <div className="min-w-[160px] flex-1">
                      <Select
                        compact
                        aria-label={t('structure.index.partColumn', { n: j + 1 })}
                        aria-invalid={Boolean(err(`parts.${j}.column`))}
                        aria-describedby={
                          err(`parts.${j}.column`) ? `${row.key}-p${j}-err` : undefined
                        }
                        value={part.column}
                        disabled={disabled}
                        onChange={(e) =>
                          patch(row.key, {
                            parts: def.parts.map((p, k) =>
                              k === j ? { ...p, column: e.target.value } : p,
                            ),
                          })
                        }
                      >
                        <option value="">{t('structure.choose')}</option>
                        {part.column !== '' && !columnNames.includes(part.column) && (
                          <option value={part.column}>{part.column}</option>
                        )}
                        {columnNames.map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </Select>
                      <CellError id={`${row.key}-p${j}-err`} error={err(`parts.${j}.column`)} />
                    </div>
                    <Input
                      type="number"
                      min={1}
                      className="h-8 w-24"
                      aria-label={t('structure.index.partLength', { n: j + 1 })}
                      placeholder={t('structure.index.prefix')}
                      value={part.length ?? ''}
                      disabled={disabled}
                      onChange={(e) =>
                        patch(row.key, {
                          parts: def.parts.map((p, k) =>
                            k === j
                              ? {
                                  ...p,
                                  length:
                                    e.target.value === '' ? undefined : Number(e.target.value),
                                }
                              : p,
                          ),
                        })
                      }
                    />
                    <Select
                      compact
                      className="w-28"
                      aria-label={t('structure.index.partOrder', { n: j + 1 })}
                      value={part.order ?? 'asc'}
                      disabled={disabled}
                      onChange={(e) =>
                        patch(row.key, {
                          parts: def.parts.map((p, k) =>
                            k === j ? { ...p, order: e.target.value as 'asc' | 'desc' } : p,
                          ),
                        })
                      }
                    >
                      <option value="asc">{t('structure.index.asc')}</option>
                      <option value="desc">{t('structure.index.desc')}</option>
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('structure.index.removePart', { n: j + 1 })}
                      disabled={disabled || def.parts.length === 1}
                      onClick={() => patch(row.key, { parts: def.parts.filter((_, k) => k !== j) })}
                    >
                      <X size={14} aria-hidden />
                    </Button>
                  </div>
                ))}
                {errors[`indexes.${i}.parts`] && (
                  <p className="text-xs text-negative">{t(errors[`indexes.${i}.parts`]!.key)}</p>
                )}
                <div>
                  <Button
                    disabled={disabled}
                    onClick={() => patch(row.key, { parts: [...def.parts, { column: '' }] })}
                  >
                    <Plus size={14} aria-hidden />
                    {t('structure.index.addPart')}
                  </Button>
                </div>
              </fieldset>
              {duplicates.has(row.key) && (
                <p className="text-sm text-[var(--pill-warning-ink)]" role="status">
                  {t('structure.index.duplicate')}
                </p>
              )}
            </li>
          )
        })}
      </ul>
      <div>
        <Button
          disabled={disabled}
          onClick={() =>
            setDraft({
              ...draft,
              indexes: [
                ...draft.indexes,
                { key: newKey(), def: { kind: 'index', parts: [{ column: '' }] } },
              ],
            })
          }
        >
          <Plus size={14} aria-hidden />
          {t('structure.index.add')}
        </Button>
      </div>
    </div>
  )
}
