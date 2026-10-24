/**
 * The editing side of the grid hook contract (`grid-hooks.ts`, SPEC 24 task 12): one hook builds the
 * `RowsGridHooks` the grid takes (toolbar, row actions, in-cell editor, cell dialog, Delete key, foreign key
 * links) and the dialogs those hooks open. The grid stays unaware of forms; this file stays unaware of
 * grid state beyond the snapshot and controls it is handed.
 *
 *   const editing = useRowEditing({ db, table })
 *   <RowsGrid ... hooks={editing.hooks} />{editing.dialogs}
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Copy, Link2, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import {
  MAX_BULK_ROWS,
  type Cell,
  type FkInfo,
  type GetRowsResponse,
  type GuardValue,
  type ReferencingGroup,
  type RowChange,
} from '~/server/rows/types'
import { CellDialog, InlineCellEditor, canEditCell } from './cell-dialog'
import { ErrorDialog, useRowChanger, type DoneResponse, type Failure } from './delete-dialog'
import { rowKeyOf, snapshotGuards } from './form-core'
import type { CellContext, GridControls, GridSnapshot, RowsGridHooks } from './grid-hooks'
import { ReferencingRowsDialog } from './referencing-rows'
import { RowForm, type BulkSelection } from './row-form'
import { formsApi } from './server-api-forms'

export type RowEditingOptions = {
  db: string
  table: string
  /** User preferences: skip the confirmation of soft plans (ST-120), blank rows of the insert form. */
  acceptSoft?: boolean
  insertRows?: number
  uploadBytes?: number
  locale?: string
  /** Real link to the referenced rows of a foreign key value; names are encoded once by the caller. */
  fkHref?: (fk: FkInfo, values: Record<string, string>) => string | undefined
  /** Real link to the rows of a referencing group; plain click calls `onOpenGroup` if given. */
  groupHref?: (group: ReferencingGroup, values: Record<string, string>) => string
  onOpenGroup?: (group: ReferencingGroup, values: Record<string, string>) => void
  /** A write was applied: the grid has been refreshed already; use it for toasts or counters. */
  onChanged?: (response: DoneResponse) => void
}

type Request =
  | { kind: 'insert'; snapshot: GridSnapshot }
  | {
      kind: 'copy' | 'edit'
      snapshot: GridSnapshot
      rowIndex: number
      key: Record<string, GuardValue>
    }
  | { kind: 'bulk'; snapshot: GridSnapshot; bulk: BulkSelection }
  | {
      kind: 'delete'
      snapshot: GridSnapshot
      rows: { key: Record<string, GuardValue>; cells: Cell[] }[]
    }
  | { kind: 'cell'; ctx: CellContext }
  | {
      kind: 'referencing'
      snapshot: GridSnapshot
      key: Record<string, GuardValue>
      values: Record<string, string>
    }
  | {
      kind: 'insert-other'
      group: ReferencingGroup
      model: GetRowsResponse['table']
      permissions: GetRowsResponse['permissions']
      presets: Record<string, string | null>
      controls: GridControls
    }

const cellString = (cell: Cell | undefined): string | null => {
  if (cell === undefined || cell === null) return null
  if (typeof cell === 'string') return cell
  if ('binary' in cell) return cell.size <= 32 ? `0x${cell.binary}` : null
  return null
}

function whyOff(response: GetRowsResponse | undefined, needsIdentity: boolean): string | null {
  if (!response) return t('rows.form.edit.off.loading')
  const p = response.permissions
  if (p.readOnly) return t('rows.form.edit.off.readOnly')
  if (response.table.kind === 'view') return t('rows.form.edit.off.view')
  if (needsIdentity && response.identity.kind === 'none') return t('rows.form.edit.off.noIdentity')
  return null
}

