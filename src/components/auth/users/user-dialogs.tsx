import { useState } from 'react'
import { t } from '~/i18n'
import { FormField } from '~/components/auth/auth-frame'
import { ShownOnce } from '~/components/auth/shown-once'
import { PasswordField } from '~/components/auth/password-field'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Select } from '~/components/ui/select'
import { useStepUp } from '~/components/auth/account/step-up'
import { ModalForm } from '~/components/auth/connections/dialog-shell'
import { authApi } from '~/lib/auth/api'
import { generateTempPassword } from '~/lib/auth/connections-logic'
import { useAction } from '~/lib/auth/use-action'
import { PASSWORD_MIN_LENGTH_DEFAULT, ROLES, type Role } from '~/server/auth/types'

export const formatWhen = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function RoleSelect({ value, onChange, label, compact, disabled }: { value: Role; onChange: (r: Role) => void; label: string; compact?: boolean; disabled?: boolean }) {
  return (
    <Select aria-label={label} compact={compact} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value as Role)} className={compact ? 'w-auto min-w-[8.5rem]' : undefined}>
      {ROLES.map((r) => (
        <option key={r} value={r}>
          {t(`auth.users.role.${r}`)}
        </option>
      ))}
    </Select>
  )
}

/** A link shown exactly once (invite, recovery): the same shown-once block as recovery codes, no file download. */
export function LinkShownDialog({ title, lead, link, expiresAt, onClose }: { title: string; lead: string; link: string; expiresAt: number; onClose: () => void }) {
  const [saved, setSaved] = useState(false)
  return (
    <ModalForm locked title={title} lead={lead} onClose={onClose} submitLabel={t('auth.users.linkDone')} submitDisabled={!saved} onSubmit={onClose}>
      <ShownOnce lines={[link]} columns={1} label={t('auth.users.linkLabel')} confirmLabel={t('auth.users.linkSaved')} saved={saved} onSavedChange={setSaved} />
      <p className="text-sm text-muted">{t('auth.users.linkExpires', { time: formatWhen(expiresAt) })}</p>
    </ModalForm>
  )
}

/** Create a user with a temporary password (FR-AUT-004, 028); the password is shown once afterwards. */
export function CreateUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { guard } = useStepUp()
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [role, setRole] = useState<Role>('user')
  const [password, setPassword] = useState('')
  const [created, setCreated] = useState<{ name: string; password: string } | null>(null)
  const [saved, setSaved] = useState(false)
  const action = useAction()

  if (created) {
    return (
      <ModalForm
        locked
        title={t('auth.users.createdTitle')}
        lead={t('auth.users.createdLead', { name: created.name })}
        onClose={onClose}
        submitLabel={t('auth.users.linkDone')}
        submitDisabled={!saved}
        onSubmit={() => {
          onCreated()
          onClose()
        }}
      >
        <ShownOnce lines={[created.password]} columns={1} label={t('auth.users.tempLabel')} confirmLabel={t('auth.users.tempSaved')} saved={saved} onSavedChange={setSaved} />
      </ModalForm>
    )
  }

  return (
    <ModalForm
      title={t('auth.users.createTitle')}
      lead={t('auth.users.createLead')}
      onClose={onClose}
      busy={action.busy}
      submitLabel={action.busy ? t('auth.users.creating') : t('auth.users.create')}
      submitDisabled={username.trim() === '' || password === ''}
      error={action.error?.message ?? null}
      onSubmit={async () => {
        const r = await action.run(() => guard(() => authApi().createUser({ username: username.trim(), displayName: displayName.trim() || username.trim(), role, password })))
        if (r.ok) setCreated({ name: r.value.displayName || r.value.username, password })
      }}
    >
      <FormField label={t('auth.invite.username')} hint={t('auth.invite.usernameHint')}>
        {(f) => <Input {...f} name="new-username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} autoFocus />}
      </FormField>
      <FormField label={t('auth.invite.displayName')}>
        {(f) => <Input {...f} name="new-display" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="off" />}
      </FormField>
      <FormField label={t('auth.users.role')}>{(f) => <RoleSelectField {...f} value={role} onChange={setRole} />}</FormField>
      <div className="flex flex-col gap-2">
        <PasswordField
          label={t('auth.users.tempPassword')}
          name="new-temp-password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          username={username}
          meter
          minLength={PASSWORD_MIN_LENGTH_DEFAULT}
          hint={t('auth.users.tempHint')}
        />
        <Button className="self-start" onClick={() => setPassword(generateTempPassword())}>
          {t('auth.users.generate')}
        </Button>
      </div>
    </ModalForm>
  )
}

function RoleSelectField({ value, onChange, id, ...rest }: { value: Role; onChange: (r: Role) => void; id: string; 'aria-describedby'?: string; 'aria-invalid'?: true }) {
  return (
    <Select id={id} {...rest} value={value} onChange={(e) => onChange(e.target.value as Role)}>
      {ROLES.map((r) => (
        <option key={r} value={r}>
          {t(`auth.users.role.${r}`)}
        </option>
      ))}
    </Select>
  )
}

const LIFETIMES: { key: 'default' | 'h1' | 'h24' | 'h72' | 'd7'; ms: number | undefined }[] = [
  { key: 'default', ms: undefined },
  { key: 'h1', ms: 3_600_000 },
  { key: 'h24', ms: 24 * 3_600_000 },
  { key: 'h72', ms: 72 * 3_600_000 },
  { key: 'd7', ms: 7 * 24 * 3_600_000 },
]

/** Issue an invite link (FR-AUT-015); the link is shown once. */
export function InviteDialog({ onClose, onIssued }: { onClose: () => void; onIssued: () => void }) {
  const { guard } = useStepUp()
  const [role, setRole] = useState<Role>('user')
  const [life, setLife] = useState<(typeof LIFETIMES)[number]['key']>('default')
  const [issued, setIssued] = useState<{ link: string; expiresAt: number } | null>(null)
  const action = useAction()

  if (issued) {
    return (
      <LinkShownDialog
        title={t('auth.users.inviteLinkTitle')}
        lead={t('auth.users.inviteLinkLead')}
        link={issued.link}
        expiresAt={issued.expiresAt}
        onClose={() => {
          onIssued()
          onClose()
        }}
      />
    )
  }
  return (
    <ModalForm
      title={t('auth.users.inviteTitle')}
      lead={t('auth.users.inviteLead')}
      onClose={onClose}
      busy={action.busy}
      submitLabel={action.busy ? t('auth.users.creating') : t('auth.users.inviteIssue')}
      error={action.error?.message ?? null}
      onSubmit={async () => {
        const ms = LIFETIMES.find((l) => l.key === life)?.ms
        const r = await action.run(() => guard(() => authApi().issueInvite({ role, ...(ms ? { lifetimeMs: ms } : {}) })))
        if (r.ok) setIssued(r.value)
      }}
    >
      <FormField label={t('auth.users.inviteRole')}>{(f) => <RoleSelectField {...f} value={role} onChange={setRole} />}</FormField>
      <FormField label={t('auth.users.inviteLife')}>
        {(f) => (
          <Select {...f} value={life} onChange={(e) => setLife(e.target.value as typeof life)}>
            {LIFETIMES.map((l) => (
              <option key={l.key} value={l.key}>
                {t(`auth.users.life.${l.key}`)}
              </option>
            ))}
          </Select>
        )}
      </FormField>
    </ModalForm>
  )
}
