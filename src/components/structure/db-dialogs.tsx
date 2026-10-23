import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Dialog } from '~/components/ui/dialog'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Select } from '~/components/ui/select'
import { getTables } from '~/server/browse.functions'
import { previewInput, type ExecuteResult, type PreviewInput } from '~/server/structure/types'
import { t } from '~/i18n'
import { Field } from './field'
import { keys } from './invalidate'
import { nameError } from './model'
import { PreviewDialog, type PreviewRequest } from './preview-dialog'
import { useStructureLists } from './use-structure'

type TableRef = { db: string; table: string; view?: boolean }

export type StructureAction =
  | { type: 'createDatabase' }
  | { type: 'dropDatabase'; db: string }
  | ({ type: 'dropTable' } & TableRef)
  | ({ type: 'truncateTable' } & TableRef)
  | ({ type: 'renameTable' } & TableRef)

const number = new Intl.NumberFormat('en-US')

function FormFrame({
  title,
  titleId,
  children,
  footer,
  onSubmit,
}: {
  title: string
  titleId: string
  children: ReactNode
  footer: ReactNode
  onSubmit: (e: FormEvent) => void
}) {
  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col">
      <div className="flex flex-col gap-4 px-6 pt-5 pb-5">
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        {children}
      </div>
      <div className="flex justify-end gap-2 bg-raised px-6 py-3">{footer}</div>
    </form>
  )
}

