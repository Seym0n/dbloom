import { expect, test } from '@playwright/test'
import {
  addAuthenticator,
  dialog,
  h1,
  fillSignIn,
  readRecoveryCodes,
  readTotpSecret,
  runSetupWizard,
  sessionCookie,
  signInWithRecovery,
  signOutAtPicker,
  startServer,
  takeTotp,
  type Account,
  type LiveServer,
} from './fixtures/auth-live'

/** SCN-067 (passkeys), SCN-068 (factors, last factor), SCN-076 (step-up) against a real server and virtual authenticators. */

test.describe.configure({ mode: 'serial' })
test.setTimeout(150_000)

let server: LiveServer
let ana: Account

test.beforeAll(async ({ browser }) => {
  // A step-up window of one minute so that the second part of SCN-076 can run in a test.
  server = await startServer({ DBLOOM_STEPUP_MINUTES: '1' })
  const page = await browser.newPage()
  ana = await runSetupWizard(page, server, { username: 'ana' })
  await page.close()
})
test.afterAll(async () => server?.stop())

test('SCN-067 passkeys: add (renamed), passwordless sign-in with user verification, then as a second factor', async ({
  page,
}) => {
  const { cdp, authenticatorId } = await addAuthenticator(page, { uv: true })
  await signInWithRecovery(page, server, ana)
  await page.goto(server.baseURL + '/account')
  await expect(page.getByText('No passkeys yet.')).toBeVisible()
  await page.getByRole('button', { name: 'Add passkey' }).click()
  await dialog(page, 'Add a passkey').getByRole('button', { name: 'Add passkey' }).click()
  await expect(page.getByText('Passkey added.')).toBeVisible()
  const list = page.getByRole('list', { name: 'Passkeys' })
  await expect(list.getByRole('listitem')).toHaveCount(1)

  await page.getByRole('button', { name: /^Rename passkey/ }).click()
  await page.getByLabel('Passkey name').fill('Laptop')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Passkey renamed.')).toBeVisible()
  await expect(list.getByText('Laptop')).toBeVisible()

  // Passwordless, user verification required: a full session straight away, with a new cookie.
  await page.goto(server.baseURL + '/')
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(h1(page)).toHaveText('Sign in to DBLoom')
  const before = await sessionCookie(page)
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await expect(h1(page)).toHaveText('Connect to a database')
  expect(await sessionCookie(page)).not.toBe(before)
  await signOutAtPicker(page)

  // The same passkey as a second factor after the password.
  await fillSignIn(page, ana.username, ana.password)
  await expect(h1(page)).toHaveText('Confirm it is you')
  await page.getByRole('tab', { name: 'Passkey' }).click()
  await page.getByRole('button', { name: 'Use passkey' }).click()
  await expect(h1(page)).toHaveText('Connect to a database')

  // Without user verification the verified-at-registration passkey is refused for passwordless sign-in.
  await signOutAtPicker(page)
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false })
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('alert')).not.toContainText(
    /webauthn|verification|authenticator data/i,
  )
  await expect(h1(page)).toHaveText('Sign in to DBLoom')
})

test('SCN-067 an authenticator without user verification: accepted as a second factor, refused for passwordless', async ({
  page,
}) => {
  await addAuthenticator(page, { uv: false })
  await signInWithRecovery(page, server, ana)
  await page.goto(server.baseURL + '/account')
  await page.getByRole('button', { name: 'Add passkey' }).click()
  await dialog(page, 'Add a passkey').getByLabel('Passkey name').fill('Key')
  await dialog(page, 'Add a passkey').getByRole('button', { name: 'Add passkey' }).click()
  await expect(page.getByText('Passkey added.')).toBeVisible()
  await page.goto(server.baseURL + '/')
  await signOutAtPicker(page)

  await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(h1(page)).toHaveText('Sign in to DBLoom')

  await fillSignIn(page, ana.username, ana.password)
  await expect(h1(page)).toHaveText('Confirm it is you')
  await page.getByRole('tab', { name: 'Passkey' }).click()
  await page.getByRole('button', { name: 'Use passkey' }).click()
  await expect(h1(page)).toHaveText('Connect to a database')
})

