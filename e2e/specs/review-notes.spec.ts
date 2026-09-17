import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import {
  launchForge,
  proxyForgeApi,
  stopProxiedForge,
} from '../helpers/forgeServer.js'

test.describe.configure({ retries: 0 })
test('preserves and explicitly reanchors file notes before a failed then successful send', async ({
  page,
}) => {
  const forge = await launchForge()
  try {
    await proxyForgeApi(page, forge)
    const post = async (path: string, body: unknown) => {
      const response = await fetch(forge.baseUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.ok).toBe(true)
      return response.json()
    }
    const project = await post('/api/projects', {
      name: 'Review notes',
      path: forge.dataDir,
    })
    const create = () =>
      post('/api/sessions', {
        projectId: project.id,
        harness: 'mock',
        cwd: forge.dataDir,
        title: 'Review',
      })
    const session = await create(),
      other = await create()
    await writeFile(forge.dataDir + '/review.txt', 'original text\n')
    await page.goto(`/s/${session.id}`)
    await page.getByRole('button', { name: 'Open workspace dock' }).click()
    await page
      .getByRole('menu', { name: 'Workspace surfaces' })
      .getByRole('button', { name: 'Files', exact: true })
      .click()
    await page
      .getByRole('treeitem', { name: 'review.txt', exact: true })
      .click()
    await page
      .getByRole('textbox', { name: 'File review note' })
      .fill('Keep this exact note')
    await page
      .getByRole('button', { name: 'Add note at selected line' })
      .click()
    const notes = page.getByRole('region', { name: 'Review notes' })
    await expect(notes).toContainText('Keep this exact note')
    const saved = () =>
      page.evaluate(
        (id) => JSON.parse(localStorage.getItem('forge.review-notes.v1')!)[id],
        session.id,
      )
    const original = (await saved())[0]
    await page.goto(`/s/${other.id}`)
    await expect(notes).toHaveCount(0)
    await page.goto(`/s/${session.id}`)
    await expect(notes).toContainText('Keep this exact note')
    await writeFile(forge.dataDir + '/review.txt', 'changed text\n')
    await page
      .getByRole('treeitem', { name: 'review.txt', exact: true })
      .click()
    await expect(notes).toContainText('Stale anchor')
    expect((await saved())[0]).toEqual(original)
    await notes
      .getByRole('button', { name: 'Re-anchor note', exact: true })
      .click()
    await page
      .getByRole('button', { name: 'Re-anchor to selected file line' })
      .click()
    const reanchored = (await saved())[0]
    expect(reanchored.id).toBe(original.id)
    expect(reanchored.body).toBe(original.body)
    expect(reanchored.anchor.revision.contentHash).toBe(
      createHash('sha256').update('changed text\n').digest('hex'),
    )
    await expect(notes).not.toContainText('Stale anchor')
    await page
      .getByRole('button', { name: 'Hide workspace dock', exact: true })
      .click()
    const refused = '**/api/sessions/*/prompt'
    await page.route(refused, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"Synthetic admission refusal"}',
      }),
    )
    await page
      .getByRole('textbox', { name: 'Message composer' })
      .fill('Review this file')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(
      page.getByRole('textbox', { name: 'Message composer' }),
    ).toHaveValue('Review this file')
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: 'Synthetic admission refusal' }),
    ).toBeVisible()
    expect((await saved())[0]).toEqual(reanchored)
    await page.unroute(refused)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(notes).toHaveCount(0)
    const response = await fetch(
      forge.baseUrl + `/api/sessions/${session.id}/messages`,
    )
    expect(response.ok).toBe(true)
    const body = await response.json()
    const messages = body.messages ?? body
    const user = messages.find(
      (message: any) =>
        message.role === 'user' && message.content.reviewReferences?.length,
    )
    expect(user.content.reviewReferences).toEqual([reanchored])
    expect(user.content.text).toContain(reanchored.anchor.revision.contentHash)
  } finally {
    await stopProxiedForge(page, forge)
  }
})

