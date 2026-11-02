import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { t } from '~/i18n'
import { scorePassword } from '~/lib/auth/password-strength'
import { Input } from '~/components/ui/input'
import { cn } from '~/lib/utils'
import { FormField } from './auth-frame'

const BAR_COLOURS = ['bg-negative', 'bg-negative', 'bg-[var(--pill-warning-ink)]', 'bg-positive', 'bg-positive']

/**
 * Password input with a show/hide toggle and, for passwords being set, the strength meter (FR-UIX-080). The meter is
 * advisory text plus bars; the server's rules decide. Reused by wave 2 for vault passphrases (`minLength` = passphrase minimum).
 */
export function PasswordField({
  label,
  value,
  onChange,
  name,
  autoComplete,
  username,
  minLength,
  meter = false,
  hint,
  error,
  autoFocus,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  name?: string
  autoComplete: 'current-password' | 'new-password'
  username?: string
  /** With `meter`: the minimum length of the policy. */
  minLength?: number
  meter?: boolean
  hint?: string
  error?: string | null
  autoFocus?: boolean
}) {
  const [shown, setShown] = useState(false)
  const strength = meter && minLength ? scorePassword(value, { ...(username ? { username } : {}), minLength }) : null
  return (
    <FormField label={label} {...(hint ? { hint } : {})} {...(error ? { error } : {})}>
      {(field) => (
        <>
          <div className="relative">
            <Input
              {...field}
              name={name}
              type={shown ? 'text' : 'password'}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              autoComplete={autoComplete}
              autoCapitalize="none"
              spellCheck={false}
              autoFocus={autoFocus}
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShown((s) => !s)}
              aria-label={shown ? t('auth.password.hide') : t('auth.password.show')}
              aria-pressed={shown}
              className="press absolute right-1 top-1 inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)] text-muted hover:bg-active hover:text-ink"
            >
              {shown ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
            </button>
          </div>
          {strength && value.length > 0 && (
            <div className="flex flex-col gap-1" data-testid="strength">
              <div className="flex gap-1" aria-hidden>
                {[1, 2, 3, 4].map((n) => (
                  <span key={n} className={cn('h-1 flex-1 rounded-full bg-active', strength.score >= n && BAR_COLOURS[strength.score])} />
                ))}
              </div>
              <p className="text-xs text-muted" aria-live="polite">
                {t('auth.strength.label', { level: t(`auth.strength.${strength.level}`) })}
                {strength.tooShort ? ` ${t('auth.strength.minLength', { count: minLength ?? 0 })}` : ''}
                {strength.containsUsername ? ` ${t('auth.strength.username')}` : ''}
              </p>
            </div>
          )}
        </>
      )}
    </FormField>
  )
}
