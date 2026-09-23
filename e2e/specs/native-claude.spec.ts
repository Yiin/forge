import { expect, test } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  launchForge,
  proxyForgeApi,
  stopProxiedForge,
  type ForgeServer,
} from '../helpers/forgeServer.js'

// Reuses the captured Claude 2.1.258 stream-json peer and initialization catalog.
// Frames follow harnesses/claude/claude.test.ts; no provider or SDK call runs.
const init = {
  send: {
    type: 'system',
    subtype: 'init',
    session_id: '$session',
    claude_code_version: '2.1.258',
    capabilities: ['msg_lifecycle_v1', 'interrupt_cancel_queued_v1'],
  },
}
const turn = (text: string) => [
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
  {
    send: {
      type: 'assistant',
      message: { id: '$new', content: [{ type: 'text', text }] },
      uuid: '$new',
    },
  },
  {
    send: {
      type: 'result',
      subtype: 'success',
      session_id: '$session',
      usage: { input_tokens: 2, output_tokens: 3 },
      uuid: '$new',
    },
  },
]

async function connect(
  page: import('@playwright/test').Page,
  forge: ForgeServer,
) {
  await proxyForgeApi(page, forge)
  await page.addInitScript((url) => {
    const globals = window as typeof window & {
      __nativeSocket?: typeof WebSocket
    }
    const Native = (globals.__nativeSocket ??= window.WebSocket)
    const Socket = function (_url: string, protocols?: string | string[]) {
      return new Native(url.replace(/^http/, 'ws') + '/ws', protocols)
    } as unknown as typeof WebSocket
    Socket.prototype = Native.prototype
    window.WebSocket = Socket
  }, forge.baseUrl)
}