export function useRowEditing(options: RowEditingOptions): {
  hooks: RowsGridHooks
  dialogs: ReactNode
} {
  const opts = useRef(options)
  opts.current = options
  const [request, setRequest] = useState<Request | null>(null)
  const [dirty, setDirty] = useState(false)
  const close = useCallback(() => setRequest(null), [])

  const afterChange = useCallback((controls: GridControls, response: DoneResponse) => {
    controls.refresh()
    controls.showStatement(response.statements.map((s) => s.preview).join(';\n'))
    opts.current.onChanged?.(response)
  }, [])

  const hooks: RowsGridHooks = useMemo(() => {
    const keyOfRow = (snapshot: GridSnapshot, row: Cell[]) =>
      snapshot.response
        ? rowKeyOf(
            snapshot.response.identity,
            snapshot.response.table,
            snapshot.response.columns,
            row,
          )
        : null

    return {
      dirty,
      canEditCell,
      renderEditor: (ctx) => (
        <InlineCellEditor
          ctx={ctx}
          locale={opts.current.locale}
          acceptSoft={opts.current.acceptSoft}
          uploadBytes={opts.current.uploadBytes}
        />
      ),
      onOpenCell: (ctx) => setRequest({ kind: 'cell', ctx }),
      onDeleteKey: (snapshot) => {
        if (whyOff(snapshot.response, true) || !snapshot.response?.permissions.delete) return
        if (snapshot.selectedKeys.length === 0) return
        setRequest({ kind: 'delete', snapshot, rows: selectedRows(snapshot) })
      },
      decorateCell: (ctx, content) => {
        const href = opts.current.fkHref
        if (!href || ctx.cell === null) return content
        const fk = ctx.table.outgoing.find((f) => f.columns.includes(ctx.columnName))
        if (!fk) return content
        const values: Record<string, string> = {}
        for (let i = 0; i < fk.columns.length; i += 1) {
          const index = ctx.columns.indexOf(fk.columns[i] ?? '')
          const value = cellString(ctx.row[index])
          const ref = fk.refColumns[i]
          if (value === null || ref === undefined) return content
          values[ref] = value
        }
        const target = href(fk, values)
        if (!target) return content
        return (
          <a
            href={target}
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-2 hover:underline"
          >
            {content}
          </a>
        )
      },
      toolbar: (snapshot) => {
        const response = snapshot.response
        const insertOff =
          whyOff(response, false) ??
          (response && !response.permissions.insert ? t('rows.form.edit.off.privilege') : null)
        const selected = snapshot.selectedKeys.length
        const deleteOff =
          whyOff(response, true) ??
          (response && !response.permissions.delete ? t('rows.form.edit.off.privilege') : null) ??
          (selected === 0 ? t('rows.form.edit.off.noSelection') : null) ??
          (selected > MAX_BULK_ROWS ? t('rows.form.bulkLimit', { max: MAX_BULK_ROWS }) : null)
        const editOff =
          whyOff(response, true) ??
          (response && !response.permissions.update ? t('rows.form.edit.off.privilege') : null) ??
          (selected === 0 ? t('rows.form.edit.off.noSelection') : null) ??
          (selected > MAX_BULK_ROWS ? t('rows.form.bulkLimit', { max: MAX_BULK_ROWS }) : null)
        return (
          <>
            <ToolbarButton
              reason={insertOff}
              icon={<Plus size={14} aria-hidden />}
              label={t('rows.form.edit.insert')}
              onClick={() => setRequest({ kind: 'insert', snapshot })}
            />
            <ToolbarButton
              reason={editOff}
              icon={<Pencil size={14} aria-hidden />}
              label={t('rows.form.edit.editSelected', { count: selected })}
              onClick={() =>
                setRequest({
                  kind: 'bulk',
                  snapshot,
                  bulk: {
                    columns: snapshot.response?.columns ?? [],
                    rows: selectedRows(snapshot),
                  },
                })
              }
            />
            <ToolbarButton
              reason={deleteOff}
              icon={<Trash2 size={14} aria-hidden />}
              label={t('rows.form.edit.deleteSelected', { count: selected })}
              danger
              onClick={() => setRequest({ kind: 'delete', snapshot, rows: selectedRows(snapshot) })}
            />
          </>
        )
      },
      rowActions: ({ rowIndex, row, snapshot }) => {
        const response = snapshot.response
        const key = keyOfRow(snapshot, row)
        const needsKey = !key ? t('rows.form.edit.off.noKey') : null
        const base = whyOff(response, true) ?? needsKey
        const incoming = (response?.table.incoming.length ?? 0) > 0
        return (
          <span className="inline-flex items-center gap-0.5">
            <IconButton
              reason={
                base ??
                (response && !response.permissions.update
                  ? t('rows.form.edit.off.privilege')
                  : null)
              }
              label={t('rows.form.edit.editRow')}
              icon={<Pencil size={14} aria-hidden />}
              onClick={() => key && setRequest({ kind: 'edit', snapshot, rowIndex, key })}
            />
            <IconButton
              reason={
                base ??
                (response && !response.permissions.insert
                  ? t('rows.form.edit.off.privilege')
                  : null)
              }
              label={t('rows.form.edit.copyRow')}
              icon={<Copy size={14} aria-hidden />}
              onClick={() => key && setRequest({ kind: 'copy', snapshot, rowIndex, key })}
            />
            <IconButton
              reason={
                base ??
                (response && !response.permissions.delete
                  ? t('rows.form.edit.off.privilege')
                  : null)
              }
              label={t('rows.form.edit.deleteRow')}
              icon={<Trash2 size={14} aria-hidden />}
              onClick={() =>
                key && setRequest({ kind: 'delete', snapshot, rows: [{ key, cells: row }] })
              }
            />
            {incoming && (
              <IconButton
                reason={needsKey}
                label={t('rows.form.edit.referencing')}
                icon={<Link2 size={14} aria-hidden />}
                onClick={() => {
                  if (!key || !response) return
                  const values: Record<string, string> = {}
                  response.columns.forEach((name, i) => {
                    const v = cellString(row[i])
                    if (v !== null) values[name] = v
                  })
                  setRequest({ kind: 'referencing', snapshot, key, values })
                }}
              />
            )}
          </span>
        )
      },
    }
  }, [dirty])

  const dialogs = (
    <EditingDialogs
      request={request}
      options={options}
      onClose={close}
      onDirty={setDirty}
      afterChange={afterChange}
      setRequest={setRequest}
    />
  )
  return { hooks, dialogs }
}

