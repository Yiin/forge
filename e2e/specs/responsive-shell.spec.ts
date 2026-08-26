import { expect, test } from '@playwright/test'
import { launchForge, stopProxiedForge } from '../helpers/forgeServer.js'

test('workspace shell fits the viewport and supports keyboard navigation', async ({
  page,
  baseURL,
}) => {
  const forge = await launchForge()
  try {
    await page.route('**/api/**', async (route) => {
      const requestUrl = new URL(route.request().url())
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
    await page.goto(`${baseURL ?? '/'}/?new=1`)

    await expect(
      page.getByRole('heading', { name: 'Welcome to Forge' }),
    ).toBeVisible()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth))

    await page.keyboard.press('g')
    await page.keyboard.press('r')
    await expect(page).toHaveURL(/\/runs$/)
    await expect(page.getByRole('heading', { name: 'Epic runs' })).toBeVisible()

    await page.keyboard.press('g')
    await page.keyboard.press('s')
    await expect(page).toHaveURL(/\/settings$/)
    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible()
  } finally {
    await stopProxiedForge(page, forge)
  }
})
