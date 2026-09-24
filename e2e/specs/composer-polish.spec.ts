import { expect, test, type Page } from '@playwright/test'
import {
  launchForge,
  proxyForgeApi,
  stopProxiedForge,
} from '../helpers/forgeServer.js'

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEUlEQVR4nGOoyf6AFTEMLQkA5Wt1wb3FJ3MAAAAASUVORK5CYII=',
  'base64',
)

async function openDraft(
  page: Page,
  forge: Awaited<ReturnType<typeof launchForge>>,
) {
  await proxyForgeApi(page, forge)
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
  await page.goto('/')
  await page.getByRole('button', { name: 'Add project' }).click()
  const dialog = page.getByRole('dialog', { name: 'Create project' })
  await dialog.getByLabel('Name').fill('Composer project')
  await dialog.getByLabel('Folder path').fill(forge.dataDir)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await page.waitForURL(/\/draft\//)
  await expect(page.getByLabel('Branch')).toHaveText('main')
  return page.getByLabel('Message composer')
}

for (const reducedMotion of ['no-preference', 'reduce'] as const)
  test(`the first send docks the new-session composer (${reducedMotion})`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion })
    const forge = await launchForge({
      fakeAgentEnv: { FORGE_MOCK_PROMPT_DELAY_MS: '1500' },
    })
    try {
      const composer = await openDraft(page, forge)
      const pill = page.locator('.chat-composer-glass')
      const hero = (await pill.boundingBox())!
      await composer.fill('dock this prompt')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await page.waitForURL(/\/s\//)
      // The session shows its transcript at once, never a loading line.
      await expect(page.getByText('Loading session…')).toHaveCount(0)
      await expect(page.locator('.chat-user').first()).toContainText(
        'dock this prompt',
      )
      // The glide lands: docked radius, no motion styles or hero copies left.
      await expect(pill).toHaveCSS('border-radius', '22px')
      await expect(page.locator('[data-glide-copy]')).toHaveCount(0)
      await expect
        .poll(() =>
          page
            .locator('.composer-root')
            .evaluate(
              (node: HTMLElement) => node.style.transform + node.style.opacity,
            ),
        )
        .toBe('')
      const docked = (await pill.boundingBox())!
      const viewport = page.viewportSize()!
      expect(docked.y).toBeGreaterThan(hero.y)
      expect(docked.y + docked.height).toBeGreaterThan(viewport.height - 120)
      await expect(composer).toBeEditable()
    } finally {
      await stopProxiedForge(page, forge)
    }
  })

test('live Markdown keeps the draft plain, continues lists, and undoes natively', async ({
  page,
}) => {
  const forge = await launchForge()
  try {
    const composer = await openDraft(page, forge)
    const layer = page.locator('#message-composer + [aria-hidden]')
    await composer.click()
    await page.keyboard.type('**bold** idea')
    await expect(layer.locator('.composer-md-strong')).toHaveText('bold')
    await expect(composer).toHaveValue('**bold** idea')
    await expect(composer).toHaveCSS('color', 'rgba(0, 0, 0, 0)')

    await composer.fill('')
    await page.keyboard.type('- one')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('two')
    await expect(composer).toHaveValue('- one\n- two')
    await page.keyboard.press('Tab')
    await expect(composer).toHaveValue('- one\n  - two')
    await expect(composer).toBeFocused()
    await page.keyboard.press('ControlOrMeta+z')
    await expect(composer).toHaveValue('- one\n- two')
    // Undo selects what it restored; continue from the end.
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.press('Shift+Enter')
    // An empty item ends the list.
    await expect(composer).toHaveValue('- one\n- two\n')
  } finally {
    await stopProxiedForge(page, forge)
  }
})

test('a staged image opens in the lightbox and focus returns to the composer', async ({
  page,
}) => {
  const forge = await launchForge()
  try {
    const composer = await openDraft(page, forge)
    await page
      .locator('input[type=file]')
      .setInputFiles([
        { name: 'tiny.png', mimeType: 'image/png', buffer: TINY_PNG },
      ])
    await page.getByRole('button', { name: 'Preview tiny.png' }).click()
    const lightbox = page.getByRole('dialog', { name: 'tiny.png' })
    await expect(lightbox).toBeVisible()
    await expect(lightbox.getByRole('img', { name: 'tiny.png' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(lightbox).toHaveCount(0)
    await expect(composer).toBeFocused()
  } finally {
    await stopProxiedForge(page, forge)
  }
})