test('keeps Git note revision through refresh until explicit reanchor', async ({
  page,
}) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { mkdir } = await import('node:fs/promises')
  const exec = promisify(execFile)
  const forge = await launchForge()
  try {
    const cwd = forge.dataDir + '/review-repo'
    await mkdir(cwd)
    const git = (...args: string[]) => exec('git', ['-C', cwd, ...args])
    await git('init', '-q')
    await git('config', 'user.name', 'Synthetic review')
    await git('config', 'user.email', 'review@example.invalid')
    await writeFile(cwd + '/example.txt', 'original line\n')
    await git('add', 'example.txt')
    await git('commit', '-qm', 'Synthetic original')
    await writeFile(cwd + '/example.txt', 'first edit\n')
    const post = async (path: string, body: unknown) => {
      const response = await fetch(forge.baseUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.ok).toBe(true)
      return response.json()
    }
    const project = await post('/api/projects', {
      name: 'Git notes',
      path: cwd,
    })
    const session = await post('/api/sessions', {
      projectId: project.id,
      harness: 'mock',
      cwd,
      title: 'Git notes',
    })
    await proxyForgeApi(page, forge)
    await page.goto(`/s/${session.id}`)
    await page.getByRole('button', { name: 'Open workspace dock' }).click()
    await page
      .getByRole('menu', { name: 'Workspace surfaces' })
      .getByRole('button', { name: 'Diff', exact: true })
      .click()
    await expect(
      page.getByRole('region', { name: 'Git changes' }),
    ).toContainText('first edit')
    page.once('dialog', (dialog) => dialog.accept('Keep original Git citation'))
    await page
      .getByRole('button', { name: 'Comment on old line 1', exact: true })
      .click()
    const notes = page.getByRole('region', { name: 'Review notes' })
    await expect(notes).toContainText('Keep original Git citation')
    const saved = () =>
      page.evaluate(
        (id) =>
          JSON.parse(localStorage.getItem('forge.review-notes.v1')!)[id][0],
        session.id,
      )
    const original = await saved()
    await writeFile(cwd + '/example.txt', 'second edit\n')
    await page.getByRole('button', { name: 'Refresh changes' }).click()
    await expect(
      page.getByRole('region', { name: 'Git changes' }),
    ).toContainText('second edit')
    await expect(notes).toContainText('Stale anchor')
    expect(await saved()).toEqual(original)
    await notes
      .getByRole('button', { name: 'Re-anchor note', exact: true })
      .click()
    await page
      .getByRole('button', { name: 'Comment on new line 1', exact: true })
      .click()
    const next = await saved()
    expect(next.id).toBe(original.id)
    expect(next.body).toBe(original.body)
    expect(next.anchor.revision.revision).not.toBe(
      original.anchor.revision.revision,
    )
    expect(next.anchor.side).toBe('new')
    await expect(notes).not.toContainText('Stale anchor')
    expect((await git('status', '--porcelain')).stdout.trim()).toBe(
      'M example.txt',
    )
  } finally {
    await stopProxiedForge(page, forge)
  }
})

test('keeps a late file hash under its original session without changing the current reanchor', async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== 'desktop',
    'This held callback proof uses direct sidebar navigation.',
  )
  const forge = await launchForge()
  try {
    await proxyForgeApi(page, forge)
    const post = async (path: string, body: unknown) => {
      const response = await fetch(forge.baseUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.ok).toBe(true)
      return response.json()
    }
    const project = await post('/api/projects', {
      name: 'Held note',
      path: forge.dataDir,
    })
    const first = await post('/api/sessions', {
      projectId: project.id,
      harness: 'mock',
      cwd: forge.dataDir,
      title: 'First anchor owner',
    })
    const second = await post('/api/sessions', {
      projectId: project.id,
      harness: 'mock',
      cwd: forge.dataDir,
      title: 'Second anchor owner',
    })
    await writeFile(forge.dataDir + '/held.txt', 'saved text\n')
    await page.goto(`/s/${first.id}`)
    const openFile = async () => {
      await page.getByRole('button', { name: 'Open workspace dock' }).click()
      await page
        .getByRole('menu', { name: 'Workspace surfaces' })
        .getByRole('button', { name: 'Files', exact: true })
        .click()
      await page
        .getByRole('treeitem', { name: 'held.txt', exact: true })
        .click()
    }
    await openFile()
    await page.locator('.cm-content').fill('first unsaved text')
    await page
      .getByRole('textbox', { name: 'File review note' })
      .fill('Original held note')
    await page.evaluate(() => {
      const digest = crypto.subtle.digest.bind(crypto.subtle)
      crypto.subtle.digest = ((...args: Parameters<typeof digest>) => {
        crypto.subtle.digest = digest
        return new Promise<ArrayBuffer>((resolve, reject) => {
          digest(...args).then((value) => {
            ;(window as any).releaseReviewHash = () => resolve(value)
          }, reject)
        })
      }) as typeof digest
    })
    await page
      .getByRole('button', { name: 'Add note at selected line' })
      .click()
    await expect
      .poll(() => page.evaluate(() => typeof (window as any).releaseReviewHash))
      .toBe('function')
    await page
      .getByRole('button', { name: /^(?:\d+ )?Second anchor owner/ })
      .click()
    await expect(page).toHaveURL(new RegExp(`/s/${second.id}$`))
    await openFile()
    await page
      .getByRole('textbox', { name: 'File review note' })
      .fill('Current second note')
    await page
      .getByRole('button', { name: 'Add note at selected line' })
      .click()
    await page.locator('.cm-content').fill('second changed text')
    const notes = page.getByRole('region', { name: 'Review notes' })
    await expect(notes).toContainText('Stale anchor')
    await notes
      .getByRole('button', { name: 'Re-anchor note', exact: true })
      .click()
    await page.evaluate(() => (window as any).releaseReviewHash())
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            JSON.parse(localStorage.getItem('forge.review-notes.v1')!)[id]?.[0]
              ?.body,
          first.id,
        ),
      )
      .toBe('Original held note')
    await expect(notes).toContainText('Current second note')
    await expect(notes).toContainText('Stale anchor')
    await expect(notes).toContainText('Select a current Git or file line')
    await expect(notes).not.toContainText('Original held note')
  } finally {
    await page
      .evaluate(() => (window as any).releaseReviewHash?.())
      .catch(() => {})
    await stopProxiedForge(page, forge)
  }
})
