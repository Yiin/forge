import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { launchForge, stopProxiedForge } from '../helpers/forgeServer.js'

const settings = {
  titleGeneration: true,
  keybindings: {},
  epicDefaults: { workerCount: 3, mode: 'pool' },
}

async function wireIsolatedServer(
  page: import('@playwright/test').Page,
  forge: Awaited<ReturnType<typeof launchForge>>,
) {
  await page.route('**/api/**', async (route) => {
    const requestUrl = new URL(route.request().url())
    if (requestUrl.pathname === '/api/settings') {
      if (route.request().method() === 'PUT') {
        Object.assign(settings, await route.request().postDataJSON())
      }
      await route.fulfill({ json: settings })
      return
    }
    if (requestUrl.pathname === '/api/status') {
      await route.fulfill({
        json: { version: 'e2e', bootId: 'test', uptimeSec: 1 },
      })
      return
    }
    if (requestUrl.pathname === '/api/harnesses') {
      await route.fulfill({ json: {} })
      return
    }
    if (requestUrl.pathname === '/api/accounts') {
      await route.fulfill({ json: [] })
      return
    }
    if (requestUrl.pathname === '/api/epics') {
      await route.fulfill({ json: [] })
      return
    }
    const response = await fetch(
      `${forge.baseUrl}${requestUrl.pathname}${requestUrl.search}`,
      {
        method: route.request().method(),
        headers: {
          'content-type':
            route.request().headers()['content-type'] ?? 'application/json',
        },
        body: route.request().postDataBuffer() ?? undefined,
      },
    )
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    })
  })
  await page.addInitScript((url) => {
    const NativeWebSocket = window.WebSocket
    const socketUrl = url.replace(/^http/, 'ws') + '/ws'
    const ForgeWebSocket = function (
      this: WebSocket,
      _url: string,
      protocols?: string | string[],
    ) {
      return new NativeWebSocket(socketUrl, protocols)
    } as unknown as typeof WebSocket
    ForgeWebSocket.prototype = NativeWebSocket.prototype
    window.WebSocket = ForgeWebSocket
  }, forge.baseUrl)
}

async function expectAccessible(page: import('@playwright/test').Page) {
  const result = await new AxeBuilder({ page }).analyze()
  const serious = result.violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  )
  expect(
    serious,
    serious.map((violation) => `${violation.id}: ${violation.help}`).join('\n'),
  ).toEqual([])
}

test('settings routes expose stable navigation, focus, and accessible controls', async ({
  page,
}) => {
  const forge = await launchForge()
  try {
    await wireIsolatedServer(page, forge)
    for (const [path, heading] of [
      ['/settings/general', 'General'],
      ['/settings/keybindings', 'Keybindings'],
      ['/settings/harnesses', 'Harnesses'],
      ['/settings/projects', 'Projects'],
      ['/settings/epics', 'Epics'],
    ] as const) {
      await page.goto(path)
      const pageHeading = page.getByRole('heading', { name: heading, level: 1 })
      await expect(pageHeading).toBeVisible()
      await expect(pageHeading).toBeFocused()
      await expectAccessible(page)
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth))
    }
  } finally {
    await stopProxiedForge(page, forge)
  }
})

test('general settings save, theme, and Select keyboard behavior persist', async ({
  page,
}) => {
  const forge = await launchForge()
  try {
    await wireIsolatedServer(page, forge)
    await page.goto('/settings/general')
    const theme = page.getByRole('combobox', { name: 'Theme' })
    await theme.click()
    // Radix mounts the listbox and moves roving focus to the selected option
    // asynchronously, and it opens with the CURRENT value highlighted, so a
    // fixed arrow count lands on different items depending on the start value.
    // Exercise the keyboard contract with one arrow step plus typeahead.
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('role') === 'option',
    )
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(50)
    await page.keyboard.press('d')
    await page.waitForTimeout(50)
    await page.keyboard.press('Enter')
    await expect(theme).toContainText(/dark/i)
    await expect(theme).toBeFocused()
    const toggle = page.getByRole('switch', {
      name: 'Generate plain-word session titles',
    })
    await toggle.click()
    await expect(
      page.getByRole('status').filter({ hasText: 'Saved.' }).first(),
    ).toBeVisible()
    await page.reload()
    await expect(
      page.getByRole('switch', { name: 'Generate plain-word session titles' }),
    ).not.toBeChecked()
    await expectAccessible(page)
  } finally {
    await stopProxiedForge(page, forge)
  }
})

test('draft entry has no overflow at the integrated acceptance widths', async ({
  page,
}) => {
  const forge = await launchForge()
  try {
    await wireIsolatedServer(page, forge)
    await page.goto('/?new=1')
    await expect(
      page.getByRole('heading', { name: 'Welcome to Forge' }),
    ).toBeVisible()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth))
    await expectAccessible(page)
  } finally {
    await stopProxiedForge(page, forge)
  }
})
