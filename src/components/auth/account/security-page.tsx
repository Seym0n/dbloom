import { useState } from 'react'
import { t } from '~/i18n'
import { Button } from '~/components/ui/button'
import type { AccountSessionView } from '~/lib/auth/api'
import { ChangePasswordDialog } from '../change-password-dialog'
import { Muted, Panel, Row, Section } from './account-ui'
import { ActivitySection } from './activity-section'
import { FactorsSection } from './factors-section'
import { NoticesSection, SessionsSection } from './sessions-section'
import { StepUpProvider } from './step-up'

/** Account security (FR-AUT-005, 009 to 013, 017): password, second factors, recovery codes, sessions, notices. */
export function SecurityPage({ session }: { session: AccountSessionView }) {
  const [changing, setChanging] = useState(false)
  const [message, setMessage] = useState('')

  return (
    <StepUpProvider>
      <div className="flex flex-col gap-8">
        <div>
          <h1 className="text-[22px] font-semibold leading-7">{t('account.security.title')}</h1>
          <Muted className="mt-1">{t('account.security.lead')}</Muted>
        </div>
        <p role="status" aria-live="polite" className="min-h-5 text-sm text-positive empty:sr-only">
          {message}
        </p>
        <NoticesSection />
        <Section title={t('account.password.title')}>
          <Panel>
            <Row>
              <div className="min-w-0">
                <h3 className="font-medium">{t('account.password.heading')}</h3>
                <Muted>{t('account.password.lead')}</Muted>
              </div>
              <Button onClick={() => setChanging(true)}>{t('account.password.change')}</Button>
            </Row>
          </Panel>
        </Section>
        <FactorsSection announce={setMessage} />
        <SessionsSection announce={setMessage} />
        <ActivitySection />
      </div>
      <ChangePasswordDialog
        open={changing}
        {...(session.user ? { username: session.user.username } : {})}
        onClose={() => setChanging(false)}
        onChanged={() => {
          setChanging(false)
          setMessage(t('account.password.changed'))
        }}
      />
    </StepUpProvider>
  )
}
