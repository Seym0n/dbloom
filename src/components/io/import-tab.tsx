import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDownToLine, FileUp } from 'lucide-react'
import { ClassBadge } from '~/components/structure/class-badge'
import { keys } from '~/components/structure/invalidate'
import { Button } from '~/components/ui/button'
import { Label } from '~/components/ui/label'
import { Select } from '~/components/ui/select'
import { ioApi, ioCatalog, type OptionValue } from '~/lib/io/api'
import { isActive, isTerminal, useJob } from '~/lib/io/use-job'
import { useUploadQueue } from '~/lib/io/use-uploads'
import { checkFileName } from '~/lib/io/upload'
import { cn } from '~/lib/utils'
import { t } from '~/i18n'
import type { ImportAnalysis, IoCapabilities, IoFormat, RowImportOptions } from '~/server/io/types'
import { hasFiles, UploadList } from './drop-overlay'
import { ImportConfirmDialog } from './import-confirm-dialog'
import {
  autoMap,
  buildStartRequest,
  confirmName,
  kindsLine,
  proposeColumns,
  reviewToMaps,
  startBlock,
  toColumnMaps,
  toTableDefinition,
  validateMapping,
  validateReview,
  type MapRow,
  type ReviewColumn,
} from './import-model'
import { codeMessage, describeIoFailure, formatBytes } from './job-model'
import { JobProgressView, JobResultView } from './job-progress'
import { MappingStep, NewTableReview, SamplePreview } from './mapping-step'
import { OptionPanel } from './option-panel'
import {
  changeOption,
  defaultValues,
  ROW_IMPORT_OPTIONS,
  SQL_IMPORT_OPTIONS,
  validateOptions,
} from './registry'

const FORMAT_LABEL = { sql: 'io.format.sql', csv: 'io.format.csv', json: 'io.format.json' } as const

/** The row options as the server schema takes them. */
function rowOptionsFor(values: Record<string, unknown>, format: IoFormat): RowImportOptions {
  const out: Record<string, unknown> = {}
  const csvOnly = ['separator', 'enclosure', 'escape', 'lineEnding', 'nullText', 'header']
  for (const [k, v] of Object.entries(values)) {
    if (k === 'jsonTable' && v === '') continue
    if (format === 'json' && csvOnly.includes(k)) continue
    out[k] = v
  }
  return out as RowImportOptions
}

export type UploadedFile = { uploadId: string; name: string; bytes: number; format: IoFormat }

export type ImportTabProps = {
  target: { db?: string; table?: string }
  serverLabel: string
  readOnly: boolean
  /** A file that was dropped on the navigation panel and is already uploaded. */
  initialUpload?: UploadedFile
  onOpenTable?: (db: string, table: string) => void
  /** Offers the normal confirmed drop of a table the failed import created (FR-IO-019). */
  onDropTable?: (db: string, table: string) => void
}

