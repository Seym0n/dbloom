import type { ReactNode } from 'react'
import { useRouter } from '@tanstack/react-router'
import { t } from '~/i18n'
import { authApi, type AccountSessionView } from '~/lib/auth/api'
import { setStoredConnectionId } from '~/lib/auth/connections-logic'
import { setCsrfToken } from '~/lib/csrf'
import { AuthFrame, AuthHeading } from './auth-frame'
import { ChangePasswordDialog } from './change-password-dialog'
import { EnrolOnly } from './enrol-only'
import { MfaStep } from './mfa-step'

/** Signs out of whatever half-signed-in session exists and re-reads the front page. */
export function useAccountSignOut() {
  const router = useRouter()
  return async () => {
    await authApi().signOut().catch(() => undefined)
    setCsrfToken(undefined)
    // The tab's connection id means nothing after sign-out; do not leave it in session storage.
    setStoredConnectionId(null)
    await router.invalidate()
  }
}

/**
 * Routing guard by session state (SPEC/26 5.5): `pending_mfa` shows the second factor, `enrol_only` the enrolment,
 * `must_change` the forced password change; only `full` renders `children`.
 */
export function AccountGate({ session, children }: { session: AccountSessionView; children: ReactNode }) {
  const router = useRouter()
  const refresh = () => router.invalidate()
  const signOut = useAccountSignOut()

  switch (session.state) {
    case 'pending_mfa':
      return <MfaStep onSignedIn={refresh} onRestart={refresh} />
    case 'enrol_only':
      return <EnrolOnly onEnrolled={refresh} onSignOut={signOut} />
    case 'must_change':
      return (
        <AuthFrame>
          <AuthHeading title={t('auth.change.pageTitle')} lead={t('auth.change.pageLead')} />
          <ChangePasswordDialog
            open
            required
            {...(session.user ? { username: session.user.username } : {})}
            onClose={() => undefined}
            onChanged={refresh}
            onSignOut={signOut}
          />
        </AuthFrame>
      )
    case 'full':
      return <>{children}</>
  }
}
