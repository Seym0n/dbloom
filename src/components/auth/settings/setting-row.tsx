import { useEffect, useId, useState } from 'react'
import { t, tDynamic } from '~/i18n'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import { Select } from '~/components/ui/select'
import { Pill } from '~/components/auth/account/account-ui'
import { useStepUp } from '~/components/auth/account/step-up'
import { ErrorNote } from '~/components/auth/auth-frame'
import { authApi } from '~/lib/auth/api'
import { useAction } from '~/lib/auth/use-action'
import type { SettingDescription, SettingValue } from '~/server/auth/types'
import type { SettingsRefusal } from '~/server/settings-service'

type Draft = string | boolean | string[]
const ENDS_AT = 'maintenanceEndsAt'
const NARROWING = new Set(['mfaFactors', 'primaryCredentials'])

const formatWhen = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
const localInput = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
const unitText = (d: SettingDescription) => (d.unit === 'count' || d.unit === 'none' || d.unit === 'milliseconds' ? '' : t(`settings.unit.${d.unit}` as 'settings.unit.minutes'))
const choice = (value: string) => tDynamic(`settings.choice.${value}`, 'settings.value.none')
const shown = (n: number, d: SettingDescription) => String(Math.round((n / d.factor) * 100) / 100)

/** Value as the editor holds it. */
function toDraft(d: SettingDescription): Draft {
  const v = d.effective
  if (d.key === ENDS_AT) return typeof v === 'number' && v > 0 ? localInput(v) : ''
  if (d.kind === 'number') return typeof v === 'number' ? shown(v, d) : ''
  if (d.kind === 'boolean') return v === true
  if (d.kind === 'list') return Array.isArray(v) ? v.map(String) : []
  return typeof v === 'string' ? v : ''
}

/** Value to send, or undefined when the draft is not a usable value (a number field with no number in it). */
function fromDraft(d: SettingDescription, draft: Draft): SettingValue | undefined {
  if (d.key === ENDS_AT) {
    if (draft === '') return 0
    const ms = new Date(String(draft)).getTime()
    return Number.isFinite(ms) ? ms : undefined
  }
  if (d.kind === 'number') {
    const n = Number(draft)
    return typeof draft === 'string' && draft.trim() !== '' && Number.isFinite(n) ? Math.round(n * d.factor) : undefined
  }
  return draft as SettingValue
}

function display(d: SettingDescription): string {
  const v = d.effective
  if (d.kind === 'object') return t('settings.value.object')
  if (d.key === ENDS_AT) return typeof v === 'number' && v > 0 ? formatWhen(v) : t('settings.value.none')
  if (d.kind === 'number') return `${typeof v === 'number' ? shown(v, d) : ''}${unitText(d)}`
  if (d.kind === 'boolean') return v === true ? t('settings.value.on') : t('settings.value.off')
  if (d.kind === 'choice') return choice(String(v))
  if (d.kind === 'list') return Array.isArray(v) ? v.map((x) => choice(String(x))).join(', ') : ''
  return typeof v === 'string' && v !== '' ? v : t('settings.value.empty')
}

function rangeText(d: SettingDescription): string | null {
  const { floor, ceiling, envelope } = d.limits
  if (d.kind === 'text') return typeof ceiling === 'number' ? t('settings.range.chars', { max: ceiling }) : null
  if (envelope) return t('settings.range.envelope', { list: envelope.map((x) => choice(String(x))).join(', ') })
  if (d.key === 'mfaScope' || d.key === 'mfaRoles') return floor !== undefined && floor !== 'none' && !(Array.isArray(floor) && floor.length === 0) ? t('settings.range.floor', { value: Array.isArray(floor) ? floor.map((x) => choice(String(x))).join(', ') : choice(String(floor)) }) : null
  if (d.kind !== 'number' || d.key === ENDS_AT) return null
  const unit = unitText(d)
  const min = typeof floor === 'number' ? shown(floor, d) : null
  const max = typeof ceiling === 'number' ? shown(ceiling, d) : null
  if (min && max) return t('settings.range.between', { min, max, unit })
  if (min) return t('settings.range.min', { min, unit })
  if (max) return t('settings.range.max', { max, unit })
  return null
}

