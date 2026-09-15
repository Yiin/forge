import { expect, test } from '@playwright/test'
import {
  launchForge,
  proxyForgeApi,
  stopProxiedForge,
} from '../helpers/forgeServer.js'

test('workspace shell fits the viewport and supports keyboard navigation', async ({
  page,
  baseURL,
}) => {
  const forge = await launchForge()
  try {
    await proxyForgeApi(page, forge)
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
    await expect(page).toHaveURL(/\/settings\/general$/)
    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible()
  } finally {
    await stopProxiedForge(page, forge)
  }
})
