import { Plus, Trash2 } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import type { Capabilities, CheckDef } from '~/server/structure/types'
import { t } from '~/i18n'
import { Field } from './field'
import { newKey, type Draft, type FieldErrors } from './model'

export function CheckEditor({
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
  const supported = caps ? caps['check-constraint'] : true
  const toggle = caps ? caps['check-enforcement-toggle'] : true
  const off = disabled || !supported
  const patch = (key: string, next: Partial<CheckDef>) =>
    setDraft({
      ...draft,
      checks: draft.checks.map((c) => (c.key === key ? { ...c, def: { ...c.def, ...next } } : c)),
    })

  return (
    <div className="flex flex-col gap-3 px-6">
      {!supported && <p className="text-sm text-muted">{t('structure.unsupported')}</p>}
      {supported && draft.checks.length === 0 && (
        <p className="text-sm text-muted">{t('structure.checks.empty')}</p>
      )}
      <ul className="flex flex-col gap-3">
        {draft.checks.map((row, i) => (
          <li
            key={row.key}
            className="grid grid-cols-1 items-start gap-3 rounded-[var(--radius-card)] bg-raised p-3 md:grid-cols-[200px_minmax(0,1fr)_auto_auto]"
          >
            <Field label={t('structure.check.name')} error={errors[`checks.${i}.name`]}>
              {(p) => (
                <Input
                  {...p}
                  value={row.def.name ?? ''}
                  placeholder={t('structure.index.nameAuto')}
                  disabled={off}
                  onChange={(e) => patch(row.key, { name: e.target.value })}
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
            </Field>
            <Field label={t('structure.check.expression')} error={errors[`checks.${i}.sql`]}>
              {(p) => (
                <Input
                  {...p}
                  className="font-mono"
                  value={row.def.sql}
                  placeholder="price >= 0"
                  disabled={off}
                  onChange={(e) => patch(row.key, { sql: e.target.value })}
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
            </Field>
            <div className="md:pt-[26px]">
              <label className="flex h-10 items-center gap-2 text-sm">
                <Checkbox
                  checked={row.def.enforced !== false}
                  disabled={off || !toggle}
                  aria-describedby={!toggle ? `${row.key}-enf-why` : undefined}
                  onChange={(e) => patch(row.key, { enforced: e.target.checked })}
                />
                {t('structure.check.enforced')}
              </label>
              {!toggle && (
                <span id={`${row.key}-enf-why`} className="text-xs text-muted">
                  {t('structure.unsupported')}
                </span>
              )}
            </div>
            <div className="md:pt-[26px]">
              <Button
                variant="ghost"
                className="h-10"
                disabled={off}
                onClick={() =>
                  setDraft({ ...draft, checks: draft.checks.filter((c) => c.key !== row.key) })
                }
              >
                <Trash2 size={14} aria-hidden />
                {t('structure.remove')}
                <span className="sr-only"> {row.def.name ?? t('structure.check.title')}</span>
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <div>
        <Button
          disabled={off}
          onClick={() =>
            setDraft({ ...draft, checks: [...draft.checks, { key: newKey(), def: { sql: '' } }] })
          }
        >
          <Plus size={14} aria-hidden />
          {t('structure.check.add')}
        </Button>
      </div>
    </div>
  )
}
