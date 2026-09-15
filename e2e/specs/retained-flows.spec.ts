import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  launchForge,
  proxyForgeApi,
  stopProxiedForge,
  type ForgeServer,
} from '../helpers/forgeServer.js'

test.describe.configure({ retries: 0 })
test.use({ actionTimeout: 5000 })
async function connect(page: Page, forge: ForgeServer) {
  await proxyForgeApi(page, forge)
  await page.addInitScript((url) => {
    const Original = window.WebSocket
    window.WebSocket = class extends Original {
      constructor(_url: string | URL, protocols?: string | string[]) {
        super(url.replace(/^http/, 'ws') + '/ws', protocols)
      }
    }
  }, forge.baseUrl)
}
async function api(forge: ForgeServer, path: string, value?: unknown) {
  const response = await fetch(
    forge.baseUrl + path,
    value === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(value),
        },
  )
  expect(response.ok, `${path}: ${response.status}`).toBe(true)
  return response.json()
}

for (const flow of ['search', 'fork/archive'] as const)
  test(`retains ${flow} through reload`, async ({ page }) => {
    const forge = await launchForge()
    try {
      await connect(page, forge)
      const project = await api(forge, '/api/projects', {
        name: 'Retained project',
        path: forge.dataDir,
      })
      const session = await api(forge, '/api/sessions', {
        projectId: project.id,
        harness: 'mock',
        cwd: forge.dataDir,
        title: 'Retained original',
      })
      await page.goto(`/s/${session.id}`)
      await page.getByLabel('Message composer').fill('retained-needle-original')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(
        page.getByRole('button', { name: 'Branch from here' }).first(),
      ).toBeVisible()
      if (flow === 'search') {
        await page.goto('/search?q=retained-needle-original&scope=messages')
        await expect(page.locator('.search-result').first()).toBeVisible()
        await page.reload()
        await expect(page.locator('.search-result').first()).toBeVisible()
        await page.locator('.search-result').first().click()
        await expect(page).toHaveURL(new RegExp(`/s/${session.id}`))
        return
      }
      await page
        .getByRole('button', { name: 'Branch from here' })
        .first()
        .click()
      await expect(page).not.toHaveURL(new RegExp(`/s/${session.id}`))
      const branchId = new URL(page.url()).pathname.split('/').at(-1)!
      await expect(page.getByLabel('Message composer')).toBeVisible()
      const branch = await api(forge, `/api/sessions/${branchId}`)
      expect(branch.parentSessionId).toBe(session.id)
      expect(branch.forkedAtSeq).toBeGreaterThan(0)
      await page.reload()
      await expect(page.getByLabel('Message composer')).toBeVisible()
      expect(
        (await api(forge, `/api/sessions/${branchId}`)).parentSessionId,
      ).toBe(session.id)
      await page
        .getByRole('button', { name: `Actions for ${branch.title}` })
        .click()
      await page.getByRole('menuitem', { name: 'Settle', exact: true }).click()
      await expect
        .poll(
          async () => (await api(forge, `/api/sessions/${branchId}`)).status,
        )
        .toBe('archived')
      await page.reload()
      await page
        .getByRole('button', { name: `Actions for ${branch.title}` })
        .click()
      await page
        .getByRole('menuitem', { name: 'Un-settle', exact: true })
        .click()
      await expect
        .poll(
          async () => (await api(forge, `/api/sessions/${branchId}`)).status,
        )
        .toBe('idle')
      await page.reload()
      expect(
        (await api(forge, `/api/sessions/${branchId}`)).parentSessionId,
      ).toBe(session.id)
    } finally {
      await stopProxiedForge(page, forge)
    }
  })

test('requests notification permission only by gesture and rejects shortcut conflicts', async ({
  page,
}) => {
  const forge = await launchForge()
  try {
    await connect(page, forge)
    await page.addInitScript(() => {
      class NotificationFixture {
        static permission = 'default'
        static requestPermission = async () => {
          sessionStorage.setItem(
            'permissionRequests',
            String(
              Number(sessionStorage.getItem('permissionRequests') ?? 0) + 1,
            ),
          )
          NotificationFixture.permission = 'granted'
          return 'granted'
        }
      }
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: NotificationFixture,
      })
    })
    await page.goto('/settings/notifications')
    expect(
      await page.evaluate(() => sessionStorage.getItem('permissionRequests')),
    ).toBeNull()
    await page.getByRole('button', { name: 'Allow notifications' }).click()
    await expect(
      page.getByRole('button', { name: 'Allowed', exact: true }),
    ).toBeDisabled()
    expect(
      await page.evaluate(() => sessionStorage.getItem('permissionRequests')),
    ).toBe('1')
    const toggle = page.getByRole('switch', {
      name: 'Notify on run completion',
    })
    await toggle.click()
    const checked = await toggle.isChecked()
    await page.reload()
    await expect(toggle).toBeChecked({ checked })
    expect(
      await page.evaluate(() => sessionStorage.getItem('permissionRequests')),
    ).toBe('1')
    await page.goto('/settings/shortcuts')
    await page.getByLabel('Search keybindings').fill('New session')
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Capture shortcut for New session').focus()
    await page.keyboard.press('Control+k')
    await expect(page.getByText(/Conflicts with/)).toBeVisible()
    await page.keyboard.press('Escape')
  } finally {
    await stopProxiedForge(page, forge)
  }
})

