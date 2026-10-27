import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpFromLine, Copy, Download, Settings2 } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Select } from '~/components/ui/select'
import {
  downloadUrl,
  ioApi,
  type ExportTemplate,
  type IoPrefs,
  type OptionValue,
} from '~/lib/io/api'
import { isActive, isTerminal, useJob } from '~/lib/io/use-job'
import { t } from '~/i18n'
import type { IoCapabilities, IoFormat, Compression } from '~/server/io/types'
import { MAX_TEMPLATE_NAME } from '~/server/io/types'
import {
  buildExportRequest,
  FILE_TOKENS,
  initialExportState,
  isMultiScope,
  nameContext,
  normalizeExport,
  previewFileName,
  scopeKey,
  validateExport,
  type ExportState,
  type ExportTarget,
} from './export-model'
import { describeIoFailure } from './job-model'
import { JobProgressView, JobResultView } from './job-progress'
import { OptionPanel } from './option-panel'
import { changeOption, EXPORT_OPTIONS } from './registry'
import { ScopePicker, useScopeItems } from './scope-picker'

const FORMAT_LABEL = { sql: 'io.format.sql', csv: 'io.format.csv', json: 'io.format.json' } as const
const COMPRESSION_LABEL = {
  none: 'io.compression.none',
  gzip: 'io.compression.gzip',
  zip: 'io.compression.zip',
} as const

export type ExportTabProps = {
  target: ExportTarget
  /** `host:port` of the connected server, for the `@SERVER@` token and the title. */
  serverLabel: string
}

/** Sorted by the localised label, ignoring case (FR-PLG-006). */
const sortedFormats = (formats: IoFormat[]) =>
  [...formats].sort((a, b) =>
    t(FORMAT_LABEL[a]).localeCompare(t(FORMAT_LABEL[b]), undefined, { sensitivity: 'base' }),
  )

export function targetTitle(target: ExportTarget, serverLabel: string): string {
  switch (target.kind) {
    case 'server':
      return serverLabel
    case 'database':
      return target.db
    case 'table':
      return `${target.db}.${target.table}`
    case 'result':
      return t('io.export.resultName')
  }
}

export function ExportTab(props: ExportTabProps) {
  const caps = useQuery({
    queryKey: ['io', 'caps'],
    queryFn: () => ioApi().getCapabilities(),
    staleTime: 60_000,
  })
  const prefs = useQuery({
    queryKey: ['io', 'prefs'],
    queryFn: () => ioApi().getPrefs(),
    staleTime: 60_000,
  })
  if (caps.isError || prefs.isError) {
    return (
      <div className="px-6 pt-8">
        <p className="text-sm text-negative" role="alert">
          {t('io.loadFailed')}
        </p>
      </div>
    )
  }
  if (!caps.data || !prefs.data) {
    return (
      <div className="px-6 pt-8" aria-busy="true">
        <p className="text-sm text-muted">{t('io.loading')}</p>
      </div>
    )
  }
  return <ExportForm {...props} caps={caps.data} prefs={prefs.data} />
}

