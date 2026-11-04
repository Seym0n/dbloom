import { useId, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, Trash2 } from 'lucide-react'
import { BrandName } from '~/components/brand'
import { Muted, Panel, Pill, Row, Section } from '~/components/auth/account/account-ui'
import { StepUpProvider, useStepUp } from '~/components/auth/account/step-up'
import { ErrorNote } from '~/components/auth/auth-frame'
import { ExposureBanner } from '~/components/auth/exposure/exposure-banner'
import { SETTINGS_KEY } from '~/components/auth/settings/settings-page'
import { SettingRow } from '~/components/auth/settings/setting-row'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import { Select } from '~/components/ui/select'
import { t, tDynamic } from '~/i18n'
import { authApi } from '~/lib/auth/api'
import { useAction } from '~/lib/auth/use-action'
import { getConnectionId } from '~/lib/csrf'
import type { AdminAnswer } from '~/server/assistant/admin-service'
import type { Suggestion } from '~/server/assistant/suggest'

export const ASSISTANT_ADMIN_KEY = ['admin', 'assistant'] as const
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

type Scope = { kind: 'all' | 'one'; target: string }
const scopeKey = (s: Scope) => (s.kind === 'all' ? '' : s.target.trim())
const scopeLabel = (key: string) => (key === '' ? t('asstAdmin.marks.scopeAll') : key)

/** The refusal of an admin answer as text, or null for an accepted one. */
const refusalText = <T,>(a: AdminAnswer<T>): string | null => (a.ok ? null : tDynamic(`asstAdmin.error.${a.error}`, 'asstAdmin.error.generic'))

/** Administrator page of the assistant (SPEC/34 FR-AST-019), wrapped in the step-up dialog. */
export function AssistantAdminPage() {
  const client = useQueryClient()
  const overview = useQuery({ queryKey: ASSISTANT_ADMIN_KEY, queryFn: () => authApi().getAssistantAdmin(), retry: false })
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => authApi().getSettings(), retry: false })
  const reload = () => Promise.all([client.invalidateQueries({ queryKey: ASSISTANT_ADMIN_KEY }), client.invalidateQueries({ queryKey: SETTINGS_KEY })])
  return (
    <StepUpProvider>
      <main className="min-h-full bg-ground px-4 py-8">
        <div className="mx-auto flex w-full max-w-[880px] flex-col gap-8">
          <header className="flex flex-col gap-4">
            <BrandName />
            <Link to="/" className="press -ml-2 inline-flex h-8 w-fit items-center gap-2 rounded-[var(--radius-control)] px-2 text-sm font-medium text-muted hover:bg-active hover:text-ink">
              <ArrowLeft size={14} aria-hidden />
              {t('asstAdmin.back')}
            </Link>
            <div>
              <h1 className="mb-1 text-[22px] font-semibold leading-7">{t('asstAdmin.title')}</h1>
              <p className="max-w-[60ch] text-sm text-muted">{t('asstAdmin.lead')}</p>
            </div>
          </header>
          <ExposureBanner />
          {overview.isPending ? (
            <Muted>{t('asstAdmin.loading')}</Muted>
          ) : overview.isError ? (
            <Panel className="py-3">
              <ErrorNote message={t('asstAdmin.loadFailed')} />
              <Button className="mt-2" onClick={() => void overview.refetch()}>
                {t('asstAdmin.retry')}
              </Button>
            </Panel>
          ) : (
            <>
              <Endpoint o={overview.data} />
              {settings.data && (
                <Section title={t('asstAdmin.settings.title')} lead={t('asstAdmin.settings.lead')}>
                  <Panel>
                    <ul aria-label={t('asstAdmin.settings.title')}>
                      {settings.data.settings
                        .filter((s) => s.group === 'assistant')
                        .map((d) => (
                          <SettingRow key={d.key} d={d} onChanged={reload} revertMinutes={5} />
                        ))}
                    </ul>
                  </Panel>
                </Section>
              )}
              <Markings o={overview.data} onChanged={reload} />
            </>
          )}
        </div>
      </main>
    </StepUpProvider>
  )
}

type Overview = Awaited<ReturnType<ReturnType<typeof authApi>['getAssistantAdmin']>>

