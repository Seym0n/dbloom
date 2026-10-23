import { useState, type FormEvent } from 'react'
import { login } from '~/server/session.functions'
import { setCsrfToken } from '~/lib/csrf'
import { t } from '~/i18n'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'

export type LoginDefaults = { server: string; username: string }

export function LoginForm({
  defaults,
  onSuccess,
}: {
  defaults?: LoginDefaults
  onSuccess: () => void | Promise<void>
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true)
    setError(null)
    try {
      const { csrf } = await login({
        data: {
          host: String(form.get('server') ?? ''),
          username: String(form.get('username') ?? ''),
          password: String(form.get('password') ?? ''),
        },
      })
      setCsrfToken(csrf)
      await onSuccess()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed.')
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-2">
        <label htmlFor="server" className="text-sm font-medium">
          {t('login.server')}
        </label>
        <Input
          id="server"
          name="server"
          defaultValue={defaults?.server}
          placeholder="db.internal:3306"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
          aria-describedby="server-hint"
        />
        <p id="server-hint" className="text-xs text-muted">
          {t('login.serverHint')}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="username" className="text-sm font-medium">
          {t('login.user')}
        </label>
        <Input
          id="username"
          name="username"
          defaultValue={defaults?.username}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="password" className="text-sm font-medium">
          {t('login.password')}
        </label>
        <Input id="password" name="password" type="password" autoComplete="current-password" />
      </div>
      {error && (
        <p role="alert" className="text-sm text-negative">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" size="lg" disabled={busy}>
        {busy ? t('login.submitting') : t('login.submit')}
      </Button>
    </form>
  )
}
