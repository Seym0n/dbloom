import { useId } from 'react'
import { ExternalLink } from 'lucide-react'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Select } from '~/components/ui/select'
import { cn } from '~/lib/utils'
import { t } from '~/i18n'
import type { OptionValue, OptionValues } from '~/lib/io/api'
import {
  safeDocUrl,
  validateOptions,
  visibleOptions,
  type OptionContext,
  type OptionSpec,
} from './registry'
import type { MessageKey } from '~/i18n'

function DocLink({ doc, label }: { doc?: string; label: string }) {
  const href = safeDocUrl(doc)
  if (!href) return null
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t('io.docs.link', { name: label })}
      title={t('io.docs.link', { name: label })}
      className="ml-1 inline-flex align-middle text-faint hover:text-ink"
    >
      <ExternalLink size={12} aria-hidden />
    </a>
  )
}

/**
 * Renders the options of one format from the registry (FR-IO-026): boolean, text, number, select, radio and
 * display text. Hidden options are not shown (FR-PLG-023); a format without visible options says so (FR-PLG-021).
 */
export function OptionPanel({
  legend,
  specs,
  values,
  onChange,
  ctx = {},
  disabled,
  locked,
}: {
  legend: string
  specs: OptionSpec[]
  values: OptionValues
  onChange: (key: string, value: OptionValue) => void
  ctx?: OptionContext
  disabled?: boolean
  /** Options the administrator fixes, with the reason shown beside them. */
  locked?: Record<string, MessageKey>
}) {
  const base = useId()
  const shown = visibleOptions(specs, values, ctx)
  const errors = validateOptions(specs, values, ctx)
  return (
    <fieldset className="min-w-0" disabled={disabled}>
      <legend className="mb-2 text-sm font-semibold text-ink">{legend}</legend>
      {shown.length === 0 ? (
        <p className="text-sm text-muted">{t('io.opt.none')}</p>
      ) : (
        <div className="grid gap-x-8 gap-y-3 md:grid-cols-2">
          {shown.map((spec) => (
            <OptionRow
              key={spec.key}
              id={`${base}-${spec.key}`}
              spec={spec}
              value={values[spec.key]}
              error={errors[spec.key]}
              lockedReason={locked?.[spec.key]}
              choices={spec.key === 'jsonTable' ? ctx.jsonTables : undefined}
              onChange={(v) => onChange(spec.key, v)}
            />
          ))}
        </div>
      )}
    </fieldset>
  )
}

function OptionRow({
  id,
  spec,
  value,
  error,
  lockedReason,
  choices,
  onChange,
}: {
  id: string
  spec: OptionSpec
  value: OptionValue | undefined
  error:
    | { key: 'io.err.required' | 'io.err.range' | 'io.err.integer'; min?: number; max?: number }
    | undefined
  lockedReason: MessageKey | undefined
  choices?: string[] | undefined
  onChange: (value: OptionValue) => void
}) {
  const label = t(spec.label)
  const hintId = `${id}-hint`
  const errId = `${id}-err`
  const hint = 'hint' in spec && spec.hint ? t(spec.hint) : undefined
  const describedBy =
    [error ? errId : null, hint || lockedReason ? hintId : null].filter(Boolean).join(' ') ||
    undefined
  const hintNode =
    hint || lockedReason ? (
      <p id={hintId} className="text-xs text-muted">
        {[hint, lockedReason ? t(lockedReason) : undefined].filter(Boolean).join(' ')}
      </p>
    ) : null
  const errorNode = error ? (
    <p id={errId} className="text-xs text-negative">
      {t(error.key, { min: error.min ?? 0, max: error.max ?? 0 })}
    </p>
  ) : null

  if (spec.type === 'note') {
    return (
      <p className="text-sm text-muted md:col-span-2" id={id}>
        {label}
      </p>
    )
  }
  if (spec.type === 'boolean') {
    return (
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-start gap-2 pointer-coarse:min-h-11">
          <Checkbox
            id={id}
            checked={value === true}
            disabled={Boolean(lockedReason)}
            aria-describedby={describedBy}
            onChange={(e) => onChange(e.target.checked)}
            className="mt-0.5"
          />
          <Label htmlFor={id} className="font-normal">
            {label}
            <DocLink doc={spec.doc} label={label} />
          </Label>
        </div>
        {hintNode && <div className="pl-[26px]">{hintNode}</div>}
      </div>
    )
  }
  if (spec.type === 'radio') {
    return (
      <fieldset
        className="flex min-w-0 flex-col gap-1.5 md:col-span-2"
        aria-describedby={describedBy}
      >
        <legend className="text-sm font-medium text-ink">
          {label}
          <DocLink doc={spec.doc} label={label} />
        </legend>
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          {spec.choices.map((c) => (
            <label
              key={c.value}
              className="flex items-center gap-2 text-sm pointer-coarse:min-h-11"
            >
              <input
                type="radio"
                name={id}
                value={c.value}
                checked={value === c.value}
                onChange={() => onChange(c.value)}
                className="h-[18px] w-[18px] accent-[var(--accent)]"
              />
              {t(c.label)}
            </label>
          ))}
        </div>
        {hintNode}
      </fieldset>
    )
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>
        {label}
        <DocLink doc={spec.doc} label={label} />
      </Label>
      {spec.type === 'select' && (
        <Select
          id={id}
          value={String(value ?? spec.default)}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        >
          {spec.choices.map((c) => (
            <option key={c.value} value={c.value}>
              {t(c.label)}
            </option>
          ))}
        </Select>
      )}
      {spec.type === 'text' && choices && choices.length > 0 && (
        <Select
          id={id}
          value={String(value ?? '')}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">{t('io.opt.row.jsonTable.first')}</option>
          {choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      )}
      {spec.type === 'text' && !(choices && choices.length > 0) && (
        <Input
          id={id}
          value={String(value ?? '')}
          maxLength={spec.maxLength}
          aria-describedby={describedBy}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {spec.type === 'number' && (
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            min={spec.min / (spec.scale ?? 1)}
            max={spec.max / (spec.scale ?? 1)}
            aria-invalid={Boolean(error)}
            aria-describedby={describedBy}
            value={value === '' || value === undefined ? '' : Number(value) / (spec.scale ?? 1)}
            onChange={(e) =>
              onChange(e.target.value === '' ? '' : Number(e.target.value) * (spec.scale ?? 1))
            }
            className={cn(spec.unit ? 'max-w-32' : '')}
          />
          {spec.unit && <span className="text-sm text-muted">{t(spec.unit)}</span>}
        </div>
      )}
      {errorNode ?? hintNode}
    </div>
  )
}