function Endpoint({ o }: { o: Overview }) {
  const e = o.endpoint
  return (
    <Section title={t('asstAdmin.endpoint.title')} lead={t('asstAdmin.endpoint.lead')}>
      <Panel>
        <dl>
          <Row>
            <dt className="text-sm">{t('asstAdmin.endpoint.state')}</dt>
            <dd>{e.configured ? <Pill>{t('asstAdmin.endpoint.configured')}</Pill> : <Pill tone="warning">{t('asstAdmin.endpoint.notConfigured')}</Pill>}</dd>
          </Row>
          <Row>
            <dt className="text-sm">{t('asstAdmin.endpoint.address')}</dt>
            <dd className="break-all font-mono text-sm">{e.origin ?? '-'}</dd>
          </Row>
          <Row>
            <dt className="text-sm">{t('asstAdmin.endpoint.key')}</dt>
            <dd className="text-sm">{e.keySet ? t('asstAdmin.endpoint.keySet') : t('asstAdmin.endpoint.keyNotSet')}</dd>
          </Row>
          <Row>
            <dt className="text-sm">{t('asstAdmin.endpoint.private')}</dt>
            <dd className="text-sm">{e.allowPrivate ? t('asstAdmin.endpoint.allowed') : t('asstAdmin.endpoint.notAllowed')}</dd>
          </Row>
        </dl>
        {e.problems.length > 0 && (
          <div className="border-t border-rule py-3" role="group" aria-label={t('asstAdmin.endpoint.problems')}>
            <p className="mb-1 text-sm font-medium">{t('asstAdmin.endpoint.problems')}</p>
            <ul className="list-disc pl-5 text-sm text-muted">
              {e.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}
      </Panel>
    </Section>
  )
}

function Markings({ o, onChanged }: { o: Overview; onChanged: () => Promise<unknown> }) {
  const { guard } = useStepUp()
  const act = useAction()
  const [scope, setScope] = useState<Scope>({ kind: 'all', target: '' })
  const [rule, setRule] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<{ list: Suggestion[]; more: boolean } | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const targetId = useId()
  const scopeId = useId()
  const ruleId = useId()
  const connected = typeof window !== 'undefined' && getConnectionId() !== undefined

  const run = async <T,>(call: () => Promise<AdminAnswer<T>>, ok: (a: Extract<AdminAnswer<T>, { ok: true }>) => string) => {
    setNote(null)
    setProblem(null)
    const r = await act.run(() => guard(call))
    if (!r.ok) return false
    const refused = refusalText(r.value)
    if (refused) {
      setProblem(refused)
      return false
    }
    setNote(ok(r.value as Extract<AdminAnswer<T>, { ok: true }>))
    await onChanged()
    return true
  }

  const key = scopeKey(scope)
  const scopeValid = scope.kind === 'all' || scope.target.trim() !== ''

  return (
    <>
      <Section title={t('asstAdmin.marks.title')} lead={t('asstAdmin.marks.lead')}>
        {!o.stored && <p className="rounded-[var(--radius-card)] bg-[var(--pill-warning-bg)] px-3 py-2 text-sm text-[var(--pill-warning-ink)]">{t('asstAdmin.marks.notStored')}</p>}
        <Panel>
          <div className="border-b border-rule py-3">
            <p className="mb-1 text-sm font-medium">{t('asstAdmin.marks.env')}</p>
            {o.envRules.length === 0 ? <Muted>{t('asstAdmin.marks.envNone')}</Muted> : <p className="break-all font-mono text-sm">{o.envRules.join(', ')}</p>}
          </div>
          <div className="py-3">
            <p className="mb-1 text-sm font-medium">{t('asstAdmin.marks.stored')}</p>
            {o.rules.length === 0 ? (
              <Muted>{t('asstAdmin.marks.none')}</Muted>
            ) : (
              <ul aria-label={t('asstAdmin.marks.listLabel')}>
                {o.rules.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-rule py-2 first:border-t-0">
                    <div className="min-w-0">
                      <p className="break-all font-mono text-sm">{r.rule}</p>
                      <p className="break-all text-xs text-muted">
                        {scopeLabel(r.targetKey)} · {t('asstAdmin.marks.by', { name: r.createdBy, when: when(r.createdAt) })}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('asstAdmin.marks.remove', { rule: r.rule })}
                      disabled={act.busy}
                      onClick={() => void run(() => authApi().removePiiRule(r.id), () => t('asstAdmin.marks.removed'))}
                    >
                      <Trash2 size={16} aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>

        {o.stored && (
          <Panel className="py-3">
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault()
                if (!scopeValid || rule.trim() === '') return
                void run(() => authApi().addPiiRule({ targetKey: key, rule }), (a) => (a.created ? t('asstAdmin.marks.added') : t('asstAdmin.marks.exists'))).then((ok) => ok && setRule(''))
              }}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <label htmlFor={scopeId} className="text-sm font-medium">
                    {t('asstAdmin.marks.scope')}
                  </label>
                  <Select id={scopeId} value={scope.kind} onChange={(e) => setScope({ ...scope, kind: e.target.value as Scope['kind'] })}>
                    <option value="all">{t('asstAdmin.marks.scopeAll')}</option>
                    <option value="one">{t('asstAdmin.marks.scopeOne')}</option>
                  </Select>
                </div>
                {scope.kind === 'one' && (
                  <div className="flex flex-col gap-1">
                    <label htmlFor={targetId} className="text-sm font-medium">
                      {t('asstAdmin.marks.target')}
                    </label>
                    <Input id={targetId} value={scope.target} placeholder="db.example.org:3306" aria-describedby={`${targetId}-hint`} onChange={(e) => setScope({ ...scope, target: e.target.value })} />
                    <p id={`${targetId}-hint`} className="text-xs text-muted">
                      {t('asstAdmin.marks.targetHint')}
                    </p>
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={ruleId} className="text-sm font-medium">
                  {t('asstAdmin.marks.rule')}
                </label>
                <Input id={ruleId} value={rule} placeholder={t('asstAdmin.marks.rulePlaceholder')} spellCheck={false} autoComplete="off" onChange={(e) => setRule(e.target.value)} />
              </div>
              <div>
                <Button type="submit" variant="primary" disabled={act.busy || !scopeValid || rule.trim() === ''}>
                  {t('asstAdmin.marks.add')}
                </Button>
              </div>
            </form>
          </Panel>
        )}
        {note && (
          <p role="status" className="text-sm text-muted">
            {note}
          </p>
        )}
        <ErrorNote message={problem ?? act.error?.message} />
      </Section>

      {o.stored && (
        <Section title={t('asstAdmin.suggest.title')} lead={t('asstAdmin.suggest.lead')}>
          <Panel className="py-3">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  disabled={!connected || act.busy}
                  onClick={async () => {
                    setProblem(null)
                    setNote(null)
                    const r = await act.run(() => authApi().suggestPiiColumns())
                    if (r.ok) {
                      setSuggestions({ list: r.value.suggestions, more: r.value.more })
                      setPicked(new Set())
                    }
                  }}
                >
                  {t('asstAdmin.suggest.button')}
                </Button>
                {!connected && <Muted>{t('asstAdmin.suggest.noConnection')}</Muted>}
              </div>
              {suggestions &&
                (suggestions.list.length === 0 ? (
                  <Muted>{t('asstAdmin.suggest.none')}</Muted>
                ) : (
                  <>
                    <ul aria-label={t('asstAdmin.suggest.listLabel')}>
                      {suggestions.list.map((s) => {
                        const id = `${s.db}.${s.table}.${s.column}`
                        return (
                          <li key={id} className="flex items-start gap-3 border-t border-rule py-2 first:border-t-0">
                            <Checkbox
                              aria-label={t('asstAdmin.suggest.select', { column: id })}
                              checked={picked.has(id)}
                              onChange={(e) => setPicked((p) => (e.target.checked ? new Set(p).add(id) : new Set([...p].filter((x) => x !== id))))}
                            />
                            <div className="min-w-0">
                              <p className="break-all font-mono text-sm">{id}</p>
                              <p className="text-xs text-muted">{tDynamic(`asstAdmin.suggest.reason.${s.reason}`, 'asstAdmin.suggest.lead')}</p>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                    {suggestions.more && <Muted>{t('asstAdmin.suggest.more')}</Muted>}
                    <div>
                      <Button
                        variant="primary"
                        disabled={act.busy || picked.size === 0 || !scopeValid}
                        onClick={async () => {
                          let added = 0
                          for (const id of picked) {
                            const ok = await run(() => authApi().addPiiRule({ targetKey: key, rule: id }), () => '')
                            if (!ok) return
                            added++
                          }
                          setNote(t('asstAdmin.suggest.marked', { count: added }))
                          setPicked(new Set())
                          setSuggestions((s) => (s ? { ...s, list: s.list.filter((x) => !picked.has(`${x.db}.${x.table}.${x.column}`)) } : s))
                        }}
                      >
                        {t('asstAdmin.suggest.mark')}
                      </Button>
                    </div>
                  </>
                ))}
            </div>
          </Panel>
        </Section>
      )}

      {o.stored && (
        <Section title={t('asstAdmin.ack.title')} lead={t('asstAdmin.ack.lead')}>
          <Panel className="py-3">
            {o.acks.length === 0 ? (
              <Muted>{t('asstAdmin.ack.none')}</Muted>
            ) : (
              <ul aria-label={t('asstAdmin.ack.listLabel')}>
                {o.acks.map((a) => (
                  <li key={a.targetKey} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-rule py-2 first:border-t-0">
                    <div className="min-w-0">
                      <p className="break-all text-sm">{scopeLabel(a.targetKey)}</p>
                      <p className="text-xs text-muted">{t('asstAdmin.marks.by', { name: a.acknowledgedBy, when: when(a.acknowledgedAt) })}</p>
                    </div>
                    <Button variant="ghost" size="icon" aria-label={t('asstAdmin.ack.remove', { target: scopeLabel(a.targetKey) })} disabled={act.busy} onClick={() => void run(() => authApi().clearPiiAck(a.targetKey), () => t('asstAdmin.ack.removed'))}>
                      <Trash2 size={16} aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3">
              <p className="mb-2 break-all text-xs text-muted">
                {t('asstAdmin.marks.scope')}: {scopeLabel(key)}
              </p>
              <Button disabled={act.busy || !scopeValid || o.acks.some((a) => a.targetKey === key)} onClick={() => void run(() => authApi().setPiiAck(key), () => t('asstAdmin.ack.added'))}>
                {t('asstAdmin.ack.add')}
              </Button>
            </div>
          </Panel>
        </Section>
      )}
    </>
  )
}
