import { Input } from '~/components/ui/input'
import { Select } from '~/components/ui/select'
import type { StructureLists, TableOptions } from '~/server/structure/types'
import { t } from '~/i18n'
import { Field } from './field'
import type { Draft, FieldErrors } from './model'

const ROW_FORMATS = ['default', 'dynamic', 'compact', 'redundant', 'compressed'] as const

export function TableOptionsEditor({
  draft,
  setDraft,
  errors,
  lists,
  disabled,
}: {
  draft: Draft
  setDraft: (next: Draft) => void
  errors: FieldErrors
  lists: StructureLists | undefined
  disabled?: boolean
}) {
  const o = draft.options
  const patch = (next: Partial<TableOptions>) => setDraft({ ...draft, options: { ...o, ...next } })
  const effectiveCharset = o.charset ?? 'utf8mb4'
  const collations = (lists?.collations ?? []).filter((c) => c.charset === effectiveCharset)
  const defaultCollation = lists?.charsets.find(
    (c) => c.name === effectiveCharset,
  )?.defaultCollation
  const defaultEngine = lists?.engines.includes('InnoDB') ? 'InnoDB' : undefined

  return (
    <div className="grid grid-cols-1 gap-4 px-6 md:grid-cols-2 xl:grid-cols-3">
      <Field label={t('structure.options.engine')}>
        {(p) => (
          <Select
            {...p}
            value={o.engine ?? ''}
            disabled={disabled}
            onChange={(e) => patch({ engine: e.target.value || undefined })}
          >
            <option value="">
              {defaultEngine
                ? t('structure.defaultValue', { name: defaultEngine })
                : t('structure.serverDefault')}
            </option>
            {(lists?.engines ?? []).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('structure.options.charset')}>
        {(p) => (
          <Select
            {...p}
            value={o.charset ?? ''}
            disabled={disabled}
            onChange={(e) => patch({ charset: e.target.value || undefined, collation: undefined })}
          >
            <option value="">{t('structure.defaultValue', { name: 'utf8mb4' })}</option>
            {(lists?.charsets ?? []).map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        label={t('structure.options.collation')}
        hint={
          defaultCollation
            ? t('structure.options.collationDefault', { name: defaultCollation })
            : undefined
        }
      >
        {(p) => (
          <Select
            {...p}
            value={o.collation ?? ''}
            disabled={disabled}
            onChange={(e) => patch({ collation: e.target.value || undefined })}
          >
            <option value="">
              {defaultCollation
                ? t('structure.defaultValue', { name: defaultCollation })
                : t('structure.serverDefault')}
            </option>
            {collations.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('structure.options.rowFormat')}>
        {(p) => (
          <Select
            {...p}
            value={o.rowFormat ?? 'default'}
            disabled={disabled}
            onChange={(e) => patch({ rowFormat: e.target.value as TableOptions['rowFormat'] })}
          >
            {ROW_FORMATS.map((f) => (
              <option key={f} value={f}>
                {f === 'default' ? t('structure.serverDefault') : f.toUpperCase()}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('structure.options.autoIncrement')} error={errors['autoIncrement']}>
        {(p) => (
          <Input
            {...p}
            type="number"
            min={1}
            value={o.autoIncrement ?? ''}
            disabled={disabled}
            onChange={(e) =>
              patch({ autoIncrement: e.target.value === '' ? undefined : Number(e.target.value) })
            }
          />
        )}
      </Field>
      <Field
        label={t('structure.options.comment')}
        error={errors['comment']}
        className="md:col-span-2 xl:col-span-3"
      >
        {(p) => (
          <Input
            {...p}
            value={o.comment ?? ''}
            disabled={disabled}
            onChange={(e) => patch({ comment: e.target.value })}
          />
        )}
      </Field>
    </div>
  )
}
