import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { t, tDynamic } from '~/i18n'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import { Select } from '~/components/ui/select'
import { authApi, type GetPrefsResult } from '~/lib/auth/api'
import {
  applyTheme,
  groupPrefs,
  isUserScoped,
  parseDraft,
  prefMeta,
  saveProblem,
  toDraft,
  type PrefMeta,
} from '~/lib/auth/account-logic'
import { cn } from '~/lib/utils'
import { ErrorNote } from '../auth-frame'
import { ConfirmDialog } from './account-dialogs'
import { Muted, Panel, Row, Section } from './account-ui'
import { WhenText } from './factors-section'
import { ImportPanel } from './prefs-import'

type Status = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string; retry?: () => void }

export type PrefsTarget = { key: string; label: string }

/** Preferences (FR-AUT-024, 025): every key of the registry, grouped, saved as it is changed; export, import and reset below. */
export function PrefsPage({ target }: { target: PrefsTarget | null }) {
  const queryClient = useQueryClient()
  const queryKey = ['account', 'prefs', target?.key ?? ''] as const
  const prefs = useQuery({ queryKey, queryFn: () => authApi().getPrefs(target?.key), retry: false })
  const [resetOpen, setResetOpen] = useState(false)
  const [message, setMessage] = useState('')

  const reload = () => queryClient.invalidateQueries({ queryKey: ['account', 'prefs'] })

  async function save(key: string, value: unknown) {
    const result = await authApi().setPref(key, value, isUserScoped(key) ? undefined : target?.key)
    queryClient.setQueryData<GetPrefsResult>(queryKey, (old) => (old ? { ...old, values: { ...old.values, [key]: value }, updatedAt: result.updatedAt } : old))
    if (key === 'theme') applyTheme(value)
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-[22px] font-semibold leading-7">{t('account.prefs.title')}</h1>
        <Muted className="mt-1">{t('account.prefs.lead')}</Muted>
      </div>
      <p role="status" aria-live="polite" className="min-h-5 text-sm text-positive empty:sr-only">
        {message}
      </p>

      {prefs.isPending && <Muted>{t('account.loading')}</Muted>}
      {prefs.isError && (
        <Panel className="py-3">
          <ErrorNote message={t('account.loadFailed')} />
          <Button className="mt-2" onClick={() => void prefs.refetch()}>
            {t('account.retry')}
          </Button>
        </Panel>
      )}
      {prefs.data && (
        <>
          {prefs.data.stateless && (
            <p role="note" className="rounded-[var(--radius-card)] bg-[var(--pill-warning-bg)] px-4 py-3 text-sm text-[var(--pill-warning-ink)]">
              {t('account.prefs.stateless')}
            </p>
          )}
          <p className="text-sm text-muted">
            {target ? t('account.prefs.target', { target: target.label }) : t('account.prefs.noTarget')}
            {prefs.data.updatedAt ? (
              <>
                {' '}
                {t('account.prefs.lastSaved')} <WhenText ts={prefs.data.updatedAt} />.
              </>
            ) : null}
          </p>
          {groupPrefs(prefs.data.values).map((group) => (
            <Section key={group.category} title={t(`account.prefs.category.${group.category}`)}>
              <Panel>
                {group.keys.map((key) => (
                  <PrefField key={`${target?.key ?? ''}|${key}`} prefKey={key} value={prefs.data.values[key]} onSave={(v) => save(key, v)} />
                ))}
              </Panel>
            </Section>
          ))}
        </>
      )}

      <Section title={t('account.prefs.manage')} lead={t('account.prefs.manageLead')}>
        <ExportRow />
        <ImportPanel onImported={() => void reload()} announce={setMessage} />
        <Panel>
          <Row>
            <div className="min-w-0">
              <h3 className="font-medium">{t('account.reset.title')}</h3>
              <Muted>{t('account.reset.lead')}</Muted>
            </div>
            <Button className="border-negative text-negative" onClick={() => setResetOpen(true)}>
              {t('account.reset.action')}
            </Button>
          </Row>
        </Panel>
      </Section>
      <ConfirmDialog
        open={resetOpen}
        title={t('account.reset.confirmTitle')}
        body={t('account.reset.confirmBody')}
        confirmLabel={t('account.reset.action')}
        danger
        onClose={() => setResetOpen(false)}
        onConfirm={async () => {
          await authApi().resetPrefs()
          applyTheme('system')
          await reload()
          setMessage(t('account.reset.done'))
        }}
      />
    </div>
  )
}

function ExportRow() {
  const [error, setError] = useState<string | null>(null)
  return (
    <Panel>
      <Row>
        <div className="min-w-0">
          <h3 className="font-medium">{t('account.export.title')}</h3>
          <Muted>{t('account.export.lead')}</Muted>
          <ErrorNote message={error} />
        </div>
        <Button
          onClick={async () => {
            setError(null)
            try {
              const { downloadText } = await import('~/lib/auth/clipboard')
              const file = await authApi().exportPrefs()
              downloadText(file.fileName, file.json)
            } catch {
              setError(t('account.export.failed'))
            }
          }}
        >
          {t('account.export.action')}
        </Button>
      </Row>
    </Panel>
  )
}

