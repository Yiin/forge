import { expect, test } from '@playwright/test'
import {
  launchForge,
  proxyForgeApi,
  stopProxiedForge,
} from '../helpers/forgeServer.js'
test.use({ actionTimeout: 5000 })
test.describe.configure({ retries: 0 })
test('keeps an exited original terminal readable without resize errors on phone', async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== 'phone',
    'This regression covers the reported phone exit layout.',
  )
  const forge = await launchForge()
  try {
    await proxyForgeApi(page, forge)
    await page.addInitScript((baseUrl) => {
      const Original = window.WebSocket
      window.WebSocket = class extends Original {
        constructor(url: string | URL, protocols?: string | string[]) {
          const target = new URL(url, location.href)
          const base = new URL(baseUrl)
          target.host = base.host
          target.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
          super(target.toString(), protocols)
        }
      }
    }, forge.baseUrl)
    const projectResponse = await fetch(forge.baseUrl + '/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Terminal exit proof',
        path: forge.dataDir,
      }),
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
        title: 'Terminal exit',
      }),
    })
    expect(response.ok).toBe(true)
    const session = await response.json()

    await page.goto(`/s/${session.id}`)
    await page.getByRole('button', { name: 'Open workspace dock' }).click()
    await page
      .getByRole('menu', { name: 'Workspace surfaces' })
      .getByRole('button', { name: 'Terminal', exact: true })
      .click()
    await page.getByRole('button', { name: 'Create terminal' }).click()
    const endpoint = `${forge.baseUrl}/api/sessions/${session.id}/terminals`
    const list = async () => (await (await fetch(endpoint)).json()).terminals
    await expect.poll(async () => (await list())[0]?.state).toBe('running')
    const original = (await list())[0]
    const failures: number[] = []
    const resizeReplies: number[] = []
    page.on('response', (response) => {
      if (response.url().includes(`/terminals/${original.id}/resize`)) {
        resizeReplies.push(response.status())
        if (!response.ok()) failures.push(response.status())
      }
    })
    const input = page.locator('.xterm-helper-textarea')
    await input.focus()
    await input.evaluate((element) => {
      const clipboardData = new DataTransfer()
      clipboardData.setData(
        'text/plain',
        "printf 'ORIGINAL_EXIT_PROOF\\n'; exit",
      )
      element.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData,
          bubbles: true,
          cancelable: true,
        }),
      )
    })
    await page.keyboard.press('Enter')
    await expect(
      page.getByRole('status').filter({ hasText: 'Terminal exited' }),
    ).toBeVisible()
    await expect(page.locator('.xterm-accessibility-tree')).toContainText(
      'ORIGINAL_EXIT_PROOF',
    )
    const afterExit = resizeReplies.length
    await page.setViewportSize({ width: 320, height: 700 })
    await page.getByRole('button', { name: 'Hide workspace dock' }).click()
    await page.getByRole('button', { name: 'Open workspace dock' }).click()
    await page
      .getByRole('menu', { name: 'Workspace surfaces' })
      .getByRole('button', { name: 'Terminal', exact: true })
      .click()
    await expect(page.locator('.xterm-accessibility-tree')).toContainText(
      'ORIGINAL_EXIT_PROOF',
    )
    await expect(
      page.getByRole('status').filter({ hasText: 'Terminal exited' }),
    ).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(resizeReplies).toHaveLength(afterExit)
    expect(failures).toEqual([])
    expect((await list())[0].id).toBe(original.id)
    await page.screenshot({
      path: info.outputPath('phone-exited-terminal.png'),
    })
    await page
      .getByRole('button', { name: `Close ${original.title}`, exact: true })
      .click()
    await expect.poll(async () => (await list()).length).toBe(0)
  } finally {
    await stopProxiedForge(page, forge)
  }
})