test('native Claude promotes a draft and resumes the original binding after server restart', async ({
  page,
  baseURL,
}) => {
  const directory = await mkdtemp('/tmp/forge-native-browser-')
  const dataDir = join(directory, 'data')
  const peer = join(directory, 'peer')
  await mkdir(dataDir)
  await mkdir(peer)
  await writeFile(
    join(peer, 'scenario.json'),
    JSON.stringify({ actions: [init, ...turn('Native first response')] }),
  )
  let forge: ForgeServer | undefined
  let passed = false
  try {
    forge = await launchForge({
      dataDir,
      fakeNative: { kind: 'claude', directory: peer },
    })
    await connect(page, forge)
    await page.goto(baseURL ?? '/')
    await page.getByRole('button', { name: 'Add project' }).click()
    const dialog = page.getByRole('dialog', { name: 'Create project' })
    await dialog.getByLabel('Name').fill('Native browser project')
    await dialog.getByLabel('Folder path').fill(dataDir)
    await dialog.getByRole('button', { name: 'Create project' }).click()
    await page.waitForURL(/\/draft\//)
    const composer = page.getByLabel('Message composer')
    await composer.fill('First native prompt')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await page.waitForURL(/\/s\//)
    await expect(
      page.getByText('Native first response', { exact: true }),
    ).toBeVisible({ timeout: 15000 })
    await page.getByRole('button', { name: 'Model', exact: true }).click()
    await expect(
      page.getByRole('option', { name: /Opus \(1M context\)/ }),
    ).toBeVisible()
    await page.keyboard.press('Escape')
    const sessionUrl = page.url()
    const first = JSON.parse(await readFile(join(peer, 'launch.json'), 'utf8'))
    expect(first.argv).toContain('--output-format')
    expect(first.argv).toContain('stream-json')
    expect(first.resume).toBeUndefined()
    await page.reload()
    await expect(
      page.getByText('Native first response', { exact: true }),
    ).toBeVisible()
    await stopProxiedForge(page, forge)
    forge = undefined
    await writeFile(
      join(peer, 'scenario.json'),
      JSON.stringify({
        resume: first.session,
        actions: [init, ...turn('Native resumed response')],
      }),
    )
    forge = await launchForge({
      dataDir,
      fakeNative: { kind: 'claude', directory: peer },
    })
    await connect(page, forge)
    await page.goto(sessionUrl)
    await expect(
      page.getByText('Native first response', { exact: true }),
    ).toBeVisible()
    await composer.fill('Second native prompt after restart')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(
      page.getByText('Native resumed response', { exact: true }),
    ).toBeVisible({ timeout: 15000 })
    const resumed = JSON.parse(
      await readFile(join(peer, 'launch.json'), 'utf8'),
    )
    expect(resumed.resume).toBe(first.session)
    expect(resumed.session).toBe(first.session)
    expect(resumed.argv).toContain(`--resume=${first.session}`)
    const wire = (await readFile(join(peer, 'stdin.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(
      wire
        .filter((frame) => frame.type === 'user')
        .map((frame) => frame.message.content),
    ).toEqual([
      [{ type: 'text', text: 'First native prompt' }],
      [{ type: 'text', text: 'Second native prompt after restart' }],
    ])
    passed = true
  } finally {
    if (forge) await stopProxiedForge(page, forge)
    if (passed) await rm(directory, { recursive: true, force: true })
    else console.error(`Native browser evidence retained: ${directory}`)
  }
})

test('native Claude streams tools, answers original requests, and receives a draft image', async ({
  page,
  baseURL,
}) => {
  const directory = await mkdtemp('/tmp/forge-native-interactions-')
  const dataDir = join(directory, 'data'),
    peer = join(directory, 'peer')
  await mkdir(dataDir)
  await mkdir(peer)
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=',
    'base64',
  )
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
  const answered = (id: string, response: unknown) => ({
    expect: {
      type: 'control_response',
      response: { subtype: 'success', request_id: id, response },
    },
  })
  const actions = [
    init,
    ...turn('unused').slice(0, 2),
    {
      send: {
        type: 'stream_event',
        uuid: '$new',
        event: {
          type: 'message_start',
          message: { id: 'stream-original', role: 'assistant', content: [] },
        },
      },
    },
    {
      send: {
        type: 'stream_event',
        uuid: '$new',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      },
    },
    {
      send: {
        type: 'stream_event',
        uuid: '$new',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Native streaming prefix' },
        },
      },
    },
    {
      expect: {
        type: 'user',
        message: {
          content: [{ type: 'text', text: 'Native steering while running' }],
        },
      },
      capture: 'steering',
    },
    { mark: 'steering-received' },
    { wait: 'continue' },
    {
      send: {
        type: 'assistant',
        uuid: '$new',
        message: {
          id: 'tool-original',
          content: [
            {
              type: 'tool_use',
              id: 'native-bash',
              name: 'Bash',
              input: { command: 'pwd' },
            },
          ],
        },
      },
    },
    request('permission-original', 'Bash', { command: 'pwd' }),
    answered('permission-original', {
      behavior: 'allow',
      updatedInput: { command: 'pwd' },
    }),
    { mark: 'permission-answered' },
    request('question-original', 'AskUserQuestion', {
      questions: [
        {
          question: 'Choose native feature',
          header: 'Feature',
          multiSelect: false,
          options: [
            { label: 'One', description: 'First choice' },
            { label: 'Two', description: 'Second choice' },
          ],
        },
      ],
    }),
    answered('question-original', { behavior: 'allow' }),
    { mark: 'question-answered' },
    ...turn('Native interactions complete').slice(2),
    ...turn('Native cancellable turn').slice(0, 3),
    {
      expect: {
        type: 'control_request',
        request: { subtype: 'interrupt', cancel_queued: true },
      },
      capture: 'interrupt',
      controlSuccess: true,
      response: { cancelled: [], still_queued: [] },
    },
    ...turn('unused').slice(3),
  ]
  await writeFile(join(peer, 'scenario.json'), JSON.stringify({ actions }))
  let forge: ForgeServer | undefined,
    passed = false
  try {
    forge = await launchForge({
      dataDir,
      fakeNative: { kind: 'claude', directory: peer },
    })
    await connect(page, forge)
    await page.goto(baseURL ?? '/')
    await page.getByRole('button', { name: 'Add project' }).click()
    const dialog = page.getByRole('dialog', { name: 'Create project' })
    await dialog.getByLabel('Name').fill('Native interaction project')
    await dialog.getByLabel('Folder path').fill(dataDir)
    await dialog.getByRole('button', { name: 'Create project' }).click()
    await page.waitForURL(/\/draft\//)
    await page.locator('input[type=file]').setInputFiles({
      name: 'native-pixel.png',
      mimeType: 'image/png',
      buffer: image,
    })
    await expect(
      page.getByRole('img', { name: 'native-pixel.png', exact: true }),
    ).toBeVisible()
    await page
      .getByLabel('Message composer')
      .fill('Native interactions with image')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await page.waitForURL(/\/s\//)
    await expect(
      page.getByText('Native streaming prefix', { exact: true }),
    ).toBeVisible({ timeout: 15000 })
    await page
      .getByLabel('Message composer')
      .fill('Native steering while running')
    await page
      .getByRole('button', { name: 'Queue message', exact: true })
      .click()
    await page
      .getByRole('button', { name: 'Send queued message now', exact: true })
      .click()
    await expect
      .poll(async () =>
        readFile(join(peer, 'steering-received'), 'utf8').then(
          () => true,
          () => false,
        ),
      )
      .toBe(true)
    await writeFile(join(peer, 'continue'), '')
    await expect(
      page.getByRole('button', { name: '$ pwd Running', exact: true }),
    ).toBeVisible()
    const permission = page.getByRole('region', {
      name: 'Tool permission request',
    })
    await expect(permission).toBeVisible()
    await permission.getByRole('button', { name: /Allow once/ }).click()
    await permission
      .getByRole('button', { name: 'Submit', exact: true })
      .click()
    const question = page.getByRole('region', { name: 'Question from Forge' })
    await expect(question.getByText('Choose native feature')).toBeVisible()
    await page.reload()
    await question.getByRole('button', { name: /^One First choice/ }).click()
    await question.getByRole('button', { name: 'Submit', exact: true }).click()
    await expect(
      page.getByText('Native interactions complete', { exact: true }),
    ).toBeVisible({ timeout: 15000 })
    const wire = (await readFile(join(peer, 'stdin.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const nativeInput = wire.find((frame) => frame.type === 'user').message
      .content
    expect(nativeInput).toContainEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: image.toString('base64'),
      },
    })
    expect(wire.filter((frame) => frame.type === 'user')).toHaveLength(2)
    const replies = wire.filter((frame) => frame.type === 'control_response')
    expect(replies.map((frame) => frame.response.request_id)).toEqual([
      'permission-original',
      'question-original',
    ])
    expect(replies[1].response.response.updatedInput.answers).toEqual({
      'Choose native feature': 'One',
    })
    await page.reload()
    await expect(
      page.getByText('Native interactions complete', { exact: true }),
    ).toBeVisible()
    await page.getByLabel('Message composer').fill('Cancel native turn')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(
      page.getByText('Native cancellable turn', { exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'End turn', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Send', exact: true }),
    ).toBeVisible()
    const cancelledWire = (await readFile(join(peer, 'stdin.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(
      cancelledWire.filter((frame) => frame.request?.subtype === 'interrupt'),
    ).toHaveLength(1)
    passed = true
  } finally {
    if (forge) await stopProxiedForge(page, forge)
    if (passed) await rm(directory, { recursive: true, force: true })
    else console.error(`Native interaction evidence retained: ${directory}`)
  }
})
