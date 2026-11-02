import { useEffect, useRef, useState, type FormEvent } from 'react'
import { t } from '~/i18n'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import type { TotpStart } from '~/lib/auth/api'
import { copyText } from '~/lib/auth/clipboard'
import { useAction } from '~/lib/auth/use-action'
import { ErrorNote, FormField } from './auth-frame'

const svgSource = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

/**
 * Authenticator-app enrolment: QR code and text secret, then one valid code. Used by the setup wizard, the enrol-only
 * gate and (wave 2) account security; the caller passes the matching start and confirm calls.
 */
export function TotpEnrol({
  start,
  confirm,
  onDone,
  onCancel,
}: {
  start: () => Promise<TotpStart>
  confirm: (code: string) => Promise<{ recoveryCodes?: string[] }>
  onDone: (recoveryCodes?: string[]) => void
  onCancel?: () => void
}) {
  const [secret, setSecret] = useState<TotpStart | null>(null)
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState(false)
  const loader = useAction()
  const verify = useAction()
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    void loader.run(start).then((r) => r.ok && setSecret(r.value))
  }, [loader, start])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const r = await verify.run(() => confirm(code))
    if (r.ok) onDone(r.value.recoveryCodes)
    else setCode('')
  }

  if (!secret) {
    return loader.error ? <ErrorNote message={loader.error.message} /> : <p className="text-sm text-muted">{t('auth.totp.loading')}</p>
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <p className="text-sm text-muted">{t('auth.totp.lead')}</p>
      <div className="flex flex-col items-start gap-4 min-[480px]:flex-row">
        <img
          src={svgSource(secret.qrSvg)}
          alt={t('auth.totp.qrAlt')}
          width={160}
          height={160}
          className="h-40 w-40 shrink-0 rounded-[var(--radius-card)] border border-border bg-white p-2"
        />
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-xs text-muted">{t('auth.totp.manual')}</p>
          <code data-testid="totp-secret" className="break-all rounded-[var(--radius-control)] bg-raised px-2 py-1 font-mono text-sm">
            {secret.secret}
          </code>
          <Button
            className="self-start"
            onClick={async () => {
              if (await copyText(secret.secret.replace(/\s/g, ''))) {
                setCopied(true)
                window.setTimeout(() => setCopied(false), 2000)
              }
            }}
          >
            {copied ? t('auth.shown.copied') : t('auth.totp.copySecret')}
          </Button>
        </div>
      </div>
      <FormField label={t('auth.totp.code')} hint={t('auth.totp.codeHint')}>
        {(field) => (
          <Input
            {...field}
            name="totp"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            required
            className="max-w-40 font-mono tracking-widest"
          />
        )}
      </FormField>
      <ErrorNote message={verify.error?.message} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" size="lg" disabled={verify.busy || code.replace(/\s/g, '').length < 6}>
          {verify.busy ? t('auth.totp.verifying') : t('auth.totp.verify')}
        </Button>
        {onCancel && (
          <Button size="lg" onClick={onCancel}>
            {t('auth.cancel')}
          </Button>
        )}
      </div>
    </form>
  )
}
