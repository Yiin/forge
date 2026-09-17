import { expect, test, type Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  launchForge,
  proxyForgeApi,
  stopProxiedForge,
  type ForgeServer,
} from '../helpers/forgeServer.js'

test.describe.configure({ retries: 0 })
test.use({ actionTimeout: 5000 })
const init = {
  send: {
    type: 'system',
    subtype: 'init',
    session_id: '$session',
    claude_code_version: '2.1.258',
    capabilities: ['msg_lifecycle_v1', 'interrupt_cancel_queued_v1'],
  },
}
const start = [
  { expect: { type: 'user', message: { role: 'user' } }, capture: 'user' },
  {
    send: {
      type: 'command_lifecycle',
      command_uuid: '$user.uuid',
      state: 'started',
      uuid: '$new',
      session_id: '$session',
    },
  },
]
const text = (value: string) => ({
  send: {
    type: 'assistant',
    uuid: '$new',
    message: { id: '$new', content: [{ type: 'text', text: value }] },
  },
})
const finish = {
  send: {
    type: 'result',
    subtype: 'success',
    session_id: '$session',
    usage: { input_tokens: 1, output_tokens: 1 },
    uuid: '$new',
  },
}
const request = (id: string, tool: string, input: unknown) => ({
  send: {
    type: 'control_request',
    request_id: id,
    request: {
      subtype: 'can_use_tool',
      tool_name: tool,
      tool_use_id: id,
      input,
    },
  },
})
const answered = (id: string, behavior = 'allow') => ({
  expect: {
    type: 'control_response',
    response: { subtype: 'success', request_id: id, response: { behavior } },
  },
})
async function wire(peer: string) {
  return (await readFile(join(peer, 'stdin.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}
async function setup(page: Page, actions: unknown[]) {
  const directory = await mkdtemp('/tmp/forge-native-retained-')
  const peer = join(directory, 'peer'),
    dataDir = join(directory, 'data')
  await mkdir(peer)
  await mkdir(dataDir)
  await writeFile(join(peer, 'scenario.json'), JSON.stringify({ actions }))
  let forge: ForgeServer | undefined
  try {
    forge = await launchForge({
      dataDir,
      fakeNative: { kind: 'claude', directory: peer },
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
      body: JSON.stringify({ name: 'Retained native', path: dataDir }),
    })
    expect(projectResponse.ok).toBe(true)
    const project = await projectResponse.json()
    const response = await fetch(forge.baseUrl + '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        harness: 'claude',
        cwd: dataDir,
        title: 'Native retained controls',
      }),
    })
    expect(response.ok, await response.clone().text()).toBe(true)
    const session = await response.json()
    await page.goto(`/s/${session.id}`)
    await page.getByLabel('Message composer').fill('Start retained controls')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    return {
      forge,
      peer,
      session,
      directory,
      close: async () => {
        await stopProxiedForge(page, forge!)
        await rm(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    if (forge) await stopProxiedForge(page, forge)
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

test('edits reorders removes and sends the original queued native message', async ({
  page,
}) => {
  const fixture = await setup(page, [
    init,
    ...start,
    text('Original turn held'),
    {
      expect: {
        type: 'user',
        message: { content: [{ type: 'text', text: 'Queue beta edited' }] },
      },
      capture: 'steer',
    },
    { mark: 'steer-received' },
    { wait: 'finish' },
    text('Queue controls complete'),
    finish,
  ])
  try {
    await expect(
      page.getByText('Original turn held', { exact: true }),
    ).toBeVisible()
    for (const value of ['Queue alpha', 'Queue beta', 'Queue remove']) {
      await page.getByLabel('Message composer').fill(value)
      await page
        .getByRole('button', { name: 'Queue message', exact: true })
        .click()
    }
    const row = (value: string) =>
      page.locator(`[title="${value}"]`).locator('..')
    await row('Queue beta')
      .getByRole('button', { name: 'Edit queued message' })
      .click()
    await expect(page.getByLabel('Message composer')).toHaveValue('Queue beta')
    await page.getByLabel('Message composer').fill('Queue beta edited')
    await page
      .getByRole('button', { name: 'Queue message', exact: true })
      .click()
    await row('Queue beta edited')
      .getByRole('button', { name: 'Move queued message up' })
      .click()
    await row('Queue beta edited')
      .getByRole('button', { name: 'Move queued message up' })
      .click()
    await row('Queue remove')
      .getByRole('button', { name: 'Remove queued message' })
      .click()
    await page.reload()
    const queued = page.locator('.composer-root span[title]')
    await expect(queued).toHaveText(['Queue beta edited', 'Queue alpha'])
    expect(
      (await wire(fixture.peer)).filter((frame) => frame.type === 'user'),
    ).toHaveLength(1)
    await row('Queue beta edited')
      .getByRole('button', { name: 'Send queued message now' })
      .click()
    await expect
      .poll(() =>
        readFile(join(fixture.peer, 'steer-received'), 'utf8').catch(
          () => null,
        ),
      )
      .toBe('ready')
    await expect(queued).toHaveText(['Queue alpha'])
    await row('Queue alpha')
      .getByRole('button', { name: 'Remove queued message' })
      .click()
    await writeFile(join(fixture.peer, 'finish'), '')
    await expect(
      page.getByText('Queue controls complete', { exact: true }),
    ).toBeVisible()
    const users = (await wire(fixture.peer)).filter(
      (frame) => frame.type === 'user',
    )
    expect(users).toHaveLength(2)
    expect(users[1].message.content).toEqual([
      { type: 'text', text: 'Queue beta edited' },
    ])
  } finally {
    await fixture.close()
  }
})

test('answers three native pages with Back keys and reload then denies an approval', async ({
  page,
}) => {
  const questions = [
    {
      question: 'Choose one',
      header: 'First',
      options: [
        { label: 'Alpha', description: 'First option' },
        { label: 'Beta', description: 'Second option' },
      ],
    },
    {
      question: 'Choose several',
      header: 'Second',
      multiSelect: true,
      options: [{ label: 'Red' }, { label: 'Blue' }],
    },
    { question: 'Explain choice', header: 'Third', options: [] },
  ]
  const fixture = await setup(page, [
    init,
    ...start,
    request('three-pages', 'AskUserQuestion', { questions }),
    answered('three-pages'),
    request('deny-original', 'Bash', {
      command: 'forbidden synthetic command',
    }),
    answered('deny-original', 'deny'),
    text('Denied permission retained'),
    finish,
  ])
  try {
    const panel = page.getByRole('region', { name: 'Question from Forge' })
    await expect(panel.getByText('Choose one', { exact: true })).toBeVisible()
    await panel.getByRole('heading', { name: 'Choose one' }).click()
    await page.keyboard.press('1')
    await expect(
      panel.getByText('Choose several', { exact: true }),
    ).toBeVisible()
    await panel.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(panel.getByText('Choose one', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Next', exact: true }).click()
    await panel.getByRole('heading', { name: 'Choose several' }).click()
    await page.keyboard.press('1')
    await page.keyboard.press('2')
    await panel.getByRole('button', { name: 'Next', exact: true }).click()
    await panel.getByLabel('Additional answer').fill('Saved native explanation')
    await page.reload()
    await expect(panel.getByText('Choose one', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Next', exact: true }).click()
    await panel.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(
      panel.getByText('Explain choice', { exact: true }),
    ).toBeVisible()
    await expect(panel.getByLabel('Additional answer')).toHaveValue(
      'Saved native explanation',
    )
    await panel.getByRole('button', { name: 'Submit', exact: true }).click()
    const permission = page.getByRole('region', {
      name: 'Tool permission request',
    })
    await expect(permission).toBeVisible()
    await permission.getByRole('button', { name: /Deny/ }).click()
    await permission
      .getByRole('button', { name: 'Submit', exact: true })
      .click()
    await expect(
      page.getByText('Denied permission retained', { exact: true }),
    ).toBeVisible()
    const replies = (await wire(fixture.peer)).filter(
      (frame) => frame.type === 'control_response',
    )
    expect(replies.map((frame) => frame.response.request_id)).toEqual([
      'three-pages',
      'deny-original',
    ])
    expect(replies[0].response.response.updatedInput.answers).toEqual({
      'Choose one': 'Alpha',
      'Choose several': 'Red, Blue',
      'Explain choice': 'Saved native explanation',
    })
    expect(replies[1].response.response.behavior).toBe('deny')
  } finally {
    await fixture.close()
  }
})

test('expires a native request and rejects its old identity after explicit reissue', async ({
  page,
}) => {
  const input = {
    questions: [
      { question: 'Original expiring question', header: 'Expiry', options: [] },
    ],
  }
  const fixture = await setup(page, [
    init,
    ...start,
    request('reused-native-id', 'AskUserQuestion', input),
    { wait: 'exit-original' },
    { exit: 0 },
  ])
  try {
    const panel = page.getByRole('region', { name: 'Question from Forge' })
    await expect(
      panel.getByText('Original expiring question', { exact: true }),
    ).toBeVisible()
    await panel.getByLabel('Additional answer').fill('Retained unsent answer')
    const snapshot = async () =>
      (
        await (
          await fetch(
            fixture.forge.baseUrl +
              `/api/sessions/${fixture.session.id}/messages`,
          )
        ).json()
      ).messages
    const original = (await snapshot()).find(
      (row: { content: { type: string } }) =>
        row.content.type === 'ask_user_question',
    ).content.questionId
    await writeFile(join(fixture.peer, 'exit-original'), '')
    await expect(
      page
        .locator('.chat-answered-question')
        .getByText('Expired', { exact: true }),
    ).toBeVisible()
    await expect(panel).toHaveCount(0)
    await page.reload()
    await expect(
      page
        .locator('.chat-answered-question')
        .getByText('Expired', { exact: true }),
    ).toBeVisible()
    expect(
      await page.evaluate(() =>
        Object.entries(sessionStorage).some(
          ([key, value]) =>
            key.startsWith('forge:question:') &&
            value.includes('Retained unsent answer'),
        ),
      ),
    ).toBe(true)
    await writeFile(
      join(fixture.peer, 'scenario.json'),
      JSON.stringify({
        actions: [
          init,
          ...start,
          request('reused-native-id', 'AskUserQuestion', {
            questions: [
              {
                question: 'Explicitly reissued question',
                header: 'New runtime',
                options: [],
              },
            ],
          }),
          answered('reused-native-id'),
          text('Reissued answer complete'),
          finish,
        ],
      }),
    )
    await page.getByLabel('Message composer').fill('Request a new runtime')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(
      panel.getByText('Explicitly reissued question', { exact: true }),
    ).toBeVisible()
    const current = (await snapshot())
      .filter(
        (row: { content: { type: string } }) =>
          row.content.type === 'ask_user_question',
      )
      .at(-1).content.questionId
    expect(current).not.toBe(original)
    const rejected = await fetch(
      fixture.forge.baseUrl +
        `/api/sessions/${fixture.session.id}/questions/${encodeURIComponent(original)}/answer`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: 'stale reply' }),
      },
    )
    expect([409, 410]).toContain(rejected.status)
    await expect(panel.getByLabel('Additional answer')).toHaveValue('')
    await panel.getByLabel('Additional answer').fill('New runtime answer')
    await panel.getByRole('button', { name: 'Submit', exact: true }).click()
    await expect(
      page.getByText('Reissued answer complete', { exact: true }),
    ).toBeVisible()
    const replies = (await wire(fixture.peer)).filter(
      (frame) => frame.type === 'control_response',
    )
    expect(replies).toHaveLength(1)
    expect(replies[0].response.response.updatedInput.answers).toEqual({
      'Explicitly reissued question': 'New runtime answer',
    })
  } finally {
    await fixture.close()
  }
})
