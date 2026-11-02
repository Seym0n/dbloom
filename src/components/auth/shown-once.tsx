import { useState } from 'react'
import { Check, Copy, Download } from 'lucide-react'
import { t } from '~/i18n'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { copyText, downloadText } from '~/lib/auth/clipboard'

/**
 * A secret shown exactly once (recovery codes, vault recovery key, invite link): the lines, copy, optional download
 * and an explicit "I saved them" the caller reads through `onSavedChange` before it lets the dialog or step close.
 * Wave 2 reuses it for the vault recovery key (`fileName` = VAULT_RECOVERY_KEY_FILE_NAME) and invite links (no `fileName`).
 */
export function ShownOnce({
  lines,
  fileName,
  columns = 2,
  confirmLabel,
  saved,
  onSavedChange,
  label,
}: {
  lines: string[]
  /** Offers a download of the lines as a text file. */
  fileName?: string
  columns?: 1 | 2
  confirmLabel?: string
  saved: boolean
  onSavedChange: (saved: boolean) => void
  /** Accessible name of the list. */
  label: string
}) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex flex-col gap-4">
      <ul
        aria-label={label}
        className={`grid gap-x-6 gap-y-1 rounded-[var(--radius-card)] border border-border bg-raised p-4 font-mono text-sm ${columns === 2 ? 'grid-cols-1 min-[420px]:grid-cols-2' : 'grid-cols-1'}`}
      >
        {lines.map((line) => (
          <li key={line} className="break-all">
            {line}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={async () => {
            if (await copyText(lines.join('\n'))) {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 2000)
            }
          }}
        >
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          {copied ? t('auth.shown.copied') : t('auth.shown.copy')}
        </Button>
        {fileName && (
          <Button onClick={() => downloadText(fileName, `${lines.join('\n')}\n`)}>
            <Download size={14} aria-hidden />
            {t('auth.shown.download')}
          </Button>
        )}
      </div>
      <label className="flex items-start gap-3 text-sm">
        <Checkbox checked={saved} onChange={(e) => onSavedChange(e.target.checked)} className="mt-0.5" />
        <span>{confirmLabel ?? t('auth.shown.saved')}</span>
      </label>
    </div>
  )
}