test('keeps child history active after its parent stops and settles only its own runtime', async ({
  page,
}) => {
  const forge = await launchForge({
    fakeAgentEnv: { FORGE_MOCK_HANG_PROMPT: '1' },
  })
  try {
    await connect(page, forge)
    const project = await api(forge, '/api/projects', {
      name: 'Child project',
      path: forge.dataDir,
    })
    const parent = await api(forge, '/api/sessions', {
      projectId: project.id,
      harness: 'mock',
      cwd: forge.dataDir,
      title: 'Parent work',
    })
    const child = await api(forge, '/api/sessions', {
      projectId: project.id,
      harness: 'mock',
      cwd: forge.dataDir,
      title: 'Independent child',
      kind: 'subagent',
      parentSessionId: parent.id,
    })
    await api(forge, `/api/sessions/${parent.id}/prompt`, {
      text: 'Parent held work',
    })
    await api(forge, `/api/sessions/${child.id}/prompt`, {
      text: 'Child held work',
    })
    for (const id of [parent.id, child.id])
      await expect
        .poll(
          async () =>
            (await api(forge, `/api/sessions/${id}`)).providerSessionId,
        )
        .toBeTruthy()
    await expect
      .poll(
        async () =>
          (await api(forge, '/api/harnesses/health')).find(
            (row: { key: string }) => row.key === 'mock',
          ).liveProcesses,
      )
      .toBe(2)
    await page.goto(`/s/${parent.id}`)
    const card = page.locator('.subagent-card')
    await expect(card).toContainText('Independent child')
    await card.getByRole('button').first().click()
    await expect(card).toContainText('Child held work')
    await api(forge, `/api/sessions/${parent.id}/interrupt`, {})
    await expect
      .poll(async () => (await api(forge, `/api/sessions/${parent.id}`)).status)
      .not.toBe('running')
    expect((await api(forge, `/api/sessions/${child.id}`)).status).toBe(
      'running',
    )
    await expect(card).toHaveAttribute('data-subagent-status', 'running')
    await page.reload()
    await expect(card).toContainText('Independent child')
    await card.getByRole('button').first().click()
    await expect(card).toContainText('Child held work')
    await api(forge, `/api/sessions/${child.id}/interrupt`, {})
    await expect
      .poll(async () => (await api(forge, `/api/sessions/${child.id}`)).status)
      .not.toBe('running')
    await expect(card).not.toHaveAttribute('data-subagent-status', 'running')
    await page.reload()
    await card.getByRole('button').first().click()
    await expect(card).toContainText('Child held work')
  } finally {
    await stopProxiedForge(page, forge)
  }
})

test('saves one isolated account without changing its sibling', async ({
  page,
}) => {
  const forge = await launchForge()
  try {
    await connect(page, forge)
    const first = await api(forge, '/api/harness-accounts', {
      harnessKey: 'mock',
      kind: 'mock',
      adapterKind: 'acp',
      label: 'Account alpha',
    })
    const second = await api(forge, '/api/harness-accounts', {
      harnessKey: 'mock',
      kind: 'mock',
      adapterKind: 'acp',
      label: 'Account beta',
    })
    expect(first.homePath).not.toBe(second.homePath)
    expect(first.homePath.startsWith(forge.dataDir + '/')).toBe(true)
    expect(second.homePath.startsWith(forge.dataDir + '/')).toBe(true)
    await page.goto('/settings/accounts')
    await page
      .getByRole('button', { name: 'Toggle Account alpha details' })
      .click()
    const firstLabel = page.locator('input[value="Account alpha"]')
    await firstLabel.fill('Account alpha renamed')
    await page.getByRole('heading', { name: 'Harnesses', level: 1 }).click()
    await expect
      .poll(
        async () =>
          (await api(forge, '/api/harness-accounts')).find(
            (account: { id: string }) => account.id === first.id,
          )?.label,
      )
      .toBe('Account alpha renamed')
    await page.reload()
    await page
      .getByRole('button', { name: 'Toggle Account alpha renamed details' })
      .click()
    await expect(
      page.locator('input[value="Account alpha renamed"]'),
    ).toBeVisible()
    await page
      .getByRole('button', { name: 'Toggle Account beta details' })
      .click()
    await expect(page.locator('input[value="Account beta"]')).toBeVisible()
    const accounts = await api(forge, '/api/harness-accounts')
    expect(
      accounts.find((account: { id: string }) => account.id === second.id),
    ).toMatchObject({ label: 'Account beta', homePath: second.homePath })
  } finally {
    await stopProxiedForge(page, forge)
  }
})