function refusalText(r: SettingsRefusal): string {
  const generic = tDynamic(`settings.error.${r.code}`, 'settings.error.generic', { count: r.count ?? 0 })
  return r.detail ? tDynamic(`settings.error.${r.code}.${r.detail}`, 'settings.error.generic', { count: r.count ?? 0 }) : generic
}

/** One setting: label, source, range, notes and the editor that matches its kind (SPEC/32 FR-ASE-013). */
export function SettingRow({ d, onChanged }: { d: SettingDescription; onChanged: () => Promise<unknown> }) {
  const labelId = useId()
  const { guard } = useStepUp()
  const act = useAction()
  const [draft, setDraft] = useState<Draft>(() => toDraft(d))
  const [note, setNote] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<SettingsRefusal | null>(null)
  const [strands, setStrands] = useState<number | null>(null)
  const name = tDynamic(`settings.key.${d.key}`, 'settings.title')

  // A new value from the server (after a save, a reset or a reload) replaces the draft.
  const signature = JSON.stringify([d.effective, d.updatedAt])
  useEffect(() => {
    setDraft(toDraft(d))
    setStrands(null)
  }, [signature])

  const clean = JSON.stringify(draft) === JSON.stringify(toDraft(d))
  const value = fromDraft(d, draft)

  // Narrowing a list that users depend on: ask the server how many would be locked out, before saving.
  useEffect(() => {
    if (!NARROWING.has(d.key) || clean || !Array.isArray(draft) || draft.length === 0) {
      setStrands(null)
      return
    }
    let live = true
    void authApi()
      .previewSetting(d.key, draft)
      .then((r) => live && setStrands(r.ok ? r.strandedUsers : null))
      .catch(() => live && setStrands(null))
    return () => {
      live = false
    }
  }, [d.key, draft, clean])

  async function submit(action: 'save' | 'reset') {
    setNote(null)
    setRefusal(null)
    let sent: SettingValue | undefined
    if (action === 'save') {
      sent = value
      if (sent === undefined) {
        setRefusal({ code: 'settings_invalid', detail: 'type' })
        return
      }
    }
    const r = await act.run(() => guard(() => (action === 'save' ? authApi().setSetting(d.key, sent, d.updatedAt) : authApi().resetSetting(d.key, d.updatedAt))))
    if (!r.ok) return
    if (r.value.ok) {
      setNote(!r.value.changed ? t('settings.noChange') : action === 'save' ? t('settings.saved') : t('settings.resetDone'))
      await onChanged()
    } else {
      setRefusal(r.value.error)
      if (r.value.error.code === 'settings_conflict') await onChanged()
    }
  }

  const source = d.source === 'limit' ? 'warning' : 'neutral'
  const range = rangeText(d)
  const disabled = act.busy
  const editor = (() => {
    if (!d.editable) return <p className="text-sm break-words whitespace-pre-line">{display(d)}</p>
    if (d.key === ENDS_AT)
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Input type="datetime-local" aria-labelledby={labelId} value={String(draft)} onChange={(e) => setDraft(e.target.value)} className="w-auto" />
          {draft !== '' && (
            <Button variant="ghost" onClick={() => setDraft('')}>
              {t('settings.endsAt.clear')}
            </Button>
          )}
        </div>
      )
    switch (d.kind) {
      case 'number':
        return (
          <div className="flex items-center gap-2">
            <Input type="number" inputMode="decimal" aria-labelledby={labelId} value={String(draft)} onChange={(e) => setDraft(e.target.value)} className="w-32" />
            <span className="text-sm text-muted">{unitText(d).trim()}</span>
          </div>
        )
      case 'boolean':
        return (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={draft === true} onChange={(e) => setDraft(e.target.checked)} aria-labelledby={labelId} />
            {draft === true ? t('settings.value.on') : t('settings.value.off')}
          </label>
        )
      case 'choice':
        return (
          <Select aria-labelledby={labelId} value={String(draft)} onChange={(e) => setDraft(e.target.value)}>
            {(d.choices ?? []).map((c) => (
              <option key={c} value={c} disabled={c === 'none' && typeof d.limits.floor === 'string' && d.limits.floor !== 'none'}>
                {choice(c)}
              </option>
            ))}
          </Select>
        )
      case 'list':
        return (
          <fieldset className="flex flex-col gap-1">
            <legend className="sr-only">{name}</legend>
            {(d.choices ?? []).map((c) => {
              const list = Array.isArray(draft) ? draft : []
              const outside = d.limits.envelope ? !d.limits.envelope.includes(c) : false
              const required = Array.isArray(d.limits.floor) && d.limits.floor.includes(c)
              return (
                <label key={c} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={list.includes(c)}
                    disabled={outside || required}
                    onChange={(e) => setDraft(e.target.checked ? [...list, c] : list.filter((x) => x !== c))}
                  />
                  {choice(c)}
                </label>
              )
            })}
          </fieldset>
        )
      case 'text':
        return d.key === 'infoBanner' ? (
          <textarea
            aria-labelledby={labelId}
            rows={3}
            value={String(draft)}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full rounded-[var(--radius-control)] border border-control bg-surface px-3 py-2 text-sm text-ink"
          />
        ) : (
          <Input aria-labelledby={labelId} value={String(draft)} onChange={(e) => setDraft(e.target.value)} />
        )
      default:
        return <p className="text-sm">{display(d)}</p>
    }
  })()

  return (
    <li className="border-t border-rule py-4 first:border-t-0">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            <span id={labelId}>{name}</span>
            <Pill tone={source}>{t(`settings.source.${d.source}`)}</Pill>
          </p>
          {range && <p className="mt-1 text-xs text-muted">{range}</p>}
          {d.locked && <p className="mt-1 text-xs text-muted">{t('settings.note.locked')}</p>}
          {d.forced && <p className="mt-1 text-xs text-muted">{t('settings.note.forced')}</p>}
          {!d.editable && !d.locked && !d.forced && <p className="mt-1 text-xs text-muted">{t('settings.note.envOnly')}</p>}
          {d.stored !== null && JSON.stringify(d.stored) !== JSON.stringify(d.effective) && (
            <p className="mt-1 text-xs text-muted">
              {t('settings.note.stored', { stored: display({ ...d, effective: d.stored }), effective: display(d) })}
            </p>
          )}
          {d.storedIgnored && <p className="mt-1 text-xs text-muted">{t('settings.note.ignored')}</p>}
          {d.updatedAt !== null && d.updatedBy && <p className="mt-1 text-xs text-muted">{t('settings.note.updated', { name: d.updatedBy, time: formatWhen(d.updatedAt) })}</p>}
        </div>
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-2 sm:max-w-[22rem]">
          {editor}
          {d.editable && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={disabled || clean} aria-label={t('settings.saveAria', { name })} onClick={() => void submit('save')}>
                {t('settings.save')}
              </Button>
              {d.updatedAt !== null && (
                <Button disabled={disabled} aria-label={t('settings.resetAria', { name })} onClick={() => void submit('reset')}>
                  {t('settings.reset')}
                </Button>
              )}
            </div>
          )}
          {strands !== null && strands > 0 && <p role="status" className="text-sm text-negative">{t('settings.preview.strands', { count: strands })}</p>}
          {strands === 0 && <p role="status" className="text-xs text-muted">{t('settings.preview.fine')}</p>}
          {refusal && <p role="alert" className="text-sm text-negative">{refusalText(refusal)}</p>}
          <ErrorNote message={act.error?.message} />
          {note && <p role="status" className="text-sm text-muted">{note}</p>}
        </div>
      </div>
    </li>
  )
}
