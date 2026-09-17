import { expect, test } from '@playwright/test'
import {
  launchForge,
  proxyForgeApi,
  stopProxiedForge,
} from '../helpers/forgeServer.js'

test.use({ actionTimeout: 5000 })

test('uses the full phone viewport and returns to conversation without changing desktop restore', async ({
  page,
}, info) => {
  const forge = await launchForge()
  try {
    await proxyForgeApi(page, forge)
    await page.addInitScript((url) => {
      const Original = window.WebSocket
      window.WebSocket = class extends Original {
        constructor(_url: string | URL, protocols?: string | string[]) {
          super(url.replace(/^http/, 'ws') + '/ws', protocols)
        }
      }
    }, forge.baseUrl)
    const projectResponse = await fetch(forge.baseUrl + '/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Mobile dock proof', path: forge.dataDir }),
    })
    expect(projectResponse.ok).toBe(true)
    const project = await projectResponse.json()
    const response = await fetch(forge.baseUrl + '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        harness: 'mock',
        cwd: forge.dataDir,
        title: 'Mobile dock',
      }),
    })
    expect(response.ok).toBe(true)
    const session = await response.json()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/s/${session.id}`)
    const open = async () => {
      await page
        .getByRole('button', { name: 'Open workspace dock', exact: true })
        .click()
      await page
        .getByRole('menu', { name: 'Workspace surfaces' })
        .getByRole('button', { name: 'History', exact: true })
        .click()
      await expect(
        page.getByRole('region', { name: 'Git history' }),
      ).toContainText('e2e base')
    }
    await open()
    const dock = page.getByRole('complementary', { name: 'Workspace dock' })
    await expect
      .poll(async () => Math.round((await dock.boundingBox())!.width))
      .toBe(390)
    expect(Math.round((await dock.boundingBox())!.x)).toBe(0)
    await page.screenshot({
      path: info.outputPath('phone-full-width-history.png'),
    })
    await dock.getByRole('button', { name: 'Return to conversation' }).click()
    await expect(dock).toHaveCount(0)
    await expect(page.getByLabel('Message composer')).toBeVisible()
    await page.setViewportSize({ width: 1320, height: 880 })
    await open()
    const width = (await dock.boundingBox())!.width
    expect(width).toBeGreaterThan(300)
    expect(width).toBeLessThan(1000)
    await dock.getByRole('button', { name: 'Take over workspace' }).click()
    await expect
      .poll(async () => Math.round((await dock.boundingBox())!.width))
      .toBe(1320)
    await dock.getByRole('button', { name: 'Return to conversation' }).click()
    await expect(dock).toBeVisible()
    await expect
      .poll(async () => Math.round((await dock.boundingBox())!.width))
      .toBe(Math.round(width))
  } finally {
    await stopProxiedForge(page, forge)
  }
})
