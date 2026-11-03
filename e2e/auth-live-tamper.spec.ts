import { DatabaseSync } from 'node:sqlite'
import { expect, test } from '@playwright/test'
import {
  MYSQL,
  createDbUser,
  dialog,
  h1,
  runSetupWizard,
  signInWithRecovery,
  startServer,
  storePath,
} from './fixtures/auth-live'

/** SCN-073: a profile whose ciphertext was modified does not open (AES-GCM tag), while the vault itself still unlocks. */

test('SCN-073 a modified ciphertext does not open: the profile connect fails and nothing is revealed', async ({
  page,
}) => {
  const server = await startServer()
  const db = await createDbUser(MYSQL)
  try {
    const admin = await runSetupWizard(page, server, { username: 'ana' })
    await signInWithRecovery(page, server, admin)
    await page.getByRole('button', { name: 'Manage profiles and vault' }).click()
    await page.getByRole('button', { name: 'Create vault' }).click()
    const create = dialog(page, 'Create the vault')
    await create.getByLabel('Passphrase', { exact: true }).fill('a long vault passphrase')
    await create.getByLabel('Passphrase again').fill('a long vault passphrase')
    await create.getByRole('button', { name: 'Create vault' }).click()
    const key = dialog(page, 'Your recovery key')
    await key.getByLabel('I saved it').check()
    await key.getByRole('button', { name: 'Done' }).click()
    await page.getByRole('button', { name: 'New profile' }).click()
    const form = dialog(page, 'New profile')
    await form.getByLabel('Profile name').fill('MySQL')
    await form.getByLabel('Host').fill(db.host)
    await form.getByLabel('Port').fill(String(db.port))
    await form.getByLabel('Database user').fill(db.user)
    await form.getByLabel('Database password').fill(db.password)
    await form.getByLabel('Connection security').selectOption({ label: 'Not encrypted' })
    await form.getByRole('button', { name: 'Save profile' }).click()
    await expect(page.getByText('Profile saved.')).toBeVisible()
    // Untouched, the profile connects.
    await page.getByRole('button', { name: 'Back to connecting' }).click()
    await page.getByRole('button', { name: 'Connect with MySQL' }).click()
    await expect(page.getByRole('button', { name: db.database, exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Account menu' }).click()
    await page.getByRole('menuitem', { name: 'Log out' }).click()
    await expect(h1(page)).toHaveText('Sign in to DBLoom')

    // One character of the sealed part changes while the server is stopped.
    await server.stop()
    const store = new DatabaseSync(storePath(server)!)
    const row = store.prepare('SELECT id, sealed FROM connection_profiles').get() as {
      id: string
      sealed: string
    }
    const flipped = `${row.sealed.slice(0, -3)}${row.sealed.at(-3) === 'A' ? 'B' : 'A'}${row.sealed.slice(-2)}`
    store.prepare('UPDATE connection_profiles SET sealed = ? WHERE id = ?').run(flipped, row.id)
    store.close()
    await server.restart()

    await signInWithRecovery(page, server, admin)
    await page.getByRole('button', { name: 'Manage profiles and vault' }).click()
    await page.getByRole('button', { name: 'Unlock', exact: true }).click()
    const unlock = dialog(page, 'Unlock the vault')
    await unlock.getByLabel('Passphrase').fill('a long vault passphrase')
    await unlock.getByRole('button', { name: 'Unlock' }).click()
    // The vault opens (its own wraps are intact) ...
    await expect(page.getByTestId('vault-status')).toContainText('The vault is unlocked.')
    await page.getByRole('button', { name: 'Back to connecting' }).click()
    // ... the modified profile does not, and no connection appears.
    await page.getByRole('button', { name: 'Connect with MySQL' }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByRole('button', { name: db.database, exact: true })).toHaveCount(0)
  } finally {
    await server.stop()
    await db.drop().catch(() => undefined)
  }
})
