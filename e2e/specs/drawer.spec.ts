import { expect, test } from '@playwright/test'
import { launchForge } from '../helpers/forgeServer.js'

test('phone drawer opens on-screen within the viewport', async ({
  page,
  baseURL,
}) => {
  test.skip(
    test.info().project.name !== 'phone',
    'drawer only exists in the phone shell',
  )
  const forge = await launchForge()
  try {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.route('**/api/**', async (route) => {
      const target = `${forge.baseUrl}${new URL(route.request().url()).pathname}${new URL(route.request().url()).search}`
      const response = await fetch(target, {
        method: route.request().method(),
        headers: {
          'content-type':
            route.request().headers()['content-type'] ?? 'application/json',
        },
        body: route.request().postDataBuffer() ?? undefined,
      })
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      })
    })
    await page.addInitScript((url) => {
      const NativeWebSocket = window.WebSocket
      const socketUrl = url.replace(/^http/, 'ws') + '/ws'
      // Keep the browser API shape while pointing the app at the isolated server.
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
    await page.goto(baseURL ?? '/')
    await page.locator('.phone-shell').getByLabel('Open navigation').click()
    const drawer = page.locator('.drawer')
    await expect(drawer).toBeVisible()
    // The drawer slides in; poll until the transform settles.
    await expect
      .poll(async () => (await drawer.boundingBox())?.x)
      .toBeGreaterThanOrEqual(0)
    const box = await drawer.boundingBox()
    expect(box?.width ?? 391).toBeLessThanOrEqual(390)
    await expect(drawer.getByText('forge')).toBeVisible()
  } finally {
    await forge.stop()
  }
})
