import { useId } from 'react'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { t } from '~/i18n'

/** The user has to type the exact name before a destructive plan can run (SEC-DTB-002). */
export function TypedNameConfirm({
  name,
  value,
  onChange,
  disabled,
}: {
  name: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{t('structure.confirm.typeName', { name })}</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className="text-xs text-muted" aria-live="polite">
        {value === '' || value === name
          ? t('structure.confirm.typeNameHint')
          : t('structure.confirm.mismatch')}
      </p>
    </div>
  )
}

/** For hard plans that have no object name to type, such as dropping a column. */
export function AcknowledgeConfirm({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div className="flex items-start gap-2">
      <Checkbox
        id={id}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
      />
      <Label htmlFor={id} className="font-normal">
        {t('structure.confirm.acknowledge')}
      </Label>
    </div>
  )
}