test('keeps a populated epic running until its original native worker completes', async ({
  page,
}) => {
  const directory = await mkdtemp('/tmp/forge-retained-epic-')
  const dataDir = join(directory, 'data'),
    peer = join(directory, 'peer'),
    bin = join(directory, 'bin')
  await Promise.all([mkdir(dataDir), mkdir(peer), mkdir(bin)])
  await writeFile(
    join(bin, 'bd'),
    `#!${process.execPath}
const fs=require('node:fs'), path=require('node:path');
const root=${JSON.stringify(peer)}, args=process.argv.slice(2), closed=fs.existsSync(path.join(root,'bead-closed'));
const bead=id=>({id,title:id==='retained-epic'?'Retained epic':'Retained worker',description:id==='retained-epic'?'Retained epic browser proof':'Synthetic worker',status:closed?'closed':'open',priority:1,labels:[],dependencies:[]});
if(args[0]==='show')console.log(JSON.stringify([bead(args[1])]));
else if(args[0]==='ready'||args[0]==='list')console.log(JSON.stringify(closed?[]:[bead('retained-child')]));
else if(args[0]==='update')console.log('{}');
else if(args[0]==='comments')console.log(JSON.stringify([{created_at:new Date().toISOString(),text:'Synthetic original worker evidence'}]));
else {console.error('Unexpected fixture bd operation');process.exitCode=2;}
`,
    { mode: 0o700 },
  )
  await writeFile(
    join(peer, 'scenario.json'),
    JSON.stringify({
      actions: [
        {
          send: {
            type: 'system',
            subtype: 'init',
            session_id: '$session',
            claude_code_version: '2.1.258',
            capabilities: ['msg_lifecycle_v1', 'interrupt_cancel_queued_v1'],
          },
        },
        { expect: { type: 'user' }, capture: 'user' },
        {
          send: {
            type: 'command_lifecycle',
            command_uuid: '$user.uuid',
            state: 'started',
            uuid: '$new',
            session_id: '$session',
          },
        },
        {
          send: {
            type: 'assistant',
            message: {
              id: '$new',
              content: [{ type: 'text', text: 'Retained worker visible' }],
            },
            uuid: '$new',
          },
        },
        { mark: 'bead-closed', wait: 'release-result' },
        {
          send: {
            type: 'result',
            subtype: 'success',
            session_id: '$session',
            usage: { input_tokens: 1, output_tokens: 1 },
            uuid: '$new',
          },
        },
      ],
    }),
  )
  let forge: ForgeServer | undefined
  try {
    forge = await launchForge({
      dataDir,
      fakeNative: { kind: 'claude', directory: peer },
      env: { PATH: `${bin}:${process.env.PATH}` },
    })
    await connect(page, forge)
    const project = await api(forge, '/api/projects', {
      name: 'Retained run project',
      path: dataDir,
    })
    const run = await api(forge, '/api/epics/start', {
      projectId: project.id,
      epicBeadId: 'retained-epic',
      mode: 'serial',
      baseBranch: 'main',
      config: {
        rolePolicy: {
          roles: { 'iteration-worker': 'fixture' },
          tiers: { fixture: [{ harness: 'claude' }] },
        },
      },
    })
    await expect
      .poll(() => readFile(join(peer, 'bead-closed'), 'utf8').catch(() => ''))
      .toBe('ready')
    await page.goto('/runs')
    await expect(
      page.getByRole('main').getByText('Retained epic browser proof'),
    ).toBeVisible()
    const pending = await api(forge, `/api/epics/${run.id}`)
    expect(pending.status).toBe('running')
    expect(pending.iterations).toHaveLength(1)
    expect(pending.iterations[0].status).toBe('running')
    await writeFile(join(peer, 'release-result'), '')
    await expect
      .poll(async () => (await api(forge!, `/api/epics/${run.id}`)).status)
      .toBe('completed')
    await page.reload()
    await expect(
      page.getByRole('main').getByText('Retained epic browser proof'),
    ).toBeVisible()
    const completed = await api(forge, `/api/epics/${run.id}`)
    expect(completed.iterations[0].status).toBe('merged')
    expect(completed.iterations[0].sessionId).toBe(
      pending.iterations[0].sessionId,
    )
    await page.goto(`/s/${completed.iterations[0].sessionId}`)
    await expect(
      page.getByText('Retained worker visible', { exact: true }),
    ).toBeVisible()
    await page.reload()
    await expect(
      page.getByText('Retained worker visible', { exact: true }),
    ).toBeVisible()
  } finally {
    try {
      await writeFile(join(peer, 'release-result'), '')
    } finally {
      if (forge) await stopProxiedForge(page, forge)
    }
    await rm(directory, { recursive: true, force: true })
  }
})
