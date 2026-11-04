import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { openMock, signInAs } from './fixtures/auth-ui'

/**
 * The assistant sidebar (SPEC/34 task 5) against the mock layer: the scripted assistant of src/lib/assistant/mock-api.ts.
 * The shell's own server functions are not mocked (aborted), like in auth-ui-shell.spec.ts.
 */

const EMAIL = 'anna.meyer@example.com'

async function toShell(page: Page, flags = '') {
  await page.route(/_serverFn/, (route) => route.abort())
  if (flags) await page.addInitScript((f) => window.sessionStorage.setItem('dbloom.authMock.flags', f), flags)
  await openMock(page, 'login')
  await signInAs(page, 'alice')
  await page.getByRole('tab', { name: 'Type credentials' }).click()
  await page.getByLabel('Host').fill('db.example.org')
  await page.getByLabel('Database user').fill('app')
  await page.getByLabel('Database password').fill('secret')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({ timeout: 10_000 })
}

async function openAssistant(page: Page, flags = '') {
  await toShell(page, flags)
  await page.getByRole('button', { name: 'Assistant', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Assistant', level: 2 })).toBeVisible()
}

const panel = (page: Page) => page.getByRole('complementary', { name: 'Assistant' })
const composer = (page: Page) => page.getByLabel('Message to the assistant')
async function ask(page: Page, text: string) {
  await composer(page).fill(text)
  await composer(page).press('Enter')
}
const approvalCard = (page: Page, name = 'Run this query?') => page.getByRole('group', { name })
const clean = async (page: Page) => {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
}

test.describe('manual mode', () => {
  test('a question, the approval card, then the result with real values and the answer', async ({ page }) => {
    await openAssistant(page)
    await expect(page.getByText('Ask a question about your data.')).toBeVisible()
    await ask(page, 'Show me my customers')
    await expect(page.getByRole('log').getByText('Show me my customers')).toBeVisible()

    const card = approvalCard(page)
    await expect(card).toBeVisible()
    await expect(card).toContainText('SELECT id, email, city FROM customers LIMIT 3')
    await expect(card).toContainText('On shop.')
    await expect(card).toContainText('Why: List three customers with their city.')
    await expect(page.getByRole('status').filter({ hasText: 'A statement waits for your approval.' })).toHaveCount(1)
    await expect(page.getByText(EMAIL)).toHaveCount(0) // nothing ran yet

    await card.getByRole('button', { name: 'Approve' }).click()
    const result = page.getByRole('group', { name: 'Result' })
    await expect(result).toBeVisible()
    await expect(result.getByRole('region', { name: 'Result of the statement' })).toContainText(EMAIL)
    await expect(result).toContainText('3 rows')
    await expect(result).toContainText('Hidden from the assistant: email')
    await expect(page.locator('strong', { hasText: EMAIL })).toBeVisible() // the answer: bold text, real value
    await expect(card.getByRole('button', { name: 'Approve' })).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: 'A statement waits for your approval.' })).toHaveCount(0)
  })

  test('Decline runs nothing and says so', async ({ page }) => {
    await openAssistant(page)
    await ask(page, 'customers please')
    await approvalCard(page).getByRole('button', { name: 'Decline' }).click()
    await expect(page.getByText('You declined this call.')).toBeVisible()
    await expect(page.getByText('Understood, I did not run it.')).toBeVisible()
    await expect(page.getByRole('group', { name: 'Result' })).toHaveCount(0)
  })

  test('Open in SQL tab puts the statement into a new SQL tab, not run, and the panel stays', async ({ page }) => {
    await openAssistant(page)
    await ask(page, 'customers please')
    await approvalCard(page).getByRole('button', { name: 'Open in SQL tab' }).click()
    await expect(page.getByRole('tab', { name: /SQL/ }).first()).toBeVisible()
    await expect(page.locator('.cm-content')).toContainText('SELECT id, email, city FROM customers LIMIT 3')
    await expect(panel(page)).toBeVisible()
    await expect(approvalCard(page).getByRole('button', { name: 'Approve' })).toBeVisible()
  })

  test('refusals: a delete goes to the SQL tab, a LIKE on personal data is not run', async ({ page }) => {
    await openAssistant(page)
    await ask(page, 'delete the customer')
    const refused = page.getByRole('group', { name: 'Not run' })
    await expect(refused).toContainText('The assistant cannot run this statement.')
    await expect(refused).toContainText('DELETE FROM customers WHERE id = 1')
    await refused.getByRole('button', { name: 'Open in SQL tab' }).click()
    await expect(page.locator('.cm-content')).toContainText('DELETE FROM customers WHERE id = 1')
    await ask(page, 'find emails like a')
    await expect(page.getByText('Not run: it would use personal data in a way that could reveal values.')).toBeVisible()
  })

  test('Stop ends a running turn; an AI failure shows an alert and the conversation goes on', async ({ page }) => {
    await openAssistant(page)
    await ask(page, 'a slow question')
    await expect(page.getByText('The assistant is working…')).toBeVisible()
    await expect(composer(page)).toBeVisible()
    await page.getByRole('button', { name: 'Stop' }).click()
    await expect(page.getByText('The assistant is working…')).toHaveCount(0)
    await ask(page, 'this will fail')
    await expect(page.getByRole('alert').filter({ hasText: 'The AI service did not answer. Try again in a moment.' })).toBeVisible()
    await ask(page, 'hello again')
    await expect(page.getByText('I can look into your data.')).toBeVisible()
  })
})

