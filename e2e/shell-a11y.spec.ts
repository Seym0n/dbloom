import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

/**
 * Accessibility and reduced motion of the walking skeleton (SPEC/21 task 10): the direct login page, the shell with its
 * sidebar tree, the mobile drawer, the session-ended dialog, keyboard focus and reduced motion, in light and dark.
 * Runs against the seeded MySQL 8.4 (`e2e_shop`) in the chromium project.
 */

const scan = async (page: Page, include?: string) => {
  const builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
  if (include) builder.include(include)
  const { violations } = await builder.analyze()
  return violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)
}
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

async function signIn(page: Page) {
  await page.goto('/')
  await page.getByLabel('Server').fill('127.0.0.1:33064')
  await page.getByLabel('User name').fill('root')
  await page.getByLabel('Password').fill('root')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('navigation', { name: 'Databases' })).toBeVisible()
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    })

    test('the direct login page, with an error shown', async ({ page }) => {
      await page.goto('/')
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in to a database server')
      expect(await scan(page), 'login').toEqual([])
      await page.getByLabel('Server').fill('127.0.0.1:33064')
      await page.getByLabel('User name').fill('root')
      await page.getByLabel('Password').fill('wrong')
      await page.getByRole('button', { name: 'Sign in' }).click()
      await expect(page.getByRole('alert')).toBeVisible()
      expect(await scan(page), 'login with the error').toEqual([])
    })

    test('the shell: empty state, database tree open, table menu, assistant panel', async ({ page }) => {
      await signIn(page)
      await expect(page.getByRole('heading', { name: 'Open a table', level: 1 })).toBeVisible()
      expect(await scan(page), 'empty shell').toEqual([])
      await page.getByRole('button', { name: 'e2e_shop', exact: true }).click()
      await expect(page.getByRole('button', { name: 'e2e_shop', exact: true })).toHaveAttribute('aria-expanded', 'true')
      expect(await scan(page), 'tree open').toEqual([])
      await page.getByRole('button', { name: 'Assistant', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Assistant', level: 2 })).toBeVisible()
      expect(await scan(page), 'assistant panel').toEqual([])
    })

    test('the session-ended dialog', async ({ page, context }) => {
      await signIn(page)
      await context.clearCookies()
      await page.getByRole('button', { name: 'e2e_shop', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Your session has ended' })
      await expect(dialog).toBeVisible()
      expect(await scan(page), 'session ended').toEqual([])
    })
  })
}

test.describe('tablet and phone', () => {
  for (const [name, width, height] of [['tablet', 768, 1024], ['phone', 375, 667]] as const) {
    test.describe(name, () => {
      test.use({ viewport: { width, height } })
      test('login and shell have no sideways scroll and no violations', async ({ page }) => {
        await page.goto('/')
        await noOverflow(page)
        expect(await scan(page), `${name} login`).toEqual([])
        await signIn(page).catch(async () => {
          // on a narrow screen the tree is in the drawer
          await page.getByRole('button', { name: 'Databases' }).first().click()
        })
        await noOverflow(page)
        expect(await scan(page), `${name} shell`).toEqual([])
      })
    })
  }
})

test.describe('the mobile drawer', () => {
  test.use({ viewport: { width: 375, height: 667 } })

  async function toShell(page: Page) {
    await page.goto('/')
    await page.getByLabel('Server').fill('127.0.0.1:33064')
    await page.getByLabel('User name').fill('root')
    await page.getByLabel('Password').fill('root')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('button', { name: 'Databases' }).first()).toBeVisible()
  }
  const toggle = (page: Page) => page.getByRole('button', { name: 'Databases' }).first()

  test('opens with a backdrop, says so to assistive technology, and is accessible', async ({ page }) => {
    await toShell(page)
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('drawer-backdrop')).toHaveCount(0)
    await toggle(page).click()
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('drawer-backdrop')).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Databases' })).toBeVisible()
    expect(await scan(page), 'drawer open').toEqual([])
  })

  test('a tap on the backdrop closes it', async ({ page }) => {
    await toShell(page)
    await toggle(page).click()
    await page.getByTestId('drawer-backdrop').click({ position: { x: 340, y: 300 } })
    await expect(page.getByRole('navigation', { name: 'Databases' })).toBeHidden()
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false')
  })

  test('Escape closes it and the focus goes back to the button', async ({ page }) => {
    await toShell(page)
    await toggle(page).click()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('navigation', { name: 'Databases' })).toBeHidden()
    await expect(toggle(page)).toBeFocused()
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false')
  })

  test('choosing a table closes the drawer', async ({ page }) => {
    await toShell(page)
    await toggle(page).click()
    await page.getByRole('button', { name: 'e2e_shop', exact: true }).click()
    await page.getByRole('button', { name: 'orders', exact: true }).click()
    await expect(page.getByRole('navigation', { name: 'Databases' })).toBeHidden()
  })
})

test.describe('keyboard and motion', () => {
  test('every stop of the tab order shows where the focus is', async ({ page }) => {
    await signIn(page)
    const missing: string[] = []
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab')
      const visible = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null
        if (!el || el === document.body) return 'body'
        const cs = getComputedStyle(el)
        const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0
        const shadow = cs.boxShadow !== 'none'
        const label = el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 30) || el.tagName
        return outline || shadow ? 'ok' : `no focus style: ${label}`
      })
      if (visible !== 'ok' && visible !== 'body') missing.push(visible)
    }
    expect(missing).toEqual([])
  })

  test('with reduced motion nothing slides or fades for long', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await signIn(page)
    const slow = await page.evaluate(() => {
      const ms = (v: string) => Math.max(0, ...v.split(',').map((x) => (x.trim().endsWith('ms') ? parseFloat(x) : parseFloat(x) * 1000)))
      return [...document.querySelectorAll('button, a, [role=button], aside, dialog')]
        .map((el) => {
          const cs = getComputedStyle(el)
          return { tag: el.tagName, cls: String((el as HTMLElement).className).slice(0, 40), t: ms(cs.transitionDuration), a: ms(cs.animationDuration) }
        })
        .filter((x) => x.t > 200 || x.a > 200)
    })
    expect(slow).toEqual([])
  })
})