/** One preference: label, the control for its kind, and its own save state ("Saved", "Could not be saved" with retry). */
function PrefField({ prefKey, value, onSave }: { prefKey: string; value: unknown; onSave: (value: unknown) => Promise<void> }) {
  const meta = prefMeta(prefKey, value)
  const labelId = `pref-${prefKey}`
  const [draft, setDraft] = useState(() => toDraft(meta, value))
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])
  // A reload (reset, import) changes the stored value under an input that is not being edited.
  useEffect(() => setDraft(toDraft(meta, value)), [value, meta.kind])

  async function commit(next: unknown) {
    setStatus({ kind: 'saving' })
    try {
      await onSave(next)
      setStatus({ kind: 'saved' })
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setStatus({ kind: 'idle' }), 3000)
    } catch (error) {
      const problem = saveProblem(error)
      setStatus({
        kind: 'error',
        message: t(problem === 'invalid' ? 'account.prefs.invalid' : problem === 'ended' ? 'auth.error.session_ended' : 'account.prefs.notSaved'),
        retry: () => void commit(next),
      })
    }
  }

  function commitDraft() {
    const parsed = parseDraft(meta, draft)
    if (!parsed.ok) {
      setStatus({ kind: 'error', message: t(`account.prefs.draft.${parsed.reason}`) })
      return
    }
    if (JSON.stringify(parsed.value) === JSON.stringify(value)) {
      setStatus({ kind: 'idle' })
      return
    }
    void commit(parsed.value)
  }

  const hint = meta.min !== undefined && meta.max !== undefined ? t('account.prefs.range', { min: meta.min, max: meta.max }) : meta.kind === 'tags' ? t('account.prefs.listHint') : null

  return (
    <div className="flex flex-col gap-2 border-t border-rule py-3 first:border-t-0 min-[640px]:flex-row min-[640px]:items-start min-[640px]:justify-between min-[640px]:gap-6">
      <div className="min-w-0 min-[640px]:w-1/2">
        <label id={labelId} htmlFor={meta.kind === 'boolean' ? `${labelId}-box` : `${labelId}-input`} className="font-medium">
          {tDynamic(`prefs.${prefKey}`, 'account.prefs.unknownKey', { key: prefKey })}
        </label>
        {hint && <p className="text-xs text-muted">{hint}</p>}
      </div>
      <div className="flex min-w-0 flex-col gap-1 min-[640px]:w-1/2">
        <Control
          meta={meta}
          id={meta.kind === 'boolean' ? `${labelId}-box` : `${labelId}-input`}
          value={value}
          draft={draft}
          onDraft={(text) => {
            setDraft(text)
            if (status.kind === 'error') setStatus({ kind: 'idle' })
          }}
          onCommitDraft={commitDraft}
          onCommit={(next) => void commit(next)}
        />
        <p role="status" aria-live="polite" className={cn('text-xs empty:sr-only', status.kind === 'error' ? 'text-negative' : 'text-muted')}>
          {status.kind === 'saving' ? t('account.prefs.saving') : status.kind === 'saved' ? t('account.prefs.saved') : status.kind === 'error' ? status.message : null}
        </p>
        {status.kind === 'error' && (
          <div className="flex gap-2">
            {status.retry && (
              <Button onClick={status.retry}>{t('account.retry')}</Button>
            )}
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(toDraft(meta, value))
                setStatus({ kind: 'idle' })
              }}
            >
              {t('account.prefs.discard')}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

function Control({
  meta,
  id,
  value,
  draft,
  onDraft,
  onCommitDraft,
  onCommit,
}: {
  meta: PrefMeta
  id: string
  value: unknown
  draft: string
  onDraft: (text: string) => void
  onCommitDraft: () => void
  onCommit: (value: unknown) => void
}) {
  switch (meta.kind) {
    case 'select':
      return (
        <Select id={id} value={String(value)} onChange={(e) => onCommit(e.target.value)}>
          {(meta.options ?? []).map((option) => (
            <option key={option} value={option}>
              {tDynamic(`account.prefs.option.${option}`, 'account.prefs.unknownKey', { key: option })}
            </option>
          ))}
        </Select>
      )
    case 'boolean':
      return (
        <div className="flex h-10 items-center gap-2">
          <Checkbox id={id} checked={value === true} onChange={(e) => onCommit(e.target.checked)} />
          <span aria-hidden className="text-sm text-muted">
            {value === true ? t('account.prefs.on') : t('account.prefs.off')}
          </span>
        </div>
      )
    case 'json':
      return (
        <textarea
          id={id}
          value={draft}
          rows={Math.min(8, Math.max(3, draft.split('\n').length))}
          spellCheck={false}
          onChange={(e) => onDraft(e.target.value)}
          onBlur={onCommitDraft}
          className="w-full rounded-[var(--radius-control)] border border-control bg-surface px-3 py-2 font-mono text-xs text-ink"
        />
      )
    default:
      return (
        <Input
          id={id}
          value={draft}
          inputMode={meta.kind === 'integer' || meta.kind === 'number' ? 'numeric' : undefined}
          spellCheck={false}
          onChange={(e) => onDraft(e.target.value)}
          onBlur={onCommitDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onCommitDraft()
            }
          }}
          className={meta.kind === 'integer' || meta.kind === 'number' ? 'max-w-40' : undefined}
        />
      )
  }
}