export function ImportTab(props: ImportTabProps) {
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
  if (caps.isError) {
    return (
      <div className="px-6 pt-8">
        <p role="alert" className="text-sm text-negative">
          {t('io.loadFailed')}
        </p>
      </div>
    )
  }
  if (!caps.data) {
    return (
      <div className="px-6 pt-8" aria-busy="true">
        <p className="text-sm text-muted">{t('io.loading')}</p>
      </div>
    )
  }
  return (
    <ImportFlow {...props} caps={caps.data} defaultFormat={prefs.data?.importFormat ?? 'sql'} />
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

function ImportFlow({
  target,
  serverLabel,
  readOnly,
  initialUpload,
  onOpenTable,
  onDropTable,
  caps,
  defaultFormat,
}: ImportTabProps & { caps: IoCapabilities; defaultFormat: IoFormat }) {
  const client = useQueryClient()
  const [file, setFile] = useState<UploadedFile | undefined>(initialUpload)
  const [format, setFormat] = useState<IoFormat>(initialUpload?.format ?? defaultFormat)
  const [charset, setCharset] = useState('utf-8')
  const [sqlValues, setSqlValues] = useState(() => defaultValues(SQL_IMPORT_OPTIONS))
  const [rowValues, setRowValues] = useState(() => defaultValues(ROW_IMPORT_OPTIONS))
  const [dbChoice, setDbChoice] = useState('')
  const [dest, setDest] = useState<'existing' | 'new'>(target.table ? 'existing' : 'existing')
  const [tableChoice, setTableChoice] = useState('')
  const [newName, setNewName] = useState('imported')
  const [review, setReview] = useState<ReviewColumn[] | null>(null)
  const [mapOverride, setMapOverride] = useState<MapRow[] | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [jobId, setJobId] = useState<string | undefined>()
  const [createdTable, setCreatedTable] = useState<string | undefined>()

  const limitText = formatBytes(caps.limits.uploadBytes)
  const uploads = useUploadQueue({
    limitBytes: caps.limits.uploadBytes,
    onDone: (item) => {
      setFile({ uploadId: item.uploadId, name: item.name, bytes: item.bytes, format: item.format })
      setFormat(item.format)
    },
  })

  const rowOptionsKey = JSON.stringify(rowValues)
  const sendCharset = charset === 'utf-8' ? undefined : charset
  const analysisQuery = useQuery({
    queryKey: [
      'io',
      'analysis',
      file?.uploadId,
      format,
      sendCharset ?? null,
      format === 'sql' ? null : rowOptionsKey,
    ],
    enabled: Boolean(file),
    staleTime: Infinity,
    retry: false,
    queryFn: () =>
      ioApi().analyseImport({
        uploadId: (file as UploadedFile).uploadId,
        format,
        ...(sendCharset ? { charset: sendCharset } : {}),
        ...(format === 'sql' ? {} : { rowOptions: rowOptionsFor(rowValues, format) }),
      }),
    placeholderData: (previous) => previous,
  })
  const analysis: ImportAnalysis | undefined = analysisQuery.data

  const isSql = format === 'sql'
  const db = target.db ?? (dbChoice !== '' ? dbChoice : undefined)
  const tableName =
    target.table ?? (dest === 'existing' && tableChoice !== '' ? tableChoice : undefined)

  const dbs = useQuery({
    queryKey: ['io', 'import', 'dbs'],
    enabled: !target.db && !isSql && Boolean(file),
    queryFn: () => ioCatalog().databases(),
  })
  const tables = useQuery({
    queryKey: ['io', 'import', 'tables', db],
    enabled: Boolean(db) && !isSql && !target.table,
    queryFn: () => ioCatalog().tables(db as string),
  })
  const columns = useQuery({
    queryKey: ['io', 'import', 'columns', db, tableName],
    enabled: Boolean(db && tableName) && !isSql,
    queryFn: () => ioCatalog().columns(db as string, tableName as string),
  })

  const byName = format === 'json' || rowValues['header'] === true
  const rowsInfo = analysis?.rows
  const mapRows = useMemo<MapRow[]>(() => {
    if (!rowsInfo || !columns.data) return []
    const def = autoMap(rowsInfo.columns, columns.data, byName)
    return mapOverride && mapOverride.length === def.length ? mapOverride : def
  }, [rowsInfo, columns.data, byName, mapOverride])
  const reviewCols = useMemo(
    () =>
      review ??
      (rowsInfo
        ? proposeColumns(rowsInfo.columns, rowsInfo.sample, byName, rowsInfo.inferred)
        : []),
    [review, rowsInfo, byName],
  )
  // A new analysis, header setting or destination starts the mapping again.
  const analysisKey = analysis?.analysisHash
  useEffect(() => {
    setMapOverride(null)
    setReview(null)
  }, [analysisKey, byName, tableName, dest])

  const optionErrors = Object.keys(
    validateOptions(
      isSql ? SQL_IMPORT_OPTIONS : ROW_IMPORT_OPTIONS,
      isSql ? sqlValues : rowValues,
      {
        format,
        refused: analysis?.statements?.byClass.refused ?? 0,
      },
    ),
  ).length
  const creating = !isSql && dest === 'new' && !target.table
  const rowsReady = creating
    ? validateReview(newName, reviewCols).length === 0
    : Boolean(tableName) && validateMapping(mapRows).problem === undefined && mapRows.length > 0
  const block = analysis
    ? startBlock({
        readOnly,
        analysis,
        db,
        optionErrors,
        skipRefused: sqlValues['skipRefused'] === true,
        rowsReady,
      })
    : null

  const start = useMutation({
    mutationFn: async () => {
      if (!analysis || !file) throw new Error('invalid_request: no file')
      const newTable = creating && db ? toTableDefinition(db, newName, reviewCols) : undefined
      const request = buildStartRequest({
        analysis,
        format,
        ...(sendCharset ? { charset: sendCharset } : {}),
        ...(db ? { db } : {}),
        ...(!creating && tableName ? { table: tableName } : {}),
        ...(newTable ? { newTable } : {}),
        sqlOptions: sqlValues,
        rowOptions: rowValues,
        ...(isSql ? {} : { mapping: creating ? reviewToMaps(reviewCols) : toColumnMaps(mapRows) }),
        ...(analysis.confirmToken ? { confirmToken: analysis.confirmToken } : {}),
      })
      return {
        ref: await ioApi().startImport(request),
        created: newTable ? newTable.name : undefined,
      }
    },
    onSuccess: ({ ref, created }) => {
      setConfirming(false)
      setCreatedTable(created)
      setJobId(ref.jobId)
    },
  })
  const resume = useMutation({
    mutationFn: (id: string) => ioApi().resumeImport(id),
    onSuccess: (ref) => setJobId(ref.jobId),
  })
  const cancel = useMutation({ mutationFn: (id: string) => ioApi().cancelJob(id) })
  const job = useJob(jobId)

  // What an import may have changed is refreshed once per job (FR-IO-024): lists, definitions and rows.
  const refreshed = useRef<string | undefined>(undefined)
  const state = job.data?.state
  useEffect(() => {
    if (
      !jobId ||
      !state ||
      !(isTerminal(state) || state === 'paused') ||
      refreshed.current === jobId + state
    )
      return
    refreshed.current = jobId + state
    void client.invalidateQueries({ queryKey: keys.databases })
    void client.invalidateQueries({ queryKey: ['tables'] })
    void client.invalidateQueries({ queryKey: ['rows'] })
    void client.invalidateQueries({ queryKey: ['structure', 'definition'] })
  }, [jobId, state, client])

  const reset = () => {
    setJobId(undefined)
    setFile(undefined)
    setCreatedTable(undefined)
    uploads.clear()
    start.reset()
  }

  const where = target.table ? `${target.db}.${target.table}` : (target.db ?? serverLabel)
  const header = (
    <div className="min-w-0">
      <h1 className="truncate text-[22px] leading-7 font-semibold">
        {t('io.import.title', { name: where })}
      </h1>
      <p className="text-sm text-muted">{t('io.import.lead')}</p>
    </div>
  )

  // ---- Running and finished -----------------------------------------------------------------------------
  if (jobId) {
    const finalTable = createdTable ?? tableName
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-5 md:px-6">
          {header}
          {job.isError && (
            <p role="alert" className="text-sm text-negative">
              {describeIoFailure(job.error).message}
            </p>
          )}
          {job.data && (isActive(job.data.state) || job.data.state === 'paused') && (
            <JobProgressView
              job={job.data}
              onCancel={() => cancel.mutate(jobId)}
              cancelling={cancel.isPending}
              onResume={() => resume.mutate(jobId)}
              resuming={resume.isPending}
            />
          )}
          {resume.isError && (
            <p role="alert" className="text-sm text-negative">
              {describeIoFailure(resume.error).message}
            </p>
          )}
          {job.data && isTerminal(job.data.state) && (
            <JobResultView
              job={job.data}
              links={
                <>
                  {db &&
                    finalTable &&
                    job.data.state !== 'failed' &&
                    job.data.state !== 'cancelled' &&
                    job.data.state !== 'interrupted' &&
                    onOpenTable && (
                      <Button variant="primary" onClick={() => onOpenTable(db, finalTable)}>
                        {t('io.result.openTable', { name: finalTable })}
                      </Button>
                    )}
                  {db &&
                    createdTable &&
                    (job.data.state === 'failed' || job.data.state === 'cancelled' || job.data.state === 'interrupted') &&
                    onDropTable && (
                      <Button onClick={() => onDropTable(db, createdTable)}>
                        {t('io.result.dropNew', { name: createdTable })}
                      </Button>
                    )}
                  <Button onClick={reset}>{t('io.result.another')}</Button>
                </>
              }
            />
          )}
        </div>
      </div>
    )
  }

  // ---- Choose / review ----------------------------------------------------------------------------------
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-5 md:px-6">
          {header}
          {readOnly && (
            <p
              role="note"
              className="rounded-lg bg-[var(--pill-warning-bg)] p-3 text-sm text-[var(--pill-warning-ink)]"
            >
              {t('io.import.readOnly')}
            </p>
          )}

          {!file && (
            <Section title={t('io.choose.title')}>
              <FileChooser
                format={format}
                onFormat={setFormat}
                caps={caps}
                limitText={limitText}
                onFiles={(files) => uploads.add(files, format)}
              />
              <UploadList
                items={uploads.items}
                limitText={limitText}
                onCancel={uploads.cancel}
                onRemove={uploads.remove}
              />
              {caps.limits.serverFolderEnabled && (
                <FolderList
                  onPick={(f) => {
                    const check = checkFileName(f.name)
                    const fmt = check.ok ? check.format : format
                    setFile({ uploadId: f.id, name: f.name, bytes: f.bytes, format: fmt })
                    setFormat(fmt)
                  }}
                />
              )}
            </Section>
          )}

          {file && (
            <Section title={t('io.file.title')}>
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-muted">{t('io.confirm.file')}</dt>
                <dd className="truncate font-medium" title={file.name}>
                  {file.name} ({formatBytes(file.bytes)})
                </dd>
                {analysis && (
                  <>
                    <dt className="text-muted">{t('io.file.compression')}</dt>
                    <dd>{t(`io.compression.${analysis.compression}`)}</dd>
                  </>
                )}
                <dt className="text-muted">{t('io.confirm.server')}</dt>
                <dd className="truncate">{serverLabel}</dd>
                <dt className="text-muted">{t('io.confirm.database')}</dt>
                <dd className="truncate">{db ?? t('io.confirm.noDatabase')}</dd>
              </dl>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="io-import-format">{t('io.format.label')}</Label>
                  <Select
                    id="io-import-format"
                    value={format}
                    onChange={(e) => setFormat(e.target.value as IoFormat)}
                  >
                    {caps.formats.map((f) => (
                      <option key={f} value={f}>
                        {t(FORMAT_LABEL[f])}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="io-import-charset">{t('io.charset.label')}</Label>
                  <Select
                    id="io-import-charset"
                    value={charset}
                    onChange={(e) => setCharset(e.target.value)}
                    aria-describedby="io-import-charset-hint"
                  >
                    {caps.charsets.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                  <p id="io-import-charset-hint" className="text-xs text-muted">
                    {t('io.charset.hint')}
                  </p>
                </div>
              </div>
              <Button className="self-start" onClick={reset}>
                {t('io.file.change')}
              </Button>
            </Section>
          )}

          {file && analysisQuery.isPending && (
            <p className="text-sm text-muted" aria-busy="true">
              {t('io.analysis.running')}
            </p>
          )}
          {file && analysisQuery.isError && (
            <p role="alert" className="text-sm text-negative">
              {describeIoFailure(analysisQuery.error).message}
            </p>
          )}

          {analysis?.statements && <SqlAnalysis analysis={analysis} dbSelected={Boolean(db)} />}

          {/* A file that cannot be read with the current separator or quotes keeps its options open, so they can be fixed. */}
          {!analysis && analysisQuery.isError && !isSql && (
            <Section title={t('io.options.title')}>
              <OptionPanel
                legend={t('io.opt.legend', { format: t(FORMAT_LABEL[format]) })}
                specs={ROW_IMPORT_OPTIONS}
                values={rowValues}
                ctx={{ format, jsonTables: [] }}
                onChange={(k, v: OptionValue) =>
                  setRowValues((cur) => changeOption(ROW_IMPORT_OPTIONS, cur, k, v))
                }
              />
            </Section>
          )}

          {analysis && (
            <Section title={t('io.options.title')}>
              {isSql ? (
                <OptionPanel
                  legend={t('io.opt.legend', { format: t('io.format.sql') })}
                  specs={SQL_IMPORT_OPTIONS}
                  values={sqlValues}
                  ctx={{ format, refused: analysis.statements?.byClass.refused ?? 0 }}
                  onChange={(k, v: OptionValue) =>
                    setSqlValues((cur) => changeOption(SQL_IMPORT_OPTIONS, cur, k, v))
                  }
                />
              ) : (
                <>
                  {!target.table && (
                    <Destination
                      db={target.db}
                      dbChoice={dbChoice}
                      onDb={setDbChoice}
                      dbList={dbs.data ?? []}
                      dest={dest}
                      onDest={setDest}
                      tableChoice={tableChoice}
                      onTable={setTableChoice}
                      tableList={(tables.data ?? [])
                        .filter((x) => x.kind === 'table')
                        .map((x) => x.name)}
                      hasDb={Boolean(db)}
                    />
                  )}
                  <OptionPanel
                    legend={t('io.opt.legend', { format: t(FORMAT_LABEL[format]) })}
                    specs={ROW_IMPORT_OPTIONS}
                    values={rowValues}
                    ctx={{ format, jsonTables: analysis.rows?.jsonTables ?? [] }}
                    onChange={(k, v: OptionValue) =>
                      setRowValues((cur) => changeOption(ROW_IMPORT_OPTIONS, cur, k, v))
                    }
                  />
                </>
              )}
            </Section>
          )}

          {analysis?.rows && (
            <>
              <Section title={t('io.rows.title')}>
                <SamplePreview
                  columns={analysis.rows.columns}
                  sample={analysis.rows.sample}
                  warnings={analysis.rows.warnings}
                  rowCount={analysis.rows.rowCount}
                />
              </Section>
              {creating && db ? (
                <Section title={t('io.newTable.section')}>
                  <NewTableReview
                    db={db}
                    tableName={newName}
                    onTableName={setNewName}
                    columns={reviewCols}
                    onChange={setReview}
                  />
                </Section>
              ) : tableName && columns.data ? (
                <Section title={t('io.mapping.section')}>
                  <MappingStep
                    rows={mapRows}
                    targets={columns.data}
                    sample={analysis.rows.sample}
                    onChange={setMapOverride}
                  />
                </Section>
              ) : null}
            </>
          )}
        </div>
      </div>

      {analysis && (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-t border-border bg-surface px-4 py-3 md:px-6">
          {block && (
            <p id="io-start-reason" className="mr-auto text-sm text-muted">
              {t(block)}
            </p>
          )}
          <Button
            variant="primary"
            size="lg"
            disabled={block !== null}
            aria-describedby={block ? 'io-start-reason' : undefined}
            onClick={() => setConfirming(true)}
          >
            <ArrowDownToLine size={14} aria-hidden />
            {t('io.import.start')}
          </Button>
        </div>
      )}

      {analysis && (
        <ImportConfirmDialog
          open={confirming}
          analysis={analysis}
          server={serverLabel}
          db={db}
          table={creating ? newName : tableName}
          typedName={confirmName(db, serverLabel)}
          busy={start.isPending}
          error={start.isError ? describeIoFailure(start.error).message : null}
          onCancel={() => {
            setConfirming(false)
            start.reset()
          }}
          onConfirm={() => start.mutate()}
        />
      )}
    </div>
  )
}

function FileChooser({
  format,
  onFormat,
  caps,
  limitText,
  onFiles,
}: {
  format: IoFormat
  onFormat: (f: IoFormat) => void
  caps: IoCapabilities
  limitText: string
  onFiles: (files: File[]) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const stop = (e: DragEvent) => {
    if (hasFiles(e.dataTransfer?.types)) e.preventDefault()
  }
  return (
    <div className="flex flex-col gap-3">
      <div
        onDragEnter={(e) => {
          stop(e)
          setOver(true)
        }}
        onDragOver={stop}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          stop(e)
          setOver(false)
          onFiles(Array.from(e.dataTransfer.files))
        }}
        className={cn(
          'flex flex-col items-start gap-2 rounded-lg border border-dashed border-control p-5',
          over && 'border-accent bg-raised',
        )}
      >
        <p className="text-sm">{t('io.choose.drop')}</p>
        <Button onClick={() => input.current?.click()}>
          <FileUp size={14} aria-hidden />
          {t('io.choose.pick')}
        </Button>
        <input
          ref={input}
          type="file"
          tabIndex={-1}
          aria-label={t('io.choose.pick')}
          className="sr-only"
          accept=".sql,.csv,.json,.gz,.zip"
          onChange={(e) => {
            onFiles(Array.from(e.target.files ?? []))
            e.target.value = ''
          }}
        />
        <p className="text-xs text-muted">{t('io.choose.limit', { limit: limitText })}</p>
      </div>
      <div className="flex max-w-xs flex-col gap-1.5">
        <Label htmlFor="io-choose-format">{t('io.choose.format')}</Label>
        <Select
          id="io-choose-format"
          value={format}
          aria-describedby="io-choose-format-hint"
          onChange={(e) => onFormat(e.target.value as IoFormat)}
        >
          {caps.formats.map((f) => (
            <option key={f} value={f}>
              {t(FORMAT_LABEL[f])}
            </option>
          ))}
        </Select>
        <p id="io-choose-format-hint" className="text-xs text-muted">
          {t('io.choose.formatHint')}
        </p>
      </div>
    </div>
  )
}

function FolderList({
  onPick,
}: {
  onPick: (f: { id: string; name: string; bytes: number }) => void
}) {
  const list = useQuery({ queryKey: ['io', 'folder'], queryFn: () => ioApi().listImportFolder() })
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-sm font-medium">{t('io.folder.title')}</h3>
      {list.isError && (
        <p role="alert" className="text-sm text-negative">
          {describeIoFailure(list.error).code === 'not_enabled'
            ? codeMessage('not_enabled')
            : t('io.folder.failed')}
        </p>
      )}
      {list.data?.length === 0 && <p className="text-sm text-muted">{t('io.folder.empty')}</p>}
      <ul className="flex flex-col">
        {(list.data ?? []).map((f) => (
          <li key={f.id}>
            <button
              type="button"
              onClick={() => onPick(f)}
              className="press flex min-h-9 w-full items-center gap-2 rounded px-2 text-left text-sm hover:bg-raised pointer-coarse:min-h-11"
            >
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="text-xs text-muted">{formatBytes(f.bytes)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Destination({
  db,
  dbChoice,
  onDb,
  dbList,
  dest,
  onDest,
  tableChoice,
  onTable,
  tableList,
  hasDb,
}: {
  db: string | undefined
  dbChoice: string
  onDb: (v: string) => void
  dbList: string[]
  dest: 'existing' | 'new'
  onDest: (v: 'existing' | 'new') => void
  tableChoice: string
  onTable: (v: string) => void
  tableList: string[]
  hasDb: boolean
}) {
  return (
    <div className="flex flex-col gap-3">
      {!db && (
        <div className="flex max-w-xs flex-col gap-1.5">
          <Label htmlFor="io-dest-db">{t('io.dest.database')}</Label>
          <Select id="io-dest-db" value={dbChoice} onChange={(e) => onDb(e.target.value)}>
            <option value="">{t('io.dest.pickDatabase')}</option>
            {dbList.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        </div>
      )}
      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-sm font-medium">{t('io.dest.legend')}</legend>
        <div className="flex flex-wrap gap-x-6">
          {(['existing', 'new'] as const).map((v) => (
            <label key={v} className="flex items-center gap-2 text-sm pointer-coarse:min-h-11">
              <input
                type="radio"
                name="io-dest"
                value={v}
                checked={dest === v}
                onChange={() => onDest(v)}
                className="h-[18px] w-[18px] accent-[var(--accent)]"
              />
              {t(v === 'existing' ? 'io.dest.existing' : 'io.dest.new')}
            </label>
          ))}
        </div>
      </fieldset>
      {dest === 'existing' && (
        <div className="flex max-w-xs flex-col gap-1.5">
          <Label htmlFor="io-dest-table">{t('io.dest.table')}</Label>
          <Select
            id="io-dest-table"
            value={tableChoice}
            disabled={!hasDb}
            onChange={(e) => onTable(e.target.value)}
          >
            <option value="">{t('io.dest.pickTable')}</option>
            {tableList.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </div>
      )}
    </div>
  )
}

/** Statement classes of the analysis by kind and count (FR-IO-016). */
function SqlAnalysis({ analysis, dbSelected }: { analysis: ImportAnalysis; dbSelected: boolean }) {
  const s = analysis.statements
  if (!s) return null
  const refused = s.byClass.refused ?? 0
  return (
    <Section title={t('io.analysis.title')}>
      <p className="text-sm">{t('io.analysis.total', { n: s.total.toLocaleString('en') })}</p>
      <ul className="flex flex-wrap gap-x-5 gap-y-2" aria-label={t('io.analysis.byClass')}>
        {(['none', 'soft', 'hard'] as const).map((c) => (
          <li key={c} className="flex items-center gap-2 text-sm">
            <ClassBadge value={c} />
            <span className="font-medium">{(s.byClass[c] ?? 0).toLocaleString('en')}</span>
          </li>
        ))}
        {refused > 0 && (
          <li className="flex items-center gap-2 text-sm">
            <span className="inline-flex h-5 items-center rounded-full bg-[var(--pill-negative-bg)] px-2 text-xs font-medium text-[var(--pill-negative-ink)]">
              {t('io.analysis.refused')}
            </span>
            <span className="font-medium">{refused.toLocaleString('en')}</span>
          </li>
        )}
      </ul>
      {Object.keys(s.hardKinds).length > 0 && (
        <p className="text-sm">
          <span className="text-muted">{t('io.analysis.hardKinds')}</span> {kindsLine(s.hardKinds)}
        </p>
      )}
      {refused > 0 && (
        <p className="text-sm">
          <span className="text-muted">{t('io.analysis.refusedKinds')}</span>{' '}
          {kindsLine(s.refusedKinds)}
        </p>
      )}
      {s.createsDatabases.length > 0 && (
        <p className="text-sm">
          <span className="text-muted">{t('io.analysis.creates')}</span>{' '}
          {s.createsDatabases.join(', ')}
        </p>
      )}
      {s.dropsDatabases.length > 0 && (
        <p className="text-sm">
          <span className="text-muted">{t('io.analysis.drops')}</span> {s.dropsDatabases.join(', ')}
        </p>
      )}
      {s.needsDatabase && !s.usesDatabase && !dbSelected && (
        <p role="alert" className="text-sm text-negative">
          {t('io.analysis.needsDatabase')}
        </p>
      )}
    </Section>
  )
}
