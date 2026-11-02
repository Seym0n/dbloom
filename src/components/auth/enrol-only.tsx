import { useState } from 'react'
import { t } from '~/i18n'
import { Button } from '~/components/ui/button'
import { authApi } from '~/lib/auth/api'
import { RECOVERY_CODES_FILE_NAME } from '~/server/auth/types'
import { AuthFrame, AuthHeading } from './auth-frame'
import { PasskeyEnrol } from './passkey-enrol'
import { ShownOnce } from './shown-once'
import { TabList, panelId, tabId } from './tab-list'
import { TotpEnrol } from './totp-enrol'

type Kind = 'totp' | 'passkey'

/** `enrol_only` session (FR-AUT-012): the only thing allowed is adding a second factor; recovery codes follow once. */
export function EnrolOnly({ onEnrolled, onSignOut }: { onEnrolled: () => void; onSignOut: () => void }) {
  const [kind, setKind] = useState<Kind>('totp')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [saved, setSaved] = useState(false)
  const api = authApi()

  const done = (recovery?: string[]) => {
    if (recovery && recovery.length > 0) setCodes(recovery)
    else onEnrolled()
  }

  if (codes) {
    return (
      <AuthFrame>
        <AuthHeading title={t('auth.codes.title')} lead={t('auth.codes.lead')} />
        <ShownOnce lines={codes} fileName={RECOVERY_CODES_FILE_NAME} label={t('auth.codes.label')} saved={saved} onSavedChange={setSaved} />
        <div className="mt-6">
          <Button
            variant="primary"
            size="lg"
            disabled={!saved}
            onClick={onEnrolled}
          >
            {t('auth.codes.continue')}
          </Button>
        </div>
      </AuthFrame>
    )
  }

  const prefix = 'enrol'
  return (
    <AuthFrame>
      <AuthHeading title={t('auth.enrol.title')} lead={t('auth.enrol.lead')} />
      <div className="mb-6">
        <TabList
          label={t('auth.enrol.methods')}
          tabs={[
            { key: 'totp', label: t('auth.enrol.totp') },
            { key: 'passkey', label: t('auth.enrol.passkey') },
          ]}
          value={kind}
          onChange={setKind}
          idPrefix={prefix}
        />
      </div>
      <div role="tabpanel" id={panelId(prefix, kind)} aria-labelledby={tabId(prefix, kind)}>
        {kind === 'totp' ? (
          <TotpEnrol key="totp" start={() => api.totpStart()} confirm={(code) => api.totpConfirm(code)} onDone={done} />
        ) : (
          <PasskeyEnrol
            key="passkey"
            options={() => api.passkeyRegisterOptions()}
            verify={(response, name) => api.passkeyRegisterVerify(response, name)}
            onDone={(result) => done((result as { recoveryCodes?: string[] } | undefined)?.recoveryCodes)}
          />
        )}
      </div>
      <div className="mt-6">
        <Button variant="ghost" onClick={onSignOut}>
          {t('auth.signOut')}
        </Button>
      </div>
    </AuthFrame>
  )
}
