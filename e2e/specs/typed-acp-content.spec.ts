import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  launchForge,
  proxyForgeApi,
  stopProxiedForge,
  type ForgeServer,
} from '../helpers/forgeServer.js'

test.describe.configure({ retries: 0 })
test.use({ actionTimeout: 5000 })
for (const scenario of [
  'media',
  'late-child-retirement',
  'plan-updates',
] as const) {
  test(`shows typed ACP ${scenario} through production replay`, async ({
    page,
  }) => {
    const directory = await mkdtemp('/tmp/forge-typed-acp-browser-')
    let forge: ForgeServer | undefined
    try {
      forge = await launchForge({
        fakeAcp: {
          profile: scenario === 'late-child-retirement' ? 'grok' : 'custom',
          scenario,
          directory,
        },
      })
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
        body: JSON.stringify({
          name: 'Typed ACP project',
          path: forge.dataDir,
        }),
      })
      expect(projectResponse.ok).toBe(true)
      const project = await projectResponse.json()
      const created = await fetch(forge.baseUrl + '/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          harness: scenario === 'late-child-retirement' ? 'grok' : 'qa-acp',
          cwd: forge.dataDir,
          accountId: null,
          title: 'Typed ACP browser',
        }),
      })
      expect(created.ok, await created.clone().text()).toBe(true)
      const session = await created.json()
      await page.goto(`/s/${session.id}`)
      await page
        .getByLabel('Message composer')
        .fill('Synthetic typed ACP content')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      if (scenario === 'media') {
        for (const reload of [false, true]) {
          if (reload) await page.reload()
          await page
            .getByRole('button', { name: /Content block.*image/i })
            .click()
          const image = page.getByRole('img', { name: 'Agent image' })
          await expect
            .poll(() =>
              image.evaluate(
                (node: HTMLImageElement) =>
                  node.complete && node.naturalWidth > 0,
              ),
            )
            .toBe(true)
          const download = page.getByRole('link', { name: 'Download image' })
          const href = await download.getAttribute('href')
          expect(href).toContain(`/api/sessions/${session.id}/acp-artifacts/`)
          const response = await page.request.get(forge.baseUrl + href)
          expect(response.ok()).toBe(true)
          expect(response.headers()['content-type']).toContain('image/png')
          expect([...(await response.body()).subarray(0, 8)]).toEqual([
            137, 80, 78, 71, 13, 10, 26, 10,
          ])
        }
      } else if (scenario === 'plan-updates') {
        const plans = async () => {
          const snapshot = await (
            await fetch(forge!.baseUrl + `/api/sessions/${session.id}/messages`)
          ).json()
          expect(
            snapshot.messages.filter(
              (row: { content: { type: string } }) =>
                row.content.type === 'ask_user_question',
            ),
          ).toEqual([])
          return snapshot.messages.filter(
            (row: { content: { type: string } }) => row.content.type === 'plan',
          )
        }
        await expect
          .poll(async () => (await plans()).at(-1)?.content.steps[0].status)
          .toBe('running')
        await expect(
          page.getByText('Verify fixture plan', { exact: true }),
        ).toBeVisible()
        await expect(
          page.getByRole('region', { name: 'Tool permission request' }),
        ).toHaveCount(0)
        await writeFile(join(directory, 'finish-plan'), '')
        await expect
          .poll(
            async () =>
              (
                await (
                  await fetch(forge!.baseUrl + `/api/sessions/${session.id}`)
                ).json()
              ).status,
          )
          .toBe('idle')
        await expect
          .poll(async () => (await plans()).at(-1)?.content.steps[0].status)
          .toBe('completed')
        const evidence = await plans()
        expect(
          evidence.map(
            (row: { content: { steps: { status: string }[] } }) =>
              row.content.steps[0].status,
          ),
        ).toEqual(['running', 'completed'])
        await page.reload()
        await expect(
          page.getByText('Verify fixture plan', { exact: true }),
        ).toBeVisible()
        await expect(
          page.getByRole('region', { name: 'Tool permission request' }),
        ).toHaveCount(0)
      } else {
        const parent = page.locator('.chat-timeline')
        await expect(parent).toContainText('Root 1.')
        await expect
          .poll(
            async () =>
              (
                await (
                  await fetch(forge!.baseUrl + `/api/sessions/${session.id}`)
                ).json()
              ).status,
          )
          .toBe('idle')
        const [childPage] = await Promise.all([
          page.waitForResponse(
            (response) =>
              response.url().includes('/native-children/') &&
              response.url().includes('/messages?'),
          ),
          parent
            .getByRole('button', { name: 'Open child transcript', exact: true })
            .click(),
        ])
        expect(childPage.ok()).toBe(true)
        const endpoint = new URL(childPage.url()).pathname
        expect(endpoint).toContain(
          `/api/sessions/${session.id}/native-children/`,
        )
        const child = page.getByLabel('Subagent transcript')
        await expect(child).not.toContainText('Root 1.')
        await writeFile(join(directory, 'finish-child-1'), '')
        await expect(child).toContainText('Late child-1.')
        const childId = decodeURIComponent(endpoint.split('/').at(-2)!)
        await expect
          .poll(async () => {
            const snapshot = await (
              await fetch(
                forge!.baseUrl + `/api/sessions/${session.id}/messages`,
              )
            ).json()
            return snapshot.messages.some(
              (row: {
                content: {
                  type: string
                  nativeChildId?: string
                  status?: string
                }
              }) =>
                row.content.type === 'tool_update' &&
                row.content.nativeChildId === childId &&
                row.content.status === 'completed',
            )
          })
          .toBe(true)
        await expect(parent).not.toContainText('Late child-1.')
        await expect
          .poll(
            async () =>
              (
                await (
                  await fetch(forge!.baseUrl + `/api/sessions/${session.id}`)
                ).json()
              ).status,
          )
          .toBe('idle')
        await page.reload()
        await expect(page.getByLabel('Subagent transcript')).toContainText(
          'Late child-1.',
        )
        await expect(page.locator('.chat-timeline')).not.toContainText(
          'Late child-1.',
        )
      }
    } finally {
      if (forge) await stopProxiedForge(page, forge)
      await rm(directory, { recursive: true, force: true })
    }
  })
}
