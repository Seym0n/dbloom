import { useRef, useState } from 'react'
import { t, tDynamic } from '~/i18n'
import { Button } from '~/components/ui/button'
import { Select } from '~/components/ui/select'
import { authApi } from '~/lib/auth/api'
import { IMPORT_MAX_BYTES, importReasonKey } from '~/lib/auth/account-logic'
import { useAction } from '~/lib/auth/use-action'
import type { PrefImportResult } from '~/server/auth/types'
import { ErrorNote, FormField } from '../auth-frame'
import { Muted, Panel } from './account-ui'

/** Import of a preferences file (FR-AUT-025): merge or replace, the problems listed, and "import the valid ones only". */
export function ImportPanel({ onImported, announce }: { onImported: () => void; announce: (message: string) => void }) {
  const [json, setJson] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [mode, setMode] = useState<'merge' | 'replace'>('merge')
  const [result, setResult] = useState<PrefImportResult | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const action = useAction()
  const input = useRef<HTMLInputElement>(null)

  async function pick(file: File | undefined) {
    setResult(null)
    setFileError(null)
    action.clear()
    if (!file) {
      setJson(null)
      setFileName('')
      return
    }
    if (file.size > IMPORT_MAX_BYTES) {
      setJson(null)
      setFileName('')
      setFileError(t('account.import.reason.file_too_large'))
      return
    }
    setFileName(file.name)
    setJson(await file.text())
  }

  async function run(validOnly: boolean) {
    if (json === null) return
    const r = await action.run(() => authApi().importPrefs({ json, mode, ...(validOnly ? { validOnly: true } : {}) }))
    if (!r.ok) return
    setResult(r.value)
    if (r.value.written > 0) {
      onImported()
      announce(t('account.import.done', { written: r.value.written }))
    }
  }

  const fileProblem = result?.problems.some((p) => p.key === '')
  const canRetryValid = result !== null && result.written === 0 && result.problems.length > 0 && !fileProblem

  return (
    <Panel className="flex flex-col gap-4 py-3">
      <div>
        <h3 className="font-medium">{t('account.import.title')}</h3>
        <Muted>{t('account.import.lead')}</Muted>
      </div>
      <FormField label={t('account.import.file')} hint={fileName ? undefined : t('account.import.fileHint')} error={fileError}>
        {(field) => (
          <input
            {...field}
            ref={input}
            type="file"
            accept="application/json,.json"
            onChange={(e) => void pick(e.target.files?.[0])}
            className="text-sm file:mr-3 file:h-8 file:rounded-[var(--radius-control)] file:border file:border-control file:bg-surface file:px-3 file:text-sm file:text-ink"
          />
        )}
      </FormField>
      <FormField label={t('account.import.mode')}>
        {(field) => (
          <Select {...field} value={mode} onChange={(e) => setMode(e.target.value as 'merge' | 'replace')} className="max-w-md">
            <option value="merge">{t('account.import.merge')}</option>
            <option value="replace">{t('account.import.replace')}</option>
          </Select>
        )}
      </FormField>
      <ErrorNote message={action.error?.message} />
      <div>
        <Button variant="primary" size="lg" disabled={json === null || action.busy} onClick={() => void run(false)}>
          {action.busy ? t('account.import.running') : t('account.import.action')}
        </Button>
      </div>
      {result && (
        <div role="region" aria-label={t('account.import.resultLabel')} className="flex flex-col gap-3 rounded-[var(--radius-control)] bg-raised p-3">
          <p className="text-sm font-medium">{t('account.import.summary', { written: result.written, skipped: result.skipped })}</p>
          {result.problems.length > 0 && (
            <>
              <p className="text-sm text-muted">{t(canRetryValid ? 'account.import.problemsBlocked' : 'account.import.problems', { count: result.problems.length })}</p>
              <ul className="flex flex-col gap-1 text-sm">
                {result.problems.map((problem, i) => (
                  <li key={`${problem.key}-${problem.target ?? ''}-${i}`} className="break-words">
                    {problem.key !== '' && <code className="font-mono text-xs">{problem.target ? `${problem.target} / ${problem.key}` : problem.key}</code>}
                    {problem.key !== '' && ': '}
                    {tDynamic(importReasonKey(problem), 'account.import.reason.invalid_value')}
                  </li>
                ))}
              </ul>
              {canRetryValid && (
                <div>
                  <Button disabled={action.busy} onClick={() => void run(true)}>
                    {t('account.import.validOnly')}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Panel>
  )
}