function CreateDatabaseForm({
  titleId,
  onPreview,
  onCancel,
}: FormProps & { onPreview: (i: PreviewInput) => void }) {
  const lists = useStructureLists()
  const [name, setName] = useState('')
  const [charset, setCharset] = useState('')
  const [collation, setCollation] = useState('')
  const [touched, setTouched] = useState(false)

  const nameKey = nameError(name)
  const collations = (lists.data?.collations ?? []).filter((c) => c.charset === charset)

  function submit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (nameKey) return
    const input: PreviewInput = {
      action: 'createDatabase',
      name,
      ...(charset ? { charset } : {}),
      ...(collation ? { collation } : {}),
    }
    if (!previewInput.safeParse(input).success) return
    onPreview(input)
  }

  return (
    <FormFrame
      title={t('structure.db.create.title')}
      titleId={titleId}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onCancel}>{t('structure.cancel')}</Button>
          <Button type="submit" variant="primary">
            {t('structure.previewSql')}
          </Button>
        </>
      }
    >
      <Field
        label={t('structure.db.name')}
        error={touched && nameKey ? t(nameKey, { max: 64 }) : undefined}
      >
        {(p) => (
          <Input
            {...p}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </Field>
      <Field
        label={t('structure.options.charset')}
        hint={lists.isError ? t('structure.lists.error') : undefined}
      >
        {(p) => (
          <Select
            {...p}
            value={charset}
            onChange={(e) => {
              setCharset(e.target.value)
              setCollation('')
            }}
          >
            <option value="">{t('structure.serverDefault')}</option>
            {(lists.data?.charsets ?? []).map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('structure.options.collation')}>
        {(p) => (
          <Select
            {...p}
            value={collation}
            onChange={(e) => setCollation(e.target.value)}
            disabled={charset === ''}
          >
            <option value="">{t('structure.serverDefault')}</option>
            {collations.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </FormFrame>
  )
}

type FormProps = { titleId: string; onCancel: () => void }

function ObjectForm({
  action,
  titleId,
  onPreview,
  onCancel,
}: FormProps & {
  action: Exclude<StructureAction, { type: 'createDatabase' | 'renameTable' }>
  onPreview: (i: PreviewInput) => void
}) {
  const fkId = useId()
  const [ignoreFk, setIgnoreFk] = useState(false)
  const db = action.db
  const tables = useQuery({
    queryKey: keys.tables(db),
    queryFn: () => getTables({ data: { db } }),
    enabled: action.type !== 'dropDatabase',
  })
  const table = action.type === 'dropDatabase' ? undefined : action.table
  const rows = tables.data?.find((x) => x.name === table)?.estimatedRows
  const isView = action.type !== 'dropDatabase' && action.view

  const copy =
    action.type === 'dropDatabase'
      ? { title: t('structure.drop.db.title', { name: db }), body: t('structure.drop.db.body') }
      : action.type === 'dropTable'
        ? {
            title: t(isView ? 'structure.drop.view.title' : 'structure.drop.table.title', {
              name: `${db}.${table}`,
            }),
            body: t(isView ? 'structure.drop.view.body' : 'structure.drop.table.body'),
          }
        : {
            title: t('structure.truncate.title', { name: `${db}.${table}` }),
            body: t('structure.truncate.body'),
          }

  function submit(e: FormEvent) {
    e.preventDefault()
    if (action.type === 'dropDatabase') onPreview({ action: 'dropDatabase', name: db })
    else if (action.type === 'dropTable') {
      onPreview({
        action: 'dropTable',
        db,
        table: action.table,
        ...(isView ? { view: true } : {}),
        ...(ignoreFk && !isView ? { ignoreForeignKeys: true } : {}),
      })
    } else {
      onPreview({
        action: 'truncateTable',
        db,
        table: action.table,
        ...(ignoreFk ? { ignoreForeignKeys: true } : {}),
      })
    }
  }

  return (
    <FormFrame
      title={copy.title}
      titleId={titleId}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onCancel}>{t('structure.cancel')}</Button>
          <Button type="submit" variant="primary">
            {t('structure.previewSql')}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted">{copy.body}</p>
      {rows != null && <p className="text-sm">{t('table.rows', { count: number.format(rows) })}</p>}
      {action.type !== 'dropDatabase' && !isView && (
        <div className="flex items-start gap-2">
          <Checkbox id={fkId} checked={ignoreFk} onChange={(e) => setIgnoreFk(e.target.checked)} />
          <Label htmlFor={fkId} className="font-normal">
            {t('structure.fkChecks.ignore')}
          </Label>
        </div>
      )}
    </FormFrame>
  )
}

function RenameForm({
  action,
  titleId,
  onPreview,
  onCancel,
}: FormProps & {
  action: Extract<StructureAction, { type: 'renameTable' }>
  onPreview: (i: PreviewInput) => void
}) {
  const [name, setName] = useState(action.table)
  const [touched, setTouched] = useState(false)
  const key = nameError(name) ?? (name === action.table ? 'structure.err.sameName' : null)

  function submit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (key) return
    onPreview({ action: 'renameTable', db: action.db, table: action.table, newName: name })
  }

  return (
    <FormFrame
      title={t('structure.rename.title', { name: `${action.db}.${action.table}` })}
      titleId={titleId}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onCancel}>{t('structure.cancel')}</Button>
          <Button type="submit" variant="primary">
            {t('structure.previewSql')}
          </Button>
        </>
      }
    >
      <Field
        label={t('structure.rename.newName')}
        error={touched && key ? t(key, { max: 64 }) : undefined}
      >
        {(p) => (
          <Input
            {...p}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </Field>
    </FormFrame>
  )
}

/**
 * The small dialogs of the sidebar: create database, drop database, rename, truncate and drop table.
 * Each collects its options, then hands one PreviewInput to the shared PreviewDialog.
 */
export function StructureDialogs({
  action,
  readOnly,
  onClose,
  onApplied,
  onOpenDatabase,
}: {
  action: StructureAction | null
  readOnly?: boolean
  onClose: () => void
  onApplied?: (input: PreviewInput, result: ExecuteResult) => void
  onOpenDatabase?: (name: string) => void
}) {
  const titleId = useId()
  const [request, setRequest] = useState<PreviewRequest | null>(null)
  const [nonce, setNonce] = useState(0)

  const preview = (input: PreviewInput) => {
    setNonce((n) => n + 1)
    setRequest({ input, nonce: nonce + 1 })
  }

  return (
    <>
      <Dialog open={action !== null} onClose={onClose} labelledBy={titleId}>
        {action?.type === 'createDatabase' && (
          <CreateDatabaseForm titleId={titleId} onPreview={preview} onCancel={onClose} />
        )}
        {action?.type === 'renameTable' && (
          <RenameForm action={action} titleId={titleId} onPreview={preview} onCancel={onClose} />
        )}
        {(action?.type === 'dropDatabase' ||
          action?.type === 'dropTable' ||
          action?.type === 'truncateTable') && (
          <ObjectForm action={action} titleId={titleId} onPreview={preview} onCancel={onClose} />
        )}
      </Dialog>
      <PreviewDialog
        request={request}
        readOnly={readOnly}
        onApplied={onApplied}
        onClose={(result) => {
          setRequest(null)
          if (result?.ok) onClose()
        }}
        successAction={
          request?.input.action === 'createDatabase' && onOpenDatabase
            ? {
                label: t('structure.db.open'),
                onClick: () => onOpenDatabase((request.input as { name: string }).name),
              }
            : undefined
        }
      />
    </>
  )
}