test.describe('auto mode', () => {
  test('reads run on their own; a change still asks', async ({ page }) => {
    await openAssistant(page)
    await ask(page, 'hello') // creates the conversation
    await expect(page.getByText('I can look into your data.')).toBeVisible()
    const auto = page.getByRole('button', { name: 'Reads run on their own' })
    await auto.click()
    await expect(auto).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText('Reads run without asking. Changes always ask first.')).toBeVisible()

    await ask(page, 'show customers')
    await expect(page.getByRole('group', { name: 'Result' })).toContainText(EMAIL)
    await expect(approvalCard(page)).toHaveCount(0)

    await ask(page, 'update customer 1')
    const card = approvalCard(page, 'Make this change?')
    await expect(card).toContainText("UPDATE customers SET city = 'Oslo' WHERE id = 1")
    await expect(card).toContainText('Changes always need your approval, also in auto mode.')
    await card.getByRole('button', { name: 'Approve' }).click()
    await expect(page.getByText('Done: one row was updated.')).toBeVisible()
    await expect(page.getByRole('group', { name: 'Result' }).last()).toContainText('1 row changed')
  })

  test('when the administrators switched auto off, the button is disabled and says why', async ({ page }) => {
    await openAssistant(page, 'assistant-auto-off')
    await ask(page, 'hello')
    await expect(page.getByText('I can look into your data.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reads run on their own' })).toBeDisabled()
    await expect(page.getByText('Auto mode is off: the administrators have not allowed it.')).toBeVisible()
  })
})

test.describe('conversations', () => {
  test('new, rename, switch, delete', async ({ page }) => {
    await openAssistant(page)
    await ask(page, 'first question')
    await expect(page.getByText('I can look into your data.')).toBeVisible()
    await page.getByRole('button', { name: 'New conversation' }).click()
    await expect(page.getByText('Ask a question about your data.')).toBeVisible()
    await ask(page, 'second question')
    await expect(page.getByText('I can look into your data.')).toBeVisible()

    const select = page.getByLabel('Conversation', { exact: true }).first()
    await expect(select.locator('option')).toHaveText(['second question', 'first question'])
    await select.selectOption({ label: 'first question' })
    await expect(page.getByRole('log', { name: 'first question' })).toBeVisible()
    await expect(page.getByRole('log', { name: 'second question' })).toHaveCount(0)

    await page.getByRole('button', { name: 'Conversation', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    await page.getByLabel('Name of the conversation').fill('Orders per month')
    await page.getByRole('button', { name: 'Save name' }).click()
    await expect(select.locator('option')).toContainText(['Orders per month'])

    await page.getByRole('button', { name: 'Conversation', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Delete conversation' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click()
    await expect(select.locator('option')).toHaveText(['second question'])
  })
})

test.describe('availability', () => {
  test('not configured says so and offers no composer', async ({ page }) => {
    await openAssistant(page, 'assistant-off')
    await expect(page.getByText('Not configured. An administrator has to connect an AI service')).toBeVisible()
    await expect(composer(page)).toHaveCount(0)
  })

  test('an unconfigured target says what the assistant gets', async ({ page }) => {
    await openAssistant(page, 'assistant-unconfigured')
    await expect(page.getByText('No columns are marked as personal data for this connection yet.')).toBeVisible()
  })
})

test.describe('large dialog', () => {
  test('keeps the conversation, the scroll position and the draft, and goes back with the focus on the size button', async ({ page }) => {
    await openAssistant(page)
    await ask(page, 'customers please')
    await expect(approvalCard(page)).toBeVisible()
    await composer(page).fill('half a thought')

    await page.getByRole('button', { name: 'Open the assistant large' }).click()
    const dialog = page.getByRole('dialog', { name: 'Assistant' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Message to the assistant')).toHaveValue('half a thought')
    await expect(dialog.getByRole('group', { name: 'Run this query?' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Back to the side' })).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(composer(page)).toHaveValue('half a thought')
    await expect(approvalCard(page)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open the assistant large' })).toBeFocused()

    await page.getByRole('button', { name: 'Open the assistant large' }).click()
    await dialog.getByRole('button', { name: 'Back to the side' }).click()
    await expect(dialog).toHaveCount(0)
  })

  test('a statement opened from the dialog brings the panel back to the side', async ({ page }) => {
    await openAssistant(page)
    await ask(page, 'customers please')
    await page.getByRole('button', { name: 'Open the assistant large' }).click()
    await page.getByRole('dialog', { name: 'Assistant' }).getByRole('button', { name: 'Open in SQL tab' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.cm-content')).toContainText('SELECT id, email, city FROM customers LIMIT 3')
  })
})

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    })
    test('approval card, result, refusal and the large dialog are accessible', async ({ page }) => {
      await openAssistant(page, 'assistant-unconfigured')
      await ask(page, 'customers please')
      await expect(approvalCard(page)).toBeVisible()
      await clean(page)
      await approvalCard(page).getByRole('button', { name: 'Approve' }).click()
      await expect(page.getByRole('group', { name: 'Result' })).toBeVisible()
      await clean(page)
      await ask(page, 'delete it')
      await expect(page.getByRole('group', { name: 'Not run' })).toBeVisible()
      await clean(page)
      await page.getByRole('button', { name: 'Open the assistant large' }).click()
      await expect(page.getByRole('dialog', { name: 'Assistant' })).toBeVisible()
      await clean(page)
    })
  })
}

test.describe('phone width', () => {
  test.use({ viewport: { width: 375, height: 667 } })
  test('the panel covers the page, nothing scrolls sideways, the controls stay reachable', async ({ page }) => {
    await toShell(page)
    await page.getByRole('button', { name: 'Assistant', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Assistant', level: 2 })).toBeVisible()
    await ask(page, 'customers please')
    await expect(approvalCard(page)).toBeVisible()
    await approvalCard(page).getByRole('button', { name: 'Approve' }).click()
    await expect(page.getByRole('group', { name: 'Result' })).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await expect(composer(page)).toBeVisible()
    await clean(page)
  })
})
