import { useId, useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import type { PreviewInput, TableDefinition } from '~/server/structure/types'
import { t } from '~/i18n'
import { CheckEditor } from './check-editor'
import { ColumnsGrid } from './column-row'
import { Field } from './field'
import { FkEditor } from './fk-editor'
import { IndexEditor } from './index-editor'
import { keys } from './invalidate'
import {
  buildAlterInput,
  buildCreateInput,
  diffToOps,
  draftFromDefinition,
  emptyDraft,
  validateDraft,
  type Draft,
} from './model'
import { PreviewDialog, type PreviewRequest } from './preview-dialog'
import { TableOptionsEditor } from './table-options'
import { useStructureLists, useTableDefinition } from './use-structure'

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 pt-6">
      <h2 id={id} className="px-6 text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  )
}

function DesignerForm({
  titleId,
  db,
  table,
  current,
  readOnly,
  onPreview,
}: {
  titleId: string
  db: string
  table?: string
  current?: TableDefinition
  readOnly?: boolean
  onPreview: (input: PreviewInput) => void
}) {
  const lists = useStructureLists()
  const caps = lists.data?.capabilities
  const [draft, setDraft] = useState<Draft>(() =>
    current ? draftFromDefinition(current) : emptyDraft(),
  )
  const [submitted, setSubmitted] = useState(false)

  const alter = current !== undefined
  const tableName = alter ? (table as string) : draft.name
  const allErrors = useMemo(
    () => validateDraft({ db, tableName, draft, caps }),
    [db, tableName, draft, caps],
  )
  const errors = submitted
    ? allErrors
    : draft.name !== '' && allErrors['name']
      ? { name: allErrors['name'] }
      : {}
  const errorCount = Object.keys(allErrors).length
  const ops = useMemo(
    () => (current ? diffToOps(current, draft, caps) : []),
    [current, draft, caps],
  )

  function preview() {
    setSubmitted(true)
    if (errorCount > 0) {
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      )
      return
    }
    if (alter) {
      if (ops.length === 0) return
      onPreview(buildAlterInput(db, tableName, ops))
    } else {
      onPreview(buildCreateInput(db, draft))
    }
  }

  const status =
    submitted && errorCount > 0
      ? t('structure.designer.problems', { count: errorCount })
      : alter
        ? ops.length === 0
          ? t('structure.designer.noChanges')
          : t('structure.designer.changes', { count: ops.length })
        : ''

  return (
    <>
      <header className="flex flex-wrap items-end gap-x-6 gap-y-3 px-6 pt-5 pb-1">
        <div className="min-w-0">
          <h1 id={titleId} className="text-[22px] leading-7 font-semibold">
            {alter ? (
              <>
                <span className="text-muted">{db}.</span>
                {table}
              </>
            ) : (
              t('structure.designer.createTitle', { db })
            )}
          </h1>
          <p className="text-sm text-muted">
            {lists.data
              ? `${lists.data.server.product === 'mariadb' ? 'MariaDB' : 'MySQL'} ${lists.data.server.version}`
              : lists.isError
                ? t('structure.lists.error')
                : ''}
          </p>
        </div>
        {!alter && (
          <Field
            label={t('structure.designer.tableName')}
            error={errors['name']}
            className="w-full max-w-sm"
          >
            {(p) => (
              <Input
                {...p}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
            )}
          </Field>
        )}
        {readOnly && (
          <p className="rounded-full bg-[var(--pill-warning-bg)] px-3 text-xs leading-6 font-medium text-[var(--pill-warning-ink)]">
            {t('structure.readOnlyBadge')}
          </p>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        <Section id={`${titleId}-columns`} title={t('structure.columns')}>
          <ColumnsGrid draft={draft} setDraft={setDraft} errors={errors} caps={caps} />
        </Section>
        <Section id={`${titleId}-indexes`} title={t('structure.indexes')}>
          <IndexEditor draft={draft} setDraft={setDraft} errors={errors} caps={caps} />
        </Section>
        <Section id={`${titleId}-fks`} title={t('structure.fks')}>
          <FkEditor
            db={db}
            tableName={tableName}
            draft={draft}
            setDraft={setDraft}
            errors={errors}
          />
        </Section>
        <Section id={`${titleId}-checks`} title={t('structure.checks')}>
          <CheckEditor draft={draft} setDraft={setDraft} errors={errors} caps={caps} />
        </Section>
        <Section id={`${titleId}-options`} title={t('structure.options')}>
          <TableOptionsEditor
            draft={draft}
            setDraft={setDraft}
            errors={errors}
            lists={lists.data}
          />
        </Section>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border bg-surface px-6 py-3">
        <p className="min-w-0 flex-1 text-sm text-muted" role="status" aria-live="polite">
          {status}
        </p>
        {alter && (
          <Button
            disabled={
              ops.length === 0 &&
              JSON.stringify(draft) === JSON.stringify(draftFromDefinition(current))
            }
            onClick={() => {
              setDraft(draftFromDefinition(current))
              setSubmitted(false)
            }}
          >
            {t('structure.designer.reset')}
          </Button>
        )}
        <Button variant="primary" onClick={preview} disabled={alter && ops.length === 0}>
          {t('structure.previewSql')}
        </Button>
      </footer>
    </>
  )
}

/**
 * Tab content for "designer": creates a table (no `table`) or alters one. Edits build a PreviewInput;
 * nothing runs before the preview dialog confirms it.
 */
export function TableDesigner({
  db,
  table,
  readOnly,
  onCreated,
}: {
  db: string
  table?: string
  readOnly?: boolean
  /** Called when a create plan has run and its dialog is closed. */
  onCreated?: (name: string) => void
}) {
  const queryClient = useQueryClient()
  const titleId = useId()
  const definition = useTableDefinition(db, table)
  const [request, setRequest] = useState<PreviewRequest | null>(null)

  const alter = table !== undefined
  const open = (input: PreviewInput) => setRequest((r) => ({ input, nonce: (r?.nonce ?? 0) + 1 }))

  return (
    <section aria-labelledby={titleId} className="flex min-h-0 flex-1 flex-col">
      {alter && definition.isPending ? (
        <div className="flex flex-col gap-3 px-6 pt-6" aria-hidden>
          <div className="h-7 w-48 rounded bg-active" />
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-8 rounded bg-active" />
          ))}
        </div>
      ) : alter && (definition.isError || !definition.data) ? (
        <div className="flex flex-col items-start gap-3 px-6 pt-6">
          <h1 id={titleId} className="text-[22px] leading-7 font-semibold">
            <span className="text-muted">{db}.</span>
            {table}
          </h1>
          <p className="text-sm text-muted">
            {definition.error instanceof Error ? definition.error.message : t('table.error')}
          </p>
          <Button onClick={() => void definition.refetch()}>{t('table.retry')}</Button>
        </div>
      ) : (
        <DesignerForm
          titleId={titleId}
          key={alter ? definition.dataUpdatedAt : 'create'}
          db={db}
          table={table}
          current={definition.data}
          readOnly={readOnly}
          onPreview={open}
        />
      )}
      <PreviewDialog
        request={request}
        readOnly={readOnly}
        onNewPreview={
          alter
            ? () => {
                void queryClient.invalidateQueries({ queryKey: keys.definition(db, table) })
                setRequest(null)
              }
            : undefined
        }
        onClose={(result) => {
          const input = request?.input
          setRequest(null)
          if (result?.ok && input?.action === 'createTable') onCreated?.(input.table.name)
        }}
      />
    </section>
  )
}