function triggerDownload(jobId: string) {
  const a = document.createElement('a')
  a.href = downloadUrl(jobId)
  a.download = ''
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function ExportForm({
  target,
  serverLabel,
  caps,
  prefs,
}: ExportTabProps & { caps: IoCapabilities; prefs: IoPrefs }) {
  const client = useQueryClient()
  const [mode, setMode] = useState<IoPrefs['mode']>(prefs.mode)
  const [raw, setRaw] = useState<ExportState>(() => initialExportState(prefs, target))
  const { state, forced } = useMemo(() => normalizeExport(raw, target, caps), [raw, target, caps])
  const items = useScopeItems(target)
  const allNames = useMemo(() => (items.data ?? []).map((i) => i.name), [items.data])
  const problems = validateExport(state, target, allNames)
  const [jobId, setJobId] = useState<string | undefined>()
  const [lastView, setLastView] = useState<'file' | 'text'>('file')
  const job = useJob(jobId)
  const cancel = useMutation({ mutationFn: (id: string) => ioApi().cancelJob(id) })

  const patch = (p: Partial<ExportState>) => setRaw((cur) => ({ ...cur, ...p }))
  const setOption = (key: string, value: OptionValue) =>
    setRaw((cur) => ({
      ...cur,
      options: {
        ...cur.options,
        [state.format]: changeOption(
          EXPORT_OPTIONS[state.format],
          cur.options[state.format],
          key,
          value,
        ),
      },
    }))

  const fileName = previewFileName(
    state.fileNameTemplate,
    nameContext(target, serverLabel),
    state.format,
    state.compression,
  )

  const start = useMutation({
    mutationFn: async () => {
      const request = buildExportRequest(state, target, caps, allNames)
      const ref = await ioApi().startExport(request)
      // Last values are remembered per user (FR-IO-011); a failure to save must not fail the export.
      void ioApi()
        .setPrefs({
          mode,
          exportFormat: state.format,
          exportCompression: state.compression,
          fileNameTemplates: {
            ...prefs.fileNameTemplates,
            [scopeKey(target)]: state.fileNameTemplate,
          },
        })
        .then(() => client.invalidateQueries({ queryKey: ['io', 'prefs'] }))
        .catch(() => undefined)
      return { ref, view: request.view }
    },
    onSuccess: ({ ref, view }) => {
      setLastView(view)
      setJobId(ref.jobId)
    },
  })

  // The browser download starts once, when the job has finished cleanly and the output is a file.
  const downloaded = useRef<string | undefined>(undefined)
  const finished = job.data && isTerminal(job.data.state)
  const clean = job.data?.state === 'done' || job.data?.state === 'done_with_skips'
  useEffect(() => {
    if (jobId && finished && clean && lastView === 'file' && downloaded.current !== jobId) {
      downloaded.current = jobId
      triggerDownload(jobId)
    }
  }, [jobId, finished, clean, lastView])

  const running =
    start.isPending || (jobId !== undefined && !finished && job.data?.state !== 'paused')
  const startFailure = start.isError ? describeIoFailure(start.error) : null
  const canStart = problems.length === 0 && !running

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="truncate text-[22px] leading-7 font-semibold">
          {t('io.export.title', { name: targetTitle(target, serverLabel) })}
        </h1>
        <p className="text-sm text-muted">{t('io.export.lead')}</p>
      </div>
      {!jobId && (
        <div
          role="group"
          aria-label={t('io.mode.label')}
          className="flex gap-1 rounded-lg bg-raised p-0.5"
        >
          {(['quick', 'custom'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={`press h-8 rounded-md px-3 text-sm pointer-coarse:h-11 ${
                mode === m
                  ? 'bg-surface font-semibold text-ink shadow-sm'
                  : 'text-muted hover:text-ink'
              }`}
            >
              {t(m === 'quick' ? 'io.mode.quick' : 'io.mode.custom')}
            </button>
          ))}
        </div>
      )}
    </div>
  )

  // After the start the form gives way to progress and result; Back returns to the same options.
  if (jobId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-5 md:px-6">
          {header}
          {job.isError && (
            <p role="alert" className="text-sm text-negative">
              {describeIoFailure(job.error).message}
            </p>
          )}
          {job.data && isActive(job.data.state) && (
            <JobProgressView
              job={job.data}
              onCancel={() => cancel.mutate(jobId)}
              cancelling={cancel.isPending}
            />
          )}
          {job.data && finished && (
            <>
              <JobResultView
                job={job.data}
                links={
                  <>
                    {clean && lastView === 'file' && (
                      <a
                        href={downloadUrl(jobId)}
                        download
                        className="press inline-flex h-8 items-center gap-2 rounded-[var(--radius-control)] border border-control bg-surface px-3 text-sm font-medium hover:bg-raised pointer-coarse:h-11"
                      >
                        <Download size={14} aria-hidden />
                        {t('io.export.downloadAgain')}
                      </a>
                    )}
                    <Button onClick={() => setJobId(undefined)}>{t('io.export.back')}</Button>
                    {!clean && (
                      <Button onClick={() => start.mutate()}>{t('io.export.retry')}</Button>
                    )}
                  </>
                }
              />
              {clean && lastView === 'text' && (
                <TextView
                  jobId={jobId}
                  onRefresh={() => start.mutate()}
                  refreshing={start.isPending}
                />
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-5 md:px-6">
          {header}
          {mode === 'quick' ? (
            <QuickPanel
              state={state}
              fileName={fileName}
              onCustomise={() => setMode('custom')}
              multi={isMultiScope(target)}
            />
          ) : (
            <CustomPanel
              {...{ state, target, caps, forced, serverLabel, fileName }}
              items={items.data ?? []}
              itemsLoading={items.isPending && items.fetchStatus !== 'idle'}
              itemsFailed={items.isError}
              patch={patch}
              setOption={setOption}
              problems={problems}
            />
          )}
          {startFailure && (
            <p role="alert" className="text-sm text-negative">
              {startFailure.message}
            </p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-t border-border bg-surface px-4 py-3 md:px-6">
        {problems.length > 0 && (
          <p className="mr-auto text-sm text-muted">{t('io.export.fixFirst')}</p>
        )}
        <Button variant="primary" size="lg" disabled={!canStart} onClick={() => start.mutate()}>
          <ArrowUpFromLine size={14} aria-hidden />
          {start.isPending ? t('io.export.starting') : t('io.export.start')}
        </Button>
      </div>
    </div>
  )
}

function QuickPanel({
  state,
  fileName,
  onCustomise,
  multi,
}: {
  state: ExportState
  fileName: string
  onCustomise: () => void
  multi: boolean
}) {
  const parts = [t(FORMAT_LABEL[state.format])]
  if (state.format === 'sql') {
    const c = state.options.sql['content']
    parts.push(
      t(
        c === 'structure' ? 'io.quick.structure' : c === 'data' ? 'io.quick.data' : 'io.quick.both',
      ),
    )
  }
  parts.push(t(COMPRESSION_LABEL[state.compression]).toLowerCase(), fileName)
  return (
    <section
      aria-label={t('io.mode.quick')}
      className="flex flex-col gap-3 rounded-lg bg-raised p-4"
    >
      <h2 className="text-sm font-semibold">{t('io.quick.heading')}</h2>
      <p className="text-sm" data-testid="quick-summary">
        {parts.join(', ')}
      </p>
      {multi && <p className="text-xs text-muted">{t('io.quick.multi')}</p>}
      <Button className="self-start" onClick={onCustomise}>
        <Settings2 size={14} aria-hidden />
        {t('io.quick.customise')}
      </Button>
    </section>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-5 first:border-t-0 first:pt-0">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function CustomPanel(props: {
  state: ExportState
  target: ExportTarget
  caps: IoCapabilities
  forced: ReturnType<typeof normalizeExport>['forced']
  serverLabel: string
  fileName: string
  items: { name: string; view?: boolean }[]
  itemsLoading: boolean
  itemsFailed: boolean
  patch: (p: Partial<ExportState>) => void
  setOption: (key: string, value: OptionValue) => void
  problems: ReturnType<typeof validateExport>
}) {
  const { state, target, caps, forced, patch, items } = props
  const multi = isMultiScope(target)
  const hasProblem = (code: string) => props.problems.some((p) => p.code === code)
  return (
    <>
      <Section title={t('io.section.what')}>
        {(target.kind === 'server' || target.kind === 'database') && (
          <ScopePicker
            kind={target.kind}
            items={items}
            excluded={state.excluded}
            onChange={(excluded) => patch({ excluded })}
            loading={props.itemsLoading}
            failed={props.itemsFailed}
          />
        )}
        {target.kind === 'database' && (
          <div className="flex max-w-xs flex-col gap-1.5">
            <Label htmlFor="io-max-table">{t('io.skipLarge.label')}</Label>
            <div className="flex items-center gap-2">
              <Input
                id="io-max-table"
                type="number"
                inputMode="numeric"
                min={1}
                value={state.maxTableMiB}
                aria-invalid={hasProblem('maxTable')}
                aria-describedby="io-max-table-hint"
                onChange={(e) =>
                  patch({ maxTableMiB: e.target.value === '' ? '' : Number(e.target.value) })
                }
              />
              <span className="text-sm text-muted">{t('io.opt.unit.mib')}</span>
            </div>
            <p id="io-max-table-hint" className="text-xs text-muted">
              {t('io.skipLarge.hint')}
            </p>
          </div>
        )}
        {target.kind === 'table' && (
          <RangeFields state={state} patch={patch} invalid={hasProblem('range')} />
        )}
        {target.kind === 'result' && (
          <pre className="max-h-40 overflow-auto rounded-lg bg-raised p-3 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
            {target.text}
          </pre>
        )}
      </Section>

      <Section title={t('io.section.format')}>
        <div className="flex max-w-xs flex-col gap-1.5">
          <Label htmlFor="io-format">{t('io.format.label')}</Label>
          <Select
            id="io-format"
            value={state.format}
            onChange={(e) => patch({ format: e.target.value as IoFormat })}
          >
            {sortedFormats(caps.formats).map((f) => (
              <option key={f} value={f}>
                {t(FORMAT_LABEL[f])}
              </option>
            ))}
          </Select>
        </div>
        <OptionPanel
          legend={t('io.opt.legend', { format: t(FORMAT_LABEL[state.format]) })}
          specs={EXPORT_OPTIONS[state.format]}
          values={state.options[state.format]}
          ctx={{ format: state.format }}
          onChange={props.setOption}
          locked={
            caps.limits.mayDisableFormulaNeutralisation
              ? undefined
              : { neutraliseFormulas: 'io.opt.csv.formulas.locked' }
          }
        />
      </Section>

      <Section title={t('io.section.output')}>
        <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="io-compression">{t('io.compression.label')}</Label>
            <Select
              id="io-compression"
              value={state.compression}
              disabled={forced.compression === 'csvZip'}
              onChange={(e) => patch({ compression: e.target.value as Compression })}
            >
              {caps.compressions.map((c) => (
                <option key={c} value={c}>
                  {t(COMPRESSION_LABEL[c])}
                </option>
              ))}
            </Select>
            {forced.compression === 'csvZip' && (
              <p className="text-xs text-muted">{t('io.compression.csvZip')}</p>
            )}
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm font-medium">{t('io.view.label')}</legend>
            <div className="flex flex-wrap gap-x-6">
              {(['file', 'text'] as const).map((v) => (
                <label key={v} className="flex items-center gap-2 text-sm pointer-coarse:min-h-11">
                  <input
                    type="radio"
                    name="io-view"
                    value={v}
                    checked={state.view === v}
                    disabled={v === 'text' && forced.text === 'zip' && state.compression === 'zip'}
                    onChange={() => patch({ view: v })}
                    className="h-[18px] w-[18px] accent-[var(--accent)]"
                  />
                  {t(v === 'file' ? 'io.view.file' : 'io.view.text')}
                </label>
              ))}
            </div>
            {state.compression === 'zip' && (
              <p className="text-xs text-muted">{t('io.view.zipNoText')}</p>
            )}
          </fieldset>
        </div>

        <div className="flex flex-col gap-3">
          <CheckRow
            id="io-separate"
            label={t('io.separate.label')}
            checked={state.separateFiles}
            disabled={forced.separate !== undefined}
            hint={
              forced.separate === 'needsZip'
                ? t('io.separate.needsZip')
                : forced.separate === 'singleObject'
                  ? t('io.separate.single')
                  : undefined
            }
            onChange={(v) => patch({ separateFiles: v })}
          />
          {target.kind !== 'result' && (
            <CheckRow
              id="io-lock"
              label={t('io.lock.label')}
              hint={t('io.lock.hint')}
              checked={state.lock}
              onChange={(v) => patch({ lock: v })}
            />
          )}
          {multi && (
            <CheckRow
              id="io-skip-unreadable"
              label={t('io.skipUnreadable.label')}
              hint={t('io.skipUnreadable.hint')}
              checked={state.skipUnreadable}
              onChange={(v) => patch({ skipUnreadable: v })}
            />
          )}
        </div>

        <FileNameField
          value={state.fileNameTemplate}
          onChange={(v) => patch({ fileNameTemplate: v })}
          preview={props.fileName}
          invalid={hasProblem('template')}
        />
      </Section>

      <Templates state={state} patch={patch} />
    </>
  )
}

function CheckRow({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string
  label: string
  hint?: string | undefined
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-start gap-2 pointer-coarse:min-h-11">
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5"
        />
        <Label htmlFor={id} className="font-normal">
          {label}
        </Label>
      </div>
      {hint && (
        <p id={`${id}-hint`} className="pl-[26px] text-xs text-muted">
          {hint}
        </p>
      )}
    </div>
  )
}

function RangeFields({
  state,
  patch,
  invalid,
}: {
  state: ExportState
  patch: (p: Partial<ExportState>) => void
  invalid: boolean
}) {
  return (
    <div className="flex flex-col gap-2">
      <CheckRow
        id="io-range"
        label={t('io.range.label')}
        checked={state.rangeOn}
        onChange={(v) => patch({ rangeOn: v })}
      />
      {state.rangeOn && (
        <div className="grid max-w-md grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="io-offset">{t('io.range.offset')}</Label>
            <Input
              id="io-offset"
              type="number"
              inputMode="numeric"
              min={0}
              aria-invalid={invalid}
              value={state.offset}
              onChange={(e) =>
                patch({ offset: e.target.value === '' ? '' : Number(e.target.value) })
              }
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="io-count">{t('io.range.count')}</Label>
            <Input
              id="io-count"
              type="number"
              inputMode="numeric"
              min={1}
              aria-invalid={invalid}
              value={state.count}
              onChange={(e) =>
                patch({ count: e.target.value === '' ? '' : Number(e.target.value) })
              }
            />
          </div>
          {invalid && (
            <p role="alert" className="col-span-2 text-xs text-negative">
              {t('io.range.invalid')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function FileNameField({
  value,
  onChange,
  preview,
  invalid,
}: {
  value: string
  onChange: (v: string) => void
  preview: string
  invalid: boolean
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="io-filename">{t('io.filename.label')}</Label>
      <Input
        id="io-filename"
        value={value}
        autoComplete="off"
        spellCheck={false}
        maxLength={MAX_TEMPLATE_NAME + 20}
        aria-invalid={invalid}
        aria-describedby="io-filename-preview"
        onChange={(e) => onChange(e.target.value)}
      />
      <p id="io-filename-preview" className="text-xs text-muted">
        {t('io.filename.preview')} <span className="font-medium text-ink">{preview}</span>
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted hover:text-ink pointer-coarse:py-2">
          {t('io.filename.tokens')}
        </summary>
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          {FILE_TOKENS.map((tok) => (
            <div key={tok.token} className="contents">
              <dt className="font-medium">{tok.token}</dt>
              <dd className="text-muted">{t(tok.help)}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-muted">{t('io.filename.sanitised')}</p>
      </details>
    </div>
  )
}

function Templates({
  state,
  patch,
}: {
  state: ExportState
  patch: (p: Partial<ExportState>) => void
}) {
  const client = useQueryClient()
  const list = useQuery({ queryKey: ['io', 'templates'], queryFn: () => ioApi().listTemplates() })
  const mine = (list.data ?? []).filter((x) => x.format === state.format)
  const [chosen, setChosen] = useState('')
  const [name, setName] = useState('')
  const save = useMutation({
    mutationFn: (tpl: ExportTemplate) => ioApi().saveTemplate(tpl),
    onSuccess: () => client.invalidateQueries({ queryKey: ['io', 'templates'] }),
  })
  const remove = useMutation({
    mutationFn: (n: string) => ioApi().deleteTemplate({ format: state.format, name: n }),
    onSuccess: () => {
      setChosen('')
      return client.invalidateQueries({ queryKey: ['io', 'templates'] })
    },
  })
  const error = save.isError
    ? describeIoFailure(save.error).message
    : remove.isError
      ? describeIoFailure(remove.error).message
      : null
  return (
    <Section title={t('io.templates.title')}>
      <p className="text-sm text-muted">{t('io.templates.lead')}</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-48 flex-1 flex-col gap-1.5">
          <Label htmlFor="io-template-choose">{t('io.templates.choose')}</Label>
          <Select
            id="io-template-choose"
            value={chosen}
            onChange={(e) => setChosen(e.target.value)}
          >
            <option value="">
              {mine.length === 0 ? t('io.templates.empty') : t('io.templates.pick')}
            </option>
            {mine.map((x) => (
              <option key={x.name} value={x.name}>
                {x.name}
              </option>
            ))}
          </Select>
        </div>
        <Button
          disabled={chosen === ''}
          onClick={() => {
            const tpl = mine.find((x) => x.name === chosen)
            if (tpl) {
              patch({
                options: {
                  ...state.options,
                  [state.format]: { ...state.options[state.format], ...tpl.options },
                },
              })
              setName(tpl.name)
            }
          }}
        >
          {t('io.templates.load')}
        </Button>
        <Button disabled={chosen === '' || remove.isPending} onClick={() => remove.mutate(chosen)}>
          {t('io.templates.delete')}
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-48 flex-1 flex-col gap-1.5">
          <Label htmlFor="io-template-name">{t('io.templates.name')}</Label>
          <Input
            id="io-template-name"
            value={name}
            maxLength={MAX_TEMPLATE_NAME}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <Button
          disabled={name.trim() === '' || save.isPending}
          onClick={() =>
            save.mutate({
              name: name.trim(),
              format: state.format,
              options: state.options[state.format],
            })
          }
        >
          {t('io.templates.save')}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-negative">
          {error}
        </p>
      )}
    </Section>
  )
}

/** Read-only text of a finished text-mode export with Copy, Refresh and Back (FR-IO-009, UI-UPD-011). */
function TextView({
  jobId,
  onRefresh,
  refreshing,
}: {
  jobId: string
  onRefresh: () => void
  refreshing: boolean
}) {
  const text = useQuery({ queryKey: ['io', 'text', jobId], queryFn: () => ioApi().readText(jobId) })
  const [copied, setCopied] = useState(false)
  async function copy() {
    if (!text.data) return
    try {
      await navigator.clipboard.writeText(text.data.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }
  return (
    <section aria-label={t('io.text.title')} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-sm font-semibold">{t('io.text.title')}</h3>
        <Button disabled={!text.data} onClick={() => void copy()}>
          <Copy size={14} aria-hidden />
          {copied ? t('io.text.copied') : t('io.text.copy')}
        </Button>
        <Button disabled={refreshing} onClick={onRefresh}>
          {t('io.text.refresh')}
        </Button>
      </div>
      {text.isError && (
        <p role="alert" className="text-sm text-negative">
          {describeIoFailure(text.error).message}
        </p>
      )}
      {text.data && (
        <>
          {text.data.truncated && <p className="text-xs text-muted">{t('io.text.truncated')}</p>}
          <textarea
            readOnly
            aria-label={t('io.text.title')}
            value={text.data.text}
            rows={14}
            spellCheck={false}
            className="w-full resize-y rounded-lg border border-control bg-raised p-3 font-mono text-xs"
          />
        </>
      )}
    </section>
  )
}
