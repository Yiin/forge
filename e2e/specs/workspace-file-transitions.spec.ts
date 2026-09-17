import { readFile, writeFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import {
  launchForge,
  proxyForgeApi,
  stopProxiedForge,
} from '../helpers/forgeServer.js'

test.use({ actionTimeout: 5000 })
test.describe.configure({ retries: 0 })

test('preserves the original Cancel then Save-and-open file transition', async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== 'desktop',
    'The reported transition uses the desktop split editor.',
  )
  const forge = await launchForge()
  try {
    await proxyForgeApi(page, forge)
    const projectResponse = await fetch(forge.baseUrl + '/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'File transition proof',
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
        title: 'File transition',
      }),
    })
    expect(response.ok).toBe(true)
    const session = await response.json()

    await writeFile(forge.dataDir + '/parity-a.txt', 'Original A\n')
    await writeFile(forge.dataDir + '/parity-b.txt', 'Original B\n')
    await page.goto(`/s/${session.id}`)
    await page.getByRole('button', { name: 'Open workspace dock' }).click()
    await page
      .getByRole('menu', { name: 'Workspace surfaces' })
      .getByRole('button', { name: 'Files', exact: true })
      .click()
    const editor = page.locator('.cm-content')
    for (let index = 0; index < 3; index++) {
      await page
        .getByRole('treeitem', { name: 'parity-a.txt', exact: true })
        .click()
      await expect(
        page.getByRole('region', { name: 'Editor for parity-a.txt' }),
      ).toBeVisible()
      await editor.fill(`Saved through the real editor ${index}`)
      await page
        .getByRole('treeitem', { name: 'parity-b.txt', exact: true })
        .click()
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Cancel', exact: true })
        .click()
      await expect(editor).toContainText(
        `Saved through the real editor ${index}`,
      )
      await page
        .getByRole('treeitem', { name: 'parity-b.txt', exact: true })
        .click()
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Save', exact: true })
        .click()
      await expect(editor).toContainText('Original B')
      expect(await readFile(forge.dataDir + '/parity-a.txt', 'utf8')).toBe(
        `Saved through the real editor ${index}`,
      )
    }
  } finally {
    await stopProxiedForge(page, forge)
  }
})
