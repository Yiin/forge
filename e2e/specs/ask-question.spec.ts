import { expect, test, type Page } from '@playwright/test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  launchForge,
  proxyForgeApi,
  stopProxiedForge,
} from '../helpers/forgeServer.js'

async function openQuestion(page: Page, mode = 'single') {
  const directory = await mkdtemp('/tmp/forge-native-question-')
  const count = mode === 'queued' ? 2 : 1
  const questions = Array.from({ length: count }, (_, index) => ({
    question:
      mode === 'multi'
        ? 'Pick toppings'
        : index
          ? 'Pick another one'
          : 'Pick one',
    header: 'Choice',
    multiSelect: mode === 'multi',
    options: (mode === 'multi'
      ? ['Cheese', 'Mushrooms', 'Olives']
      : index
        ? ['Third', 'Fourth']
        : ['First', 'Second']
    ).map((label) => ({ label })),
  }))
  let forge: Awaited<ReturnType<typeof launchForge>> | undefined
  try {
    await writeFile(
      join(directory, 'scenario.json'),
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
          ...questions.map((question, index) => ({
            send: {
              type: 'control_request',
              request_id: `question-${index}`,
              request: {
                subtype: 'can_use_tool',
                tool_name: 'AskUserQuestion',
                tool_use_id: `question-${index}`,
                input: { questions: [question] },
              },
            },
          })),
          ...questions.map((question, index) => ({
            expect: {
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: `question-${index}`,
                response: {
                  behavior: 'allow',
                  updatedInput: {
                    answers: {
                      [question.question]:
                        mode === 'multi'
                          ? 'Cheese, Mushrooms'
                          : index
                            ? 'Third'
                            : 'First',
                    },
                  },
                },
              },
            },
          })),
          {
            send: {
              type: 'assistant',
              uuid: '$new',
              message: {
                id: '$new',
                content: [{ type: 'text', text: 'Native question completed' }],
              },
            },
          },
          {
            send: {
              type: 'result',
              subtype: 'success',
              session_id: '$session',
              uuid: '$new',
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ],
      }),
    )
    forge = await launchForge({ fakeNative: { kind: 'claude', directory } })
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
    // The shadcn rebuild collapsed the desktop/phone shell classes into one
    // `.phone-shell` hook on the app root; both viewports use it now.
    const shell = page.locator('.phone-shell')
    await shell.getByRole('button', { name: 'Add project' }).click()
    const projectDialog = page.getByRole('dialog', { name: 'Create project' })
    await projectDialog.getByLabel('Name').fill('Question project')
    await projectDialog.getByLabel('Folder path').fill(forge.dataDir)
    await projectDialog.getByRole('button', { name: 'Create project' }).click()
    await page.waitForURL(/\/draft\//)
    await shell.getByLabel('Message composer').fill('ask me')
    await shell.getByRole('button', { name: 'Send' }).click()
    await page.waitForURL(/\/s\//)
    // Promotion sends the draft's text as the session's first prompt, and the
    // fixture asks its question on that prompt. A second send would only be
    // queued behind the turn already waiting for an answer.
    await expect(
      shell.getByRole('region', { name: 'Question from Forge' }),
    ).toBeVisible()
    return {
      forge,
      shell,
      verify: async () => {
        await expect(
          shell.getByText('Native question completed', { exact: true }),
        ).toBeVisible()
      },
      close: async () => {
        await stopProxiedForge(page, forge!)
        await rm(directory, { recursive: true, force: true })
      },
    }
  } catch (setupError) {
    if (forge) {
      try {
        await stopProxiedForge(page, forge)
      } catch (cleanupError) {
        throw new AggregateError(
          [setupError, cleanupError],
          'Question fixture cleanup failed',
        )
      }
    }
    await rm(directory, { recursive: true, force: true })
    throw setupError
  }
}

test('answers a single question and keeps the answer after reload', async ({
  page,
}) => {
  const { shell, close, verify } = await openQuestion(page)
  try {
    await page.reload()
    await expect(
      shell.getByRole('region', { name: 'Question from Forge' }),
    ).toBeVisible()
    await shell.getByRole('button', { name: 'First' }).click()
    await shell.getByRole('button', { name: 'Submit', exact: true }).click()
    const answeredRow = shell.locator('.chat-answered-question')
    await expect(answeredRow.getByText('First')).toBeVisible()
    await page.reload()
    await expect(
      shell.getByRole('region', { name: 'Question from Forge' }),
    ).toHaveCount(0)
    await expect(
      shell.locator('.chat-answered-question').getByText('First'),
    ).toBeVisible()
    await verify()
  } finally {
    await close()
  }
})

test('answers queued questions in order', async ({ page }) => {
  const { shell, close, verify } = await openQuestion(page, 'queued')
  try {
    const panel = shell.getByRole('region', { name: 'Question from Forge' })
    await expect(panel.getByText('2 questions')).toBeVisible()
    await panel.getByRole('button', { name: 'First' }).click()
    await panel.getByRole('button', { name: 'Submit', exact: true }).click()
    await expect(
      panel.getByRole('heading', { name: 'Pick another one' }),
    ).toBeVisible()
    await panel.getByRole('button', { name: 'Third' }).click()
    await panel.getByRole('button', { name: 'Submit', exact: true }).click()
    await expect(panel).toHaveCount(0)
    await verify()
  } finally {
    await close()
  }
})

test('keeps a pending question reachable above the workspace dock', async ({
  page,
}) => {
  const { shell, close, verify } = await openQuestion(page)
  try {
    const sessionId = new URL(page.url()).pathname.split('/').pop()
    await page.evaluate(
      ({ sessionId, takeover }) => {
        if (!sessionId) throw new Error('Session URL has no session id')
        localStorage.setItem(
          'forge.shell.dock',
          JSON.stringify({
            width: 480,
            sessions: {
              [sessionId]: {
                open: true,
                takeover,
                activeTabId: null,
                tabs: [],
              },
            },
          }),
        )
      },
      { sessionId, takeover: !test.info().project.name.startsWith('phone') },
    )
    await page.reload()

    const panel = shell.getByRole('region', { name: 'Question from Forge' })
    await expect(panel).toBeVisible()
    await panel.getByRole('button', { name: 'First' }).click()
    await panel.getByRole('button', { name: 'Submit', exact: true }).click()
    await expect(shell.locator('.chat-answered-question')).toContainText(
      'First',
    )
    await verify()
  } finally {
    await close()
  }
})

test('answers a multi-select question on the phone viewport', async ({
  page,
}) => {
  const { shell, close, verify } = await openQuestion(page, 'multi')
  try {
    const panel = shell.getByRole('region', { name: 'Question from Forge' })
    await panel.getByRole('button', { name: 'Cheese' }).click()
    await panel.getByRole('button', { name: 'Mushrooms' }).click()
    await panel.getByRole('button', { name: 'Submit' }).click()
    await expect(panel).toHaveCount(0)
    await verify()
  } finally {
    await close()
  }
})
