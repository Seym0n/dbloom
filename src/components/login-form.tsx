import { useEffect, useState, type FormEvent } from 'react'
import { login } from '~/server/session.functions'
import { setCsrfToken } from '~/lib/csrf'
import { preselected, readRecall, saveRecall, type Recall } from '~/lib/recall'
import { t } from '~/i18n'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'

export type LoginDefaults = { server: string; username: string }

/**
 * Direct-mode sign-in. `targets` are the named servers of the operator, offered as suggestions (the server still checks
 * every name against its own list). With `recall` on (ST-074) the last server and user name of this browser are filled in
 * and saved after a successful sign-in; the password is never kept.
 */
export function LoginForm({
  defaults,
  targets,
  recall = false,
  onSuccess,
}: {
  defaults?: LoginDefaults
  targets?: string[]
  recall?: boolean
  onSuccess: () => void | Promise<void>
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [remembered, setRemembered] = useState<Recall | null>(null)

  // Local storage exists only in the browser: read it after the first render, so the server render stays the same.
  useEffect(() => {
    if (!recall) return
    setRemembered(preselected(readRecall(window.localStorage), targets))
  }, [recall, targets])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true)
    setError(null)
    try {
      const server = String(form.get('server') ?? '')
      const username = String(form.get('username') ?? '')
      const { csrf } = await login({
        data: {
          host: server,
          username,
          password: String(form.get('password') ?? ''),
        },
      })
      setCsrfToken(csrf)
      if (recall) saveRecall(window.localStorage, { server: server.trim(), username: username.trim() })
      await onSuccess()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed.')
      setBusy(false)
    }
  }

  const server = defaults?.server ?? remembered?.server
  const username = defaults?.username ?? remembered?.username

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-2">
        <label htmlFor="server" className="text-sm font-medium">
          {t('login.server')}
        </label>
        <Input
          key={`server-${server ?? ''}`}
          id="server"
          name="server"
          defaultValue={server}
          list={targets && targets.length > 0 ? 'server-targets' : undefined}
          placeholder="db.internal:3306"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
          aria-describedby="server-hint"
        />
        {targets && targets.length > 0 && (
          <datalist id="server-targets">
            {targets.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        )}
        <p id="server-hint" className="text-xs text-muted">
          {t('login.serverHint')}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="username" className="text-sm font-medium">
          {t('login.user')}
        </label>
        <Input
          key={`user-${username ?? ''}`}
          id="username"
          name="username"
          defaultValue={username}
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