function selectedRows(snapshot: GridSnapshot) {
  const response = snapshot.response
  if (!response) return []
  const out: { key: Record<string, GuardValue>; cells: Cell[] }[] = []
  snapshot.selectedIndexes.forEach((index) => {
    const cells = response.rows[index]
    if (!cells) return
    const key = rowKeyOf(response.identity, response.table, response.columns, cells)
    if (key) out.push({ key, cells })
  })
  return out
}

// ---- Buttons --------------------------------------------------------------------------------------------------------------------

function ToolbarButton({
  reason,
  icon,
  label,
  danger,
  onClick,
}: {
  reason: string | null
  icon: ReactNode
  label: string
  danger?: boolean
  onClick: () => void
}) {
  return (
    <Button
      disabled={reason !== null}
      title={reason ?? undefined}
      aria-label={reason ? `${label} — ${reason}` : label}
      className={danger && reason === null ? 'text-negative' : undefined}
      onClick={onClick}
    >
      {icon}
      <span className="hidden lg:inline">{label}</span>
    </Button>
  )
}

function IconButton({
  reason,
  icon,
  label,
  onClick,
}: {
  reason: string | null
  icon: ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      disabled={reason !== null}
      title={reason ?? label}
      aria-label={reason ? `${label} — ${reason}` : label}
      onClick={onClick}
    >
      {icon}
    </Button>
  )
}

// ---- Dialogs --------------------------------------------------------------------------------------------------------------------

function EditingDialogs({
  request,
  options,
  onClose,
  onDirty,
  afterChange,
  setRequest,
}: {
  request: Request | null
  options: RowEditingOptions
  onClose: () => void
  onDirty: (dirty: boolean) => void
  afterChange: (controls: GridControls, response: DoneResponse) => void
  setRequest: (request: Request | null) => void
}) {
  if (!request) return null
  const common = {
    locale: options.locale,
    uploadBytes: options.uploadBytes,
    acceptSoft: options.acceptSoft,
    onDirtyChange: onDirty,
    onClose,
  }

  if (request.kind === 'insert') {
    const r = request.snapshot.response
    if (!r) return null
    return (
      <RowForm
        {...common}
        open
        db={options.db}
        model={r.table}
        mode="insert"
        permissions={r.permissions}
        timeZone={r.timeZone}
        insertRows={options.insertRows}
        onChanged={(response) => afterChange(request.snapshot.controls, response)}
      />
    )
  }

  if (request.kind === 'insert-other') {
    return (
      <RowForm
        {...common}
        open
        db={request.group.db}
        model={request.model}
        mode="insert"
        permissions={request.permissions}
        presets={request.presets}
        onChanged={(response) => afterChange(request.controls, response)}
      />
    )
  }

  if (request.kind === 'copy' || request.kind === 'edit') {
    const r = request.snapshot.response
    if (!r) return null
    const { rowIndex, snapshot } = request
    const neighbour = (index: number) => {
      const cells = r.rows[index]
      const key = cells ? rowKeyOf(r.identity, r.table, r.columns, cells) : null
      return key ? () => setRequest({ kind: 'edit', snapshot, rowIndex: index, key }) : undefined
    }
    return (
      <RowForm
        {...common}
        open
        key={`${request.kind}-${rowIndex}`}
        db={options.db}
        model={r.table}
        mode={request.kind}
        permissions={r.permissions}
        timeZone={r.timeZone}
        rowKey={request.key}
        neighbours={
          request.kind === 'edit'
            ? { previous: neighbour(rowIndex - 1), next: neighbour(rowIndex + 1) }
            : undefined
        }
        onChanged={(response) => afterChange(snapshot.controls, response)}
      />
    )
  }

  if (request.kind === 'bulk') {
    const r = request.snapshot.response
    if (!r) return null
    return (
      <RowForm
        {...common}
        open
        db={options.db}
        model={r.table}
        mode="bulk-edit"
        permissions={r.permissions}
        timeZone={r.timeZone}
        bulk={request.bulk}
        onChanged={(response) => {
          request.snapshot.controls.clearSelection()
          afterChange(request.snapshot.controls, response)
        }}
      />
    )
  }

  if (request.kind === 'delete') {
    return (
      <DeleteRunner
        request={request}
        options={options}
        onClose={onClose}
        afterChange={afterChange}
      />
    )
  }

  if (request.kind === 'cell') {
    const ctx = request.ctx
    if (!ctx.column) return null
    return (
      <CellDialog
        open
        onClose={onClose}
        db={options.db}
        model={ctx.table}
        column={ctx.column}
        cell={ctx.cell}
        rowKey={ctx.key}
        identity={ctx.identity}
        permissions={ctx.permissions}
        timeZone={ctx.timeZone}
        locale={options.locale}
        uploadBytes={options.uploadBytes}
        acceptSoft={options.acceptSoft}
        onChanged={() => undefined}
      />
    )
  }

  if (request.kind !== 'referencing') return null
  const r = request.snapshot.response
  return (
    <ReferencingRowsDialog
      open
      onClose={onClose}
      db={options.db}
      table={options.table}
      rowKey={request.key}
      canInsert={Boolean(r?.permissions.insert) && !r?.permissions.readOnly}
      hrefFor={
        options.groupHref ? (group) => options.groupHref?.(group, request.values) ?? '#' : undefined
      }
      onOpen={
        options.onOpenGroup ? (group) => options.onOpenGroup?.(group, request.values) : undefined
      }
      onInsert={(group) => {
        void openInsertOther(group, request, setRequest)
      }}
    />
  )
}