test('SCN-068/076 factors: TOTP removal needs a step-up (TOTP, not a recovery code); the last factor stays; new codes shown once', async ({
  page,
}) => {
  await addAuthenticator(page, { uv: true })
  // The step-up window is one minute: sign in with a recovery code, then wait for it to pass.
  await signInWithRecovery(page, server, ana)
  await page.goto(server.baseURL + '/account')
  await expect(page.getByText('An authenticator app is set up.')).toBeVisible()
  await page.waitForTimeout(62_000)

  // Regenerate recovery codes: the call first answers stepup_required and the dialog opens; the action is not resent by itself.
  await page.getByRole('button', { name: 'Make new codes' }).click()
  await dialog(page, 'Make new recovery codes?')
    .getByRole('button', { name: 'Make new codes' })
    .click()
  const stepUp = dialog(page, 'Confirm it is you')
  await expect(stepUp).toBeVisible()
  // A recovery code is not accepted as a step-up: the dialog offers a passkey and an authenticator app only.
  await expect(stepUp.getByRole('tab', { name: 'Recovery code' })).toHaveCount(0)
  if (await stepUp.getByRole('tab', { name: 'Authenticator app' }).count())
    await stepUp.getByRole('tab', { name: 'Authenticator app' }).click()
  await stepUp.getByLabel('Code from your authenticator app').fill('000000')
  await stepUp.getByRole('button', { name: 'Confirm and continue' }).click()
  await expect(stepUp.getByRole('alert')).toHaveText(
    'That code or passkey was not accepted. Try again.',
  )
  await stepUp.getByLabel('Code from your authenticator app').fill(await takeTotp(ana))
  await stepUp.getByRole('button', { name: 'Confirm and continue' }).click()
  const codes = dialog(page, 'Recovery codes')
  ana.recoveryCodes = await readRecoveryCodes(codes)
  await codes.getByLabel('I saved them').check()
  await codes.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByText('Recovery codes left: 10')).toBeVisible()

  // Within the window the next protected action passes without a prompt: remove the first passkey.
  await page.getByRole('button', { name: 'Remove passkey Laptop' }).click()
  await dialog(page, 'Remove this passkey?').getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByText('Passkey removed.')).toBeVisible()

  // Removing the TOTP while passkeys remain is allowed; removing the very last factor is refused for an administrator.
  await page.getByRole('button', { name: 'Remove', exact: true }).first().click()
  await dialog(page, 'Remove the authenticator app?')
    .getByRole('button', { name: 'Remove' })
    .click()
  await expect(page.getByText('Authenticator app removed.')).toBeVisible()
  await page.getByRole('button', { name: 'Remove passkey Key' }).click()
  await dialog(page, 'Remove this passkey?').getByRole('button', { name: 'Remove' }).click()
  await expect(dialog(page, 'Remove this passkey?').getByRole('alert')).toHaveText(
    'Add a second factor to continue.',
  )
})

test('SCN-076 adding a TOTP: QR secret in the page, a wrong code refused, codes shown once', async ({
  page,
}) => {
  await signInWithRecovery(page, server, ana)
  await page.goto(server.baseURL + '/account')
  await page.getByRole('button', { name: 'Set up' }).click()
  const enrol = dialog(page, 'Set up an authenticator app')
  const secret = await readTotpSecret(enrol)
  expect(secret).toMatch(/^[A-Z2-7]{32}$/)
  await enrol.getByLabel('Code from the app').fill('000000')
  await enrol.getByRole('button', { name: 'Verify and add' }).click()
  await expect(enrol.getByRole('alert')).toBeVisible()
  ana.totpSecret = secret
  ana.lastStep = 0
  await enrol.getByLabel('Code from the app').fill(await takeTotp(ana))
  await enrol.getByRole('button', { name: 'Verify and add' }).click()
  await expect(page.getByText('An authenticator app is set up.')).toBeVisible()
})