/** "Insert row" of a referencing group: the insert form of that table with the foreign key preset. */
async function openInsertOther(
  group: ReferencingGroup,
  request: Extract<Request, { kind: 'referencing' }>,
  setRequest: (request: Request | null) => void,
) {
  const fk = request.snapshot.response?.table.incoming.find((f) => f.name === group.fk)
  const r = await formsApi().getRows({
    db: group.db,
    table: group.table,
    page: 0,
    pageSize: 1,
    sort: [],
  })
  const presets: Record<string, string | null> = {}
  const columns = fk?.columns ?? group.columns
  const refColumns = fk?.refColumns ?? []
  columns.forEach((column, i) => {
    const source = refColumns[i]
    presets[column] = source ? (request.values[source] ?? null) : null
  })
  setRequest({
    kind: 'insert-other',
    group,
    model: r.table,
    permissions: r.permissions,
    presets,
    controls: request.snapshot.controls,
  })
}

/** Delete of one or many rows: the server's plan is the preview and the confirmation (FR-ROW-019, 020). */
function DeleteRunner({
  request,
  options,
  onClose,
  afterChange,
}: {
  request: Extract<Request, { kind: 'delete' }>
  options: RowEditingOptions
  onClose: () => void
  afterChange: (controls: GridControls, response: DoneResponse) => void
}) {
  const response = request.snapshot.response
  const [failure, setFailure] = useState<Failure | null>(null)
  const started = useRef(false)
  const changer = useRowChanger({
    db: options.db,
    table: options.table,
    model: response?.table ?? null,
    acceptSoft: options.acceptSoft,
    onDone: (done) => {
      request.snapshot.controls.clearSelection()
      afterChange(request.snapshot.controls, done)
      onClose()
    },
    onSettled: () => onClose(),
  })

  useEffect(() => {
    if (started.current || !response) return
    started.current = true
    if (request.rows.length === 0) {
      setFailure({ message: t('rows.form.edit.nothingToDelete') })
      return
    }
    if (request.rows.length > MAX_BULK_ROWS) {
      setFailure({ message: t('rows.form.bulkLimit', { max: MAX_BULK_ROWS }) })
      return
    }
    const change: RowChange = {
      op: 'delete',
      targets: request.rows.map((row) => ({
        key: row.key,
        old: snapshotGuards(response.table, response.columns, row.cells),
      })),
    }
    void changer.submit(change)
    // Started once per request.
  }, [])

  return (
    <>
      <span className="sr-only" role="status">
        {changer.busy ? t('rows.dialog.working') : ''}
      </span>
      {changer.dialogs}
      <ErrorDialog failure={failure} onClose={onClose} />
    </>
  )
}
