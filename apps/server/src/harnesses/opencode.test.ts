import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  harnessEventSchema,
  type HarnessEvent,
  type PromptInput,
  type QuestionAnswer,
} from '@forge/protocol/harness'
import { emptyTimeline, reduceTimeline } from '@forge/protocol/timeline'
import {
  createOpenCodeAdapter,
  type OpenCodeAdapterOptions,
} from './opencode.js'
import {
  BoundedStore,
  newNativeId,
  partInfo,
  tuple,
} from './opencode-events.js'
import { limitsOf } from './opencode-http.js'
import { deferred } from './transport-test-helpers.js'

type Row = { info: Record<string, unknown>; parts: Record<string, unknown>[] }
type Recorded = {
  method: string
  path: string
  url: URL
  body: Record<string, unknown> | undefined
  headers: IncomingMessage['headers']
}
const wire = JSON.parse(
  await readFile(
    new URL('./fixtures/opencode-wire.json', import.meta.url),
    'utf8',
  ),
)
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.restoreAllMocks()
})
describe('OpenCode independent review regressions', () => {
  it('O1: attached load reads captured Session model id and optional variant', async () => {
    const fake = await peer()
    fake.sessions.get('ses_fixture')!.model = {
      id: 'model/a',
      providerID: 'fake',
      variant: 'deep',
    }
    const first = await fake.spawn()
    await first.kill()
    const loaded = await createOpenCodeAdapter(
      fake.options({
        attachedResumeScopes: new Map([
          ['forge-session', first.attachedResumeScope!],
        ]),
      }),
    ).load(
      { id: 'forge-session', ...fake.scope, binding: first.binding },
      fake.emit,
    )
    cleanups.push(async () => {
      await loaded.kill()
    })
    expect(loaded.binding).toEqual(first.binding)
    expect(loaded.configOptions!()[0]!.options).toContainEqual({
      value: 'deep',
      name: 'deep',
    })
  })

  it.each(['later-variant', 'queued-variant', 'later-file', 'queued-file'])(
    'O2: command validation uses the actual effective model for %s',
    async (mode) => {
      const fake = await peer()
      fake.sessions.get('ses_fixture')!.model = {
        id: 'model/a',
        providerID: 'fake',
        variant: 'deep',
      }
      const historical = fake.user(newNativeId('msg'), 'ses_fixture', false)
      historical.info.time = { created: 0 }
      let reads = 0
      const handle = await fake.spawn({
        resolveAttachment: async () => {
          reads++
          return {
            attachmentId: 'image',
            mime: 'image/png',
            filename: 'image.png',
            sizeBytes: 1,
            bytes: new Uint8Array([1]),
          }
        },
      })
      const gate = deferred<void>()
      cleanups.push(async () => gate.resolve())
      fake.state.hook = async (request, response) => {
        if (request.path.endsWith('/command') && request.method === 'POST') {
          const row = fake.user(
            String(request.body!.messageID),
            'ses_fixture',
            false,
          )
          const model = fake.sessions.get('ses_fixture')!.model as {
            providerID: string
            id: string
          }
          row.info.model = { providerID: model.providerID, modelID: model.id }
          row.info.time = { created: 5 }
          fake.selectModel(row)
          fake.put(row)
          const answer = fake.assistant(
            String(row.info.id),
            'current result',
            'ses_fixture',
            'stop',
            false,
          )
          Object.assign(answer.info, row.info.model)
          answer.info.time = { created: 6, completed: 7 }
          fake.put(answer)
          fake.idle()
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(answer))
          return true
        }
        if (!request.path.endsWith('/prompt_async')) return false
        await gate.promise
        const user = fake.user(
          String(request.body!.messageID),
          'ses_fixture',
          false,
        )
        user.info.model = { providerID: 'fake', modelID: 'b' }
        user.info.time = { created: 2 }
        fake.selectModel(user)
        fake.put(user)
        const assistant = fake.assistant(
          String(user.info.id),
          'B result',
          'ses_fixture',
          'stop',
          false,
        )
        assistant.info.modelID = 'b'
        assistant.info.time = { created: 3, completed: 4 }
        fake.put(assistant)
        fake.idle()
        response.writeHead(204).end()
        return true
      }
      const first = await handle.prompt('use B once', {
        model: 'fake/b',
        permissionMode: 'manual',
      })
      const input: PromptInput[] = [
        { type: 'text', text: '/known argument' },
        ...(mode.endsWith('file')
          ? [
              {
                type: 'attachment' as const,
                attachmentId: 'image',
                mime: 'image/png',
              },
            ]
          : []),
      ]
      const options = {
        permissionMode: 'manual' as const,
        ...(mode.endsWith('file') ? {} : { reasoning: 'deep' }),
      }
      const queued = mode.startsWith('queued')
        ? handle.queue(input, options)
        : undefined
      gate.resolve()
      expect(await first.completion).toMatchObject({ status: 'completed' })
      {
        const code = mode.endsWith('file')
          ? 'OPENCODE_UNSUPPORTED_ATTACHMENT'
          : 'OPENCODE_VARIANT_UNSUPPORTED'
        if (queued)
          expect(await queued.completion).toMatchObject({
            status: 'failed',
            code,
          })
        else {
          const command = await handle.prompt(input, options)
          expect(await command.completion).toMatchObject({
            status: 'failed',
            code,
          })
        }
        expect(
          fake.records.filter(
            (entry) =>
              entry.path.endsWith('/command') && entry.method === 'POST',
          ),
        ).toEqual([])
        expect(reads).toBe(0)
      }
      const valid = await handle.prompt('/known default')
      const validOutcome = await valid.completion
      expect(validOutcome, JSON.stringify(validOutcome)).toMatchObject({
        status: 'completed',
      })
      expect(fake.sessions.get('ses_fixture')!.model).toEqual({
        providerID: 'fake',
        id: 'b',
        variant: 'default',
      })
      expect(
        fake.records.filter(
          (entry) => entry.path.endsWith('/command') && entry.method === 'POST',
        ),
      ).toHaveLength(1)
    },
  )

  it('O2: current Session A overrides older B history and preserves native default variants', async () => {
    const fake = await peer()
    fake.sessions.get('ses_fixture')!.model = {
      providerID: 'fake',
      id: 'model/a',
      variant: 'default',
    }
    const old = fake.user(newNativeId('msg'), 'ses_fixture', false)
    old.info.model = { providerID: 'fake', modelID: 'b' }
    old.info.time = { created: 0 }
    const handle = await fake.spawn()
    const receipt = await handle.prompt('/known valid A', {
      reasoning: 'deep',
      permissionMode: 'manual',
    })
    expect(await receipt.completion).toMatchObject({ status: 'completed' })
    const post = fake.records.find(
      (entry) => entry.path.endsWith('/command') && entry.method === 'POST',
    )!
    expect(post.body).toMatchObject({ variant: 'deep' })
    expect(post.body).not.toHaveProperty('model')
  })

  it.each([
    'before-preparation',
    'during-preparation',
    'between-attachments',
    'final-status',
    'final-status-variant',
  ])(
    'O2: refreshes a changed native Session at %s before command POST',
    async (boundary) => {
      const fake = await peer()
      let reads = 0
      const mutate = () => {
        const info = fake.sessions.get('ses_fixture')!
        info.model = { providerID: 'fake', id: 'b', variant: 'default' }
        info.time = { created: 1, updated: 2 }
        fake.send('session.updated', { sessionID: 'ses_fixture', info })
      }
      const handle = await fake.spawn({
        resolveAttachment: async () => {
          reads++
          if (
            boundary === 'during-preparation' ||
            boundary === 'between-attachments'
          ) {
            mutate()
            await vi.waitFor(() =>
              expect(handle.configOptions!()[0]!.options).not.toContainEqual({
                value: 'deep',
                name: 'deep',
              }),
            )
          }
          return {
            attachmentId: 'image',
            mime: 'image/png',
            filename: 'image.png',
            sizeBytes: 1,
            bytes: new Uint8Array([1]),
          }
        },
      })
      if (boundary === 'before-preparation') {
        // A missed event must not keep startup model A authoritative.
        fake.sessions.get('ses_fixture')!.model = {
          providerID: 'fake',
          id: 'b',
          variant: 'default',
        }
      }
      fake.state.hook = async (request) => {
        if (
          boundary.startsWith('final-status') &&
          request.path === '/session/status'
        ) {
          mutate()
          await vi.waitFor(() =>
            expect(handle.configOptions!()[0]!.options).not.toContainEqual({
              value: 'deep',
              name: 'deep',
            }),
          )
        }
        return false
      }
      const variant = boundary.endsWith('variant')
      const receipt = await handle.prompt(
        [
          { type: 'text', text: '/known argument' },
          ...(variant
            ? []
            : [
                {
                  type: 'attachment' as const,
                  attachmentId: 'image',
                  mime: 'image/png',
                },
              ]),
          ...(boundary === 'between-attachments'
            ? [
                {
                  type: 'attachment' as const,
                  attachmentId: 'image2',
                  mime: 'image/png',
                },
              ]
            : []),
        ],
        variant ? { reasoning: 'deep', permissionMode: 'manual' } : undefined,
      )
      expect(await receipt.completion).toMatchObject({
        status: 'failed',
        code: variant
          ? 'OPENCODE_VARIANT_UNSUPPORTED'
          : 'OPENCODE_UNSUPPORTED_ATTACHMENT',
      })
      expect(reads).toBe(boundary === 'before-preparation' || variant ? 0 : 1)
      expect(
        fake.records.filter(
          (entry) => entry.path.endsWith('/command') && entry.method === 'POST',
        ),
      ).toHaveLength(0)
    },
  )

  it.each([
    'stale-event',
    'equal-time-event',
    'foreign-event',
    'clear-model',
    'missed-event',
  ])('O2: current Session GET controls selection after %s', async (mode) => {
    const fake = await peer()
    const old = fake.user(newNativeId('msg'), 'ses_fixture', false)
    old.info.model = { providerID: 'fake', modelID: 'b' }
    const handle = await fake.spawn()
    const info = structuredClone(fake.sessions.get('ses_fixture')!)
    info.model = { providerID: 'fake', id: 'b', variant: 'default' }
    info.time = { created: 1, updated: mode === 'stale-event' ? 0 : 1 }
    if (mode === 'foreign-event') info.id = 'ses_foreign'
    if (mode === 'clear-model') {
      delete info.model
      delete fake.sessions.get('ses_fixture')!.model
    }
    if (mode === 'missed-event')
      fake.sessions.get('ses_fixture')!.model = info.model
    else fake.send('session.updated', { sessionID: info.id, info })
    if (mode !== 'foreign-event' && mode !== 'missed-event')
      await vi.waitFor(() =>
        expect(handle.configOptions!()[0]!.options).not.toContainEqual({
          value: 'deep',
          name: 'deep',
        }),
      )
    const useB = mode === 'clear-model' || mode === 'missed-event'
    const receipt = await handle.prompt('/known model', {
      reasoning: useB ? 'brief' : 'deep',
      permissionMode: 'manual',
    })
    expect(await receipt.completion).toMatchObject({ status: 'completed' })
    expect(fake.sessions.get('ses_fixture')!.model).toMatchObject({
      id: useB ? 'b' : 'model/a',
    })
    expect(
      fake.records.find(
        (entry) => entry.path.endsWith('/command') && entry.method === 'POST',
      )!.body,
    ).not.toHaveProperty('model')
  })

  it.each(['initial-read', 'final-read', 'status-during-final-read'])(
    'O2: rejects an overlapping Session observation during %s',
    async (boundary) => {
      const fake = await peer()
      const handle = await fake.spawn()
      let reads = 0
      fake.state.hook = async (request, response) => {
        if (request.path !== '/session/ses_fixture') return false
        reads++
        if (reads !== (boundary === 'initial-read' ? 1 : 2)) return false
        const stale = structuredClone(fake.sessions.get('ses_fixture')!)
        const info = fake.sessions.get('ses_fixture')!
        if (boundary === 'status-during-final-read') {
          const observed = vi.spyOn(BoundedStore.prototype, 'put')
          fake.status.ses_fixture = { type: 'busy' }
          fake.send(
            'session.status',
            {
              sessionID: info.id,
              status: { type: 'busy' },
            },
            'evt_final_status_boundary',
          )
          await vi.waitFor(() =>
            expect(observed).toHaveBeenCalledWith(
              'evt_final_status_boundary',
              expect.any(String),
            ),
          )
          observed.mockRestore()
        } else {
          info.model = { providerID: 'fake', id: 'b', variant: 'default' }
          fake.send('session.updated', { sessionID: info.id, info })
          await vi.waitFor(() =>
            expect(handle.configOptions!()[0]!.options).not.toContainEqual({
              value: 'deep',
              name: 'deep',
            }),
          )
        }
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(stale))
        return true
      }
      const receipt = await handle.prompt('/known argument', {
        reasoning: 'deep',
        permissionMode: 'manual',
      })
      expect(await receipt.completion).toMatchObject({
        status: 'failed',
        code: 'OPENCODE_BUSY',
      })
      expect(
        fake.records.filter(
          (entry) => entry.path.endsWith('/command') && entry.method === 'POST',
        ),
      ).toHaveLength(0)
    },
  )

  it.each(['input', 'command', 'command-agent'])(
    'O2: preserves %s model precedence across the final status boundary',
    async (source) => {
      const fake = await peer()
      if (source === 'command') fake.state.commands[0]!.model = 'fake/model/a'
      if (source === 'command-agent') {
        fake.state.commands[0]!.agent = 'build'
        fake.state.agents[0]!.model = { providerID: 'fake', modelID: 'model/a' }
      }
      let reads = 0
      const handle = await fake.spawn({
        resolveAttachment: async () => {
          reads++
          return {
            attachmentId: 'image',
            mime: 'image/png',
            filename: 'image.png',
            sizeBytes: 1,
            bytes: new Uint8Array([1]),
          }
        },
      })
      let changed = false
      fake.state.hook = async (request) => {
        if (!changed && request.path === '/session/status') {
          changed = true
          const info = fake.sessions.get('ses_fixture')!
          info.model = { providerID: 'fake', id: 'b', variant: 'default' }
          fake.send('session.updated', { sessionID: info.id, info })
          await vi.waitFor(() =>
            expect(handle.configOptions!()[0]!.options).not.toContainEqual({
              value: 'deep',
              name: 'deep',
            }),
          )
        }
        return false
      }
      const receipt = await handle.prompt(
        [
          { type: 'text', text: '/known argument' },
          { type: 'attachment', attachmentId: 'image', mime: 'image/png' },
        ],
        {
          reasoning: 'deep',
          permissionMode: 'manual',
          ...(source === 'input' ? { model: 'fake/model/a' } : {}),
        },
      )
      expect(await receipt.completion).toMatchObject({ status: 'completed' })
      expect(reads).toBe(1)
      expect(changed).toBe(true)
      expect(
        fake.records.find(
          (entry) => entry.path.endsWith('/command') && entry.method === 'POST',
        )!.body,
      ).toMatchObject({ model: 'fake/model/a', variant: 'deep' })
      expect(fake.sessions.get('ses_fixture')!.model).toMatchObject({
        id: 'model/a',
      })
    },
  )

  it.each([
    'id',
    'directory',
    'time',
    'required-field',
    'modelID',
    'variant',
    'null-model',
  ])(
    'O2: rejects a current Session with invalid %s before attachment work',
    async (field) => {
      const fake = await peer()
      let reads = 0
      const handle = await fake.spawn({
        resolveAttachment: async () => {
          reads++
          throw new Error('Invalid Session must not reach the resolver')
        },
      })
      const invalid = structuredClone(fake.sessions.get('ses_fixture')!)
      if (field === 'id') invalid.id = 'ses_foreign'
      if (field === 'directory') invalid.directory = '/foreign'
      if (field === 'time') invalid.time = { created: 1, updated: -1 }
      if (field === 'required-field') delete invalid.slug
      if (field === 'modelID')
        invalid.model = { providerID: 'fake', modelID: 'b' }
      if (field === 'variant')
        invalid.model = { providerID: 'fake', id: 'b', variant: null }
      if (field === 'null-model') invalid.model = null
      fake.state.hook = (request, response) => {
        if (request.path !== '/session/ses_fixture') return false
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(invalid))
        return true
      }
      const receipt = await handle.prompt([
        { type: 'text', text: '/known argument' },
        { type: 'attachment', attachmentId: 'image', mime: 'image/png' },
      ])
      expect(await receipt.completion).toMatchObject({
        status: 'failed',
        code:
          field === 'id' || field === 'directory'
            ? 'OPENCODE_RESUME_SCOPE_MISMATCH'
            : 'OPENCODE_PROTOCOL',
      })
      expect(reads).toBe(0)
      expect(
        fake.records.filter(
          (entry) => entry.path.endsWith('/command') && entry.method === 'POST',
        ),
      ).toHaveLength(0)
    },
  )

  it('O3: assistant FilePart SSE emits an owned unsupported diagnostic without exposing its URL', async () => {
    const fake = await peer()
    const handle = await fake.spawn()
    const receipt = await handle.prompt('file result')
    await fake.started(receipt.turnId)
    const request = await fake.admitted()
    const row = fake.assistant(
      String(request.body!.messageID),
      '',
      'ses_fixture',
      'stop',
      false,
    )
    row.parts = [
      {
        id: 'prt_file',
        sessionID: 'ses_fixture',
        messageID: row.info.id,
        type: 'file',
        mime: 'image/png',
        filename: 'result.png',
        url: 'https://example.invalid/private-output',
      },
    ]
    fake.put(row)
    fake.idle()
    expect((await receipt.completion).status).toBe('completed')
    expect(
      fake.events.filter(
        (event) =>
          event.type === 'diagnostic' &&
          event.code === 'OPENCODE_PART_UNSUPPORTED',
      ),
    ).toMatchObject([
      {
        runId: receipt.runId,
        turnId: receipt.turnId,
        providerRunId: 'ses_fixture',
        providerItemId: 'prt_file',
        severity: 'warning',
      },
    ])
    expect(JSON.stringify(fake.events)).not.toContain('private-output')
  })

  it('O4: completed commands release arguments and receipt handles under the retained byte ceiling', async () => {
    const stores = new Set<BoundedStore<unknown>>()
    const put = BoundedStore.prototype.put
    vi.spyOn(BoundedStore.prototype, 'put').mockImplementation(function (
      this: BoundedStore<unknown>,
      ...args
    ) {
      stores.add(this)
      return put.apply(this, args)
    })
    const fake = await peer()
    const handle = await fake.spawn({ limits: { retainedBytes: 131072 } })
    for (let index = 0; index < 5; index++) {
      const receipt = await handle.prompt(`/known ${'x'.repeat(32768)}`)
      expect((await receipt.completion).status).toBe('completed')
      const key = tuple(receipt.runId, receipt.turnId)
      const store = [...stores].find((entry) => entry.has(key))!
      expect(store.get(key)).toMatchObject({
        settled: true,
        outcome: { status: 'completed' },
      })
      for (const field of [
        'command',
        'input',
        'options',
        'receipt',
        'settle',
        'controller',
      ])
        expect(store.get(key)).not.toHaveProperty(field)
      expect(store.retainedSize(key)).toBeLessThan(1024)
      expect(() =>
        handle.prompt('duplicate', undefined, {
          runId: receipt.runId,
          turnId: receipt.turnId,
        }),
      ).toThrow(/already accepted/)
    }
    expect(
      fake.records.filter(
        (entry) => entry.path.endsWith('/command') && entry.method === 'POST',
      ),
    ).toHaveLength(5)
  })

  it('O4: cancellation keeps physical attachment payloads charged and restores admission only after settlement', async () => {
    const stores = new Set<BoundedStore<unknown>>()
    const put = BoundedStore.prototype.put
    vi.spyOn(BoundedStore.prototype, 'put').mockImplementation(function (
      this: BoundedStore<unknown>,
      ...args
    ) {
      stores.add(this)
      return put.apply(this, args)
    })
    const fake = await peer()
    const read = deferred<{
      attachmentId: string
      mime: string
      filename: string
      sizeBytes: number
      bytes: Uint8Array
    }>()
    const entered = deferred<void>()
    const handle = await fake.spawn({
      limits: { retainedBytes: 131072 },
      resolveAttachment: () => {
        entered.resolve()
        return read.promise
      },
    })
    cleanups.push(async () =>
      read.resolve({
        attachmentId: 'held',
        mime: 'text/plain',
        filename: 'held.txt',
        sizeBytes: 0,
        bytes: new Uint8Array(),
      }),
    )
    const receipt = await handle.prompt([
      { type: 'text', text: `/known ${'x'.repeat(32768)}` },
      { type: 'attachment', attachmentId: 'held', mime: 'text/plain' },
    ])
    await entered.promise
    await handle.cancel()
    expect((await receipt.completion).status).toBe('interrupted')
    const key = tuple(receipt.runId, receipt.turnId)
    const store = [...stores].find((entry) => entry.retainedSize(key) > 65536)!
    expect(store.get(key)).toMatchObject({
      command: { arguments: 'x'.repeat(32768) },
      settled: true,
    })
    expect(() => handle.prompt('too early')).toThrow(/foreground/)
    const queued = handle.queue('recovery')
    expect(
      fake.records.filter(
        (entry) => entry.method === 'POST' && entry.path.endsWith('/command'),
      ),
    ).toEqual([])
    read.resolve({
      attachmentId: 'held',
      mime: 'text/plain',
      filename: 'held.txt',
      sizeBytes: 0,
      bytes: new Uint8Array(),
    })
    const request = await fake.admitted()
    await fake.started(queued.turnId)
    expect(request.body!.parts).toMatchObject([{ text: 'recovery' }])
    expect(store.has(key)).toBe(false)
    expect(store.retainedSize(key)).toBe(0)
    const terminal = [...stores].find((entry) => entry.has(key))!
    expect(terminal.get(key)).not.toHaveProperty('input')
    expect(terminal.retainedSize(key)).toBeLessThan(1024)
    fake.assistant(String(request.body!.messageID))
    fake.idle()
    expect((await queued.completion).status).toBe('completed')
  })

  it('O4: active and queued inputs retain their existing limit independently of receipt bytes', async () => {
    const fake = await peer()
    const handle = await fake.spawn({ limits: { receiptBytes: 1024 } })
    const text = 'x'.repeat(600 * 1024)
    const first = await handle.prompt(text)
    const queued = handle.queue(text)
    for (const receipt of [first, queued]) {
      await fake.started(receipt.turnId)
      const request = await fake.admitted()
      expect(request.body!.parts).toMatchObject([{ text }])
      fake.assistant(String(request.body!.messageID))
      fake.idle()
      expect((await receipt.completion).status).toBe('completed')
    }
  })

  it.each(['text-count', 'tool-count', 'text-replace', 'tool-replace'])(
    'O5: rejected %s state publishes no part event over HTTP/SSE',
    async (mode) => {
      const fake = await peer()
      const handle = await fake.spawn({
        limits: mode.endsWith('count') ? { partCount: 1 } : { partBytes: 1024 },
      })
      const receipt = await handle.prompt('capacity')
      await fake.started(receipt.turnId)
      const request = await fake.admitted()
      const row = fake.assistant(
        String(request.body!.messageID),
        '',
        'ses_fixture',
        undefined,
        false,
      )
      const part = {
        id: 'prt_admitted',
        sessionID: 'ses_fixture',
        messageID: String(row.info.id),
        ...(mode.startsWith('text')
          ? { type: 'text', text: 'old' }
          : {
              type: 'tool',
              tool: 'fixture',
              callID: 'call',
              state: { status: 'running', input: {} },
            }),
      }
      row.parts = [part]
      fake.put(row)
      await fake.wait(() =>
        fake.events.find(
          (event) =>
            'providerItemId' in event && event.providerItemId === part.id,
        ),
      )
      const previous = fake.events.length
      const rejected = {
        ...part,
        ...(mode.endsWith('count')
          ? { id: 'prt_rejected' }
          : mode.startsWith('text')
            ? { text: 'x'.repeat(700) }
            : {
                state: {
                  status: 'completed',
                  input: {},
                  output: 'x'.repeat(700),
                },
              }),
      }
      expect(() =>
        partInfo(rejected, limitsOf({ partBytes: 1024 })),
      ).not.toThrow()
      row.parts = mode.endsWith('count') ? [part, rejected] : [rejected]
      fake.put(row)
      expect((await receipt.completion).status).toBe('failed')
      expect(
        fake.events
          .slice(previous)
          .filter((event) =>
            [
              'text_delta',
              'thought_delta',
              'content_snapshot',
              'tool_started',
              'tool_update',
            ].includes(event.type),
          ),
      ).toEqual([])
    },
  )
})
describe('OpenCode invocation and request boundaries', () => {
  it('holds early task metadata until its child creation evidence arrives', async () => {
    const fake = await peer()
    const handle = await fake.spawn({ limits: { ownershipMs: 1000 } })
    const receipt = await handle.prompt('late creation')
    const request = await fake.admitted()
    await fake.started(receipt.turnId)
    fake.sessions.set('ses_early', {
      id: 'ses_early',
      directory: fake.cwd,
      parentID: 'ses_fixture',
    })
    fake.user(newNativeId('msg'), 'ses_early', false)
    fake.status.ses_early = { type: 'busy' }
    const row = fake.assistant(
      String(request.body!.messageID),
      '',
      'ses_fixture',
      'tool-calls',
      false,
    )
    row.parts = [
      {
        id: newNativeId('prt'),
        sessionID: 'ses_fixture',
        messageID: row.info.id,
        type: 'tool',
        tool: 'task',
        callID: 'early-call',
        state: {
          status: 'running',
          input: {},
          metadata: { sessionId: 'ses_early', parentSessionId: 'ses_fixture' },
        },
      },
    ]
    fake.put(row)
    await fake.wait(() =>
      fake.records.find((record) => record.path === '/session/ses_early'),
    )
    expect(fake.events.some((event) => event.type === 'child_started')).toBe(
      false,
    )
    fake.send('session.created', {
      sessionID: 'ses_early',
      info: fake.sessions.get('ses_early'),
    })
    const child = await fake.wait(() =>
      fake.events.find((event) => event.type === 'child_started'),
    )
    expect(child).toMatchObject({
      runId: receipt.runId,
      turnId: receipt.turnId,
      providerRunId: 'ses_early',
    })
  })
  it('retires when the reconnected stream dies during snapshot recovery', async () => {
    const fake = await peer()
    const handle = await fake.spawn()
    const receipt = await handle.prompt('reconnect death')
    await fake.started(receipt.turnId)
    fake.state.hook = (request, response) => {
      if (request.path !== '/global/event') return false
      response
        .writeHead(200, { 'content-type': 'text/event-stream' })
        .end(
          `data: ${JSON.stringify({ directory: fake.cwd, payload: { id: 'evt_reconnected_dead', type: 'server.connected', properties: {} } })}\n\n`,
        )
      return true
    }
    for (const stream of fake.streams) stream.end()
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      code: 'OPENCODE_HISTORY_GAP',
    })
    const posts = fake.records.filter((record) =>
      record.path.endsWith('/prompt_async'),
    ).length
    expect(() => handle.prompt('later')).toThrow()
    expect(
      fake.records.filter((record) => record.path.endsWith('/prompt_async')),
    ).toHaveLength(posts)
  })
  it('rejects stale child invocation results and never revives rejected reuse with a late user', async () => {
    const fake = await peer()
    const handle = await fake.spawn()
    const first = await handle.prompt('I1')
    const firstRequest = await fake.admitted()
    await fake.started(first.turnId)
    fake.sessions.set('ses_repeat', {
      id: 'ses_repeat',
      directory: fake.cwd,
      parentID: 'ses_fixture',
    })
    fake.send('session.created', {
      sessionID: 'ses_repeat',
      info: fake.sessions.get('ses_repeat'),
    })
    const u1 = newNativeId('msg')
    fake.user(u1, 'ses_repeat')
    const a1 = fake.assistant(u1, 'I1 final', 'ses_repeat')
    const task = (parentID: string, callID: string) => {
      const row = fake.assistant(
        parentID,
        '',
        'ses_fixture',
        'tool-calls',
        false,
      )
      row.parts = [
        {
          id: newNativeId('prt'),
          sessionID: 'ses_fixture',
          messageID: row.info.id,
          type: 'tool',
          tool: 'task',
          callID,
          state: {
            status: 'completed',
            input: {},
            output: 'I1 final',
            metadata: {
              sessionId: 'ses_repeat',
              parentSessionId: 'ses_fixture',
            },
          },
        },
      ]
      fake.put(row)
    }
    task(String(firstRequest.body!.messageID), 'I1-call')
    fake.idle('ses_repeat')
    await fake.wait(() =>
      fake.events.find((event) => event.type === 'child_finished'),
    )
    fake.assistant(String(firstRequest.body!.messageID))
    fake.idle()
    expect((await first.completion).status).toBe('completed')
    const second = await handle.prompt('I2')
    await fake.started(second.turnId)
    const secondRequest = await fake.admitted()
    fake.put(a1)
    fake.idle('ses_repeat')
    task(String(secondRequest.body!.messageID), 'I2-call')
    fake.idle()
    expect(await second.completion).toMatchObject({
      status: 'failed',
      code: 'OPENCODE_OWNERSHIP_GAP',
    })
    expect(
      fake.events.filter((event) => event.type === 'child_started'),
    ).toHaveLength(1)
    expect(
      fake.events.filter((event) => event.type === 'child_finished'),
    ).toHaveLength(1)
    const before = fake.events.length
    const u2 = newNativeId('msg')
    fake.user(u2, 'ses_repeat')
    fake.assistant(u2, 'late I2', 'ses_repeat')
    fake.idle('ses_repeat')
    await fetch(fake.origin + '/global/health')
    expect(fake.events).toHaveLength(before)
  })

  it.each(['deleted-anchor', 'repeated-cursor', 'dirty-forever'])(
    'fails explicit %s history recovery within its original bound',
    async (mode) => {
      const fake = await peer()
      const handle = await fake.spawn({
        limits: { recoveryMs: 150, historyPages: 4 },
      })
      const receipt = await handle.prompt('history')
      const request = await fake.admitted()
      await fake.started(receipt.turnId)
      const row = fake.assistant(
        String(request.body!.messageID),
        'initial',
        'ses_fixture',
        undefined,
      )
      await fake.wait(() =>
        fake.events.find((event) => event.type === 'text_delta'),
      )
      fake.state.hook = (request, response) => {
        if (!request.path.endsWith('/message')) return false
        if (mode === 'dirty-forever')
          fake.send('message.part.delta', {
            sessionID: 'ses_fixture',
            messageID: row.info.id,
            partID: row.parts[0]!.id,
            field: 'text',
            delta: 'x',
          })
        const rows =
          mode === 'deleted-anchor'
            ? []
            : mode === 'repeated-cursor'
              ? [row]
              : fake.histories.get('ses_fixture')!
        response
          .writeHead(200, {
            'content-type': 'application/json',
            ...(mode === 'repeated-cursor'
              ? { 'x-next-cursor': 'same-cursor' }
              : {}),
          })
          .end(JSON.stringify(rows))
        return true
      }
      fake.idle()
      expect(await receipt.completion).toMatchObject({
        status: 'failed',
        code: 'OPENCODE_HISTORY_GAP',
      })
    },
  )

  it('reconciles a conflicting event ID without replaying its conflicting content', async () => {
    const fake = await peer()
    const handle = await fake.spawn()
    const receipt = await handle.prompt('dedup')
    const request = await fake.admitted()
    await fake.started(receipt.turnId)
    const row = fake.assistant(
      String(request.body!.messageID),
      'kept',
      'ses_fixture',
      undefined,
    )
    const props = { sessionID: 'ses_fixture', part: row.parts[0], time: 1 }
    fake.send('message.part.updated', props, 'evt_conflict')
    fake.send(
      'message.part.updated',
      { ...props, part: { ...row.parts[0], text: 'conflicting' } },
      'evt_conflict',
    )
    await fake.wait(() => fake.state.connections >= 2)
    row.info.time = { created: 1, completed: 2 }
    row.info.finish = 'stop'
    fake.put(row, false)
    fake.idle()
    expect((await receipt.completion).status).toBe('completed')
    expect(
      fake.events.some(
        (event) => 'text' in event && event.text.includes('conflicting'),
      ),
    ).toBe(false)
  })

  it('keeps local model and variant controls scoped to later accepted input', async () => {
    const fake = await peer()
    const handle = await fake.spawn({ defaults: { model: 'fake/b' } })
    await handle.setModel!('fake/model/a')
    await handle.setConfigOption!('variant', 'native-extra')
    expect(handle.configOptions!()[0]!.currentValue).toBe('native-extra')
    expect(() =>
      handle.prompt('bad', { reasoning: 'high', permissionMode: 'manual' }),
    ).toThrow()
    expect(() =>
      handle.prompt('bad', {
        approvalPolicy: 'never',
        permissionMode: 'manual',
      }),
    ).toThrow()
    const first = await handle.prompt('first')
    await fake.started(first.turnId)
    const sent = await fake.admitted()
    expect(sent.body).toMatchObject({
      model: { providerID: 'fake', modelID: 'model/a' },
      variant: 'native-extra',
    })
    await handle.setConfigOption!('variant', '')
    fake.assistant(String(sent.body!.messageID))
    fake.idle()
    await first.completion
    const second = await handle.prompt('/unknown', {
      reasoning: 'deep',
      permissionMode: 'manual',
    })
    await fake.started(second.turnId)
    expect((await fake.admitted()).body!.variant).toBe('deep')
    expect(
      fake.records.some(
        (record) => record.path === '/config' && record.method !== 'GET',
      ),
    ).toBe(false)
  })

  it('preserves two attachments and surrounding text in the exact prompt body', async () => {
    const fake = await peer()
    const seen: string[] = []
    const deadlines: number[] = []
    const handle = await fake.spawn({
      defaults: { model: 'fake/model/a' },
      resolveAttachment: async (input) => {
        seen.push(input.attachmentId)
        deadlines.push(input.deadlineAt)
        const bytes = Buffer.from(input.attachmentId)
        return {
          attachmentId: input.attachmentId,
          mime: input.mime,
          filename: input.attachmentId,
          sizeBytes: bytes.length,
          bytes,
        }
      },
    })
    const receipt = await handle.prompt([
      { type: 'text', text: 'a' },
      { type: 'attachment', attachmentId: 'one', mime: 'text/plain' },
      { type: 'text', text: 'b' },
      { type: 'attachment', attachmentId: 'two', mime: 'image/png' },
      { type: 'text', text: 'c' },
    ])
    await fake.started(receipt.turnId)
    const parts = (await fake.admitted()).body!.parts as Array<
      Record<string, string>
    >
    expect(parts.map((part) => part.type)).toEqual([
      'text',
      'file',
      'text',
      'file',
      'text',
    ])
    expect(
      parts
        .filter((part) => part.type === 'file')
        .map((part) =>
          Buffer.from(part.url!.split(',')[1]!, 'base64').toString(),
        ),
    ).toEqual(['one', 'two'])
    expect(seen).toEqual(['one', 'two'])
    expect(new Set(deadlines).size).toBe(1)
  })

  it('expires an early scoped error without inventing a completed assistant', async () => {
    const fake = await peer()
    const handle = await fake.spawn({ limits: { ownershipMs: 50 } })
    const receipt = await handle.prompt('error')
    await fake.started(receipt.turnId)
    fake.send('session.error', {
      sessionID: 'ses_fixture',
      error: { name: 'UnknownError', data: { message: 'failure' } },
    })
    fake.idle()
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      code: 'OPENCODE_OWNERSHIP_GAP',
    })
  })
  it('keeps nested child ancestry and child permission ownership separate', async () => {
    const fake = await peer()
    const handle = await fake.spawn()
    const receipt = await handle.prompt('nested')
    const request = await fake.admitted()
    await fake.started(receipt.turnId)
    const spawnChild = async (
      parentSession: string,
      parentUser: string,
      childSession: string,
      call: string,
    ) => {
      fake.sessions.set(childSession, {
        id: childSession,
        directory: fake.cwd,
        parentID: parentSession,
      })
      fake.send('session.created', {
        sessionID: childSession,
        info: fake.sessions.get(childSession),
      })
      const childUser = newNativeId('msg')
      fake.user(childUser, childSession)
      fake.status[childSession] = { type: 'busy' }
      const task = fake.assistant(
        parentUser,
        '',
        parentSession,
        'tool-calls',
        false,
      )
      task.parts = [
        {
          id: newNativeId('prt'),
          sessionID: parentSession,
          messageID: task.info.id,
          type: 'tool',
          callID: call,
          tool: 'task',
          state: {
            status: 'completed',
            input: {},
            output: 'started',
            metadata: {
              sessionId: childSession,
              parentSessionId: parentSession,
              background: true,
            },
          },
        },
      ]
      fake.put(task)
      const event = await fake.wait(() =>
        fake.events.find(
          (event) =>
            event.type === 'child_started' &&
            event.providerRunId === childSession,
        ),
      )
      return { childUser, event }
    }
    const outer = await spawnChild(
      'ses_fixture',
      String(request.body!.messageID),
      'ses_outer',
      'outer-call',
    )
    const inner = await spawnChild(
      'ses_outer',
      outer.childUser,
      'ses_inner',
      'inner-call',
    )
    if (
      outer.event.type !== 'child_started' ||
      inner.event.type !== 'child_started'
    )
      throw new Error('Missing child')
    expect(inner.event.parentChildId).toBe(outer.event.childId)
    expect(inner.event.parentToolCallId).not.toBe(outer.event.parentToolCallId)
    const native = {
      ...wire.permission,
      id: 'per_inner',
      sessionID: 'ses_inner',
    }
    fake.permissions.push(native)
    fake.send('permission.asked', native)
    const permission = await fake.wait(() =>
      fake.events.find(
        (event) =>
          event.type === 'permission_requested' &&
          event.providerRunId === 'ses_inner',
      ),
    )
    if (permission.type !== 'permission_requested')
      throw new Error('Missing permission')
    expect(permission.childId).toBe(inner.event.childId)
    await handle.replyPermission!({
      type: 'denied',
      requestId: permission.request.requestId,
      reason: 'No',
    })
    expect(
      fake.records.find((record) => record.path.endsWith('/per_inner/reply'))!
        .body,
    ).toEqual({ reply: 'reject', message: 'No' })
    const final = fake.assistant(
      inner.childUser,
      'partial',
      'ses_inner',
      'stop',
      false,
    )
    final.info.error = { name: 'UnknownError', data: { message: 'failed' } }
    fake.put(final)
    fake.idle('ses_inner')
    const finished = await fake.wait(() =>
      fake.events.find(
        (event) =>
          event.type === 'child_finished' &&
          event.providerRunId === 'ses_inner',
      ),
    )
    expect(finished).toMatchObject({
      outcome: { status: 'failed' },
      runId: receipt.runId,
      turnId: receipt.turnId,
    })
    expect(fake.events.some((event) => event.type === 'turn_completed')).toBe(
      false,
    )
  })

  it('rejects two task calls that compete for one child without assigning a second invocation', async () => {
    const fake = await peer()
    const handle = await fake.spawn()
    const receipt = await handle.prompt('competing')
    const request = await fake.admitted()
    await fake.started(receipt.turnId)
    fake.sessions.set('ses_competing', {
      id: 'ses_competing',
      parentID: 'ses_fixture',
      directory: fake.cwd,
    })
    fake.send('session.created', {
      sessionID: 'ses_competing',
      info: fake.sessions.get('ses_competing'),
    })
    fake.user(newNativeId('msg'), 'ses_competing')
    const row = fake.assistant(
      String(request.body!.messageID),
      '',
      'ses_fixture',
      'tool-calls',
      false,
    )
    row.parts = ['call-one', 'call-two'].map((callID) => ({
      id: newNativeId('prt'),
      sessionID: 'ses_fixture',
      messageID: row.info.id,
      type: 'tool',
      tool: 'task',
      callID,
      state: {
        status: 'running',
        input: {},
        metadata: {
          sessionId: 'ses_competing',
          parentSessionId: 'ses_fixture',
        },
      },
    }))
    fake.put(row)
    fake.idle()
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      code: 'OPENCODE_OWNERSHIP_GAP',
    })
    expect(
      fake.events.filter((event) => event.type === 'child_started').length,
    ).toBeLessThan(2)
    const count = fake.events.length
    fake.user(newNativeId('msg'), 'ses_competing')
    fake.idle('ses_competing')
    expect(fake.events).toHaveLength(count)
  })

  it('rejects a reused child whose immutable ancestry differs from the current task parent', async () => {
    const fake = await peer()
    const handle = await fake.spawn()
    const receipt = await handle.prompt('ancestry')
    const request = await fake.admitted()
    await fake.started(receipt.turnId)
    fake.sessions.set('ses_foreign', {
      id: 'ses_foreign',
      parentID: 'ses_original_parent',
      directory: fake.cwd,
    })
    fake.user(newNativeId('msg'), 'ses_foreign', false)
    const row = fake.assistant(
      String(request.body!.messageID),
      '',
      'ses_fixture',
      'tool-calls',
      false,
    )
    row.parts = [
      {
        id: newNativeId('prt'),
        sessionID: 'ses_fixture',
        messageID: row.info.id,
        type: 'tool',
        tool: 'task',
        callID: 'reused',
        state: {
          status: 'completed',
          input: {},
          output: 'old result',
          metadata: {
            sessionId: 'ses_foreign',
            parentSessionId: 'ses_fixture',
          },
        },
      },
    ]
    fake.put(row)
    fake.idle()
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      code: 'OPENCODE_OWNERSHIP_GAP',
    })
    expect(fake.sessions.get('ses_foreign')!.parentID).toBe(
      'ses_original_parent',
    )
  })

  it('expires a question with one native rejection and disables its original resolver', async () => {
    const fake = await peer()
    const handle = await fake.spawn({ limits: { requestLifetimeMs: 50 } })
    const receipt = await handle.prompt('expiry')
    await fake.started(receipt.turnId)
    fake.questions.push(wire.question)
    fake.send('question.asked', wire.question)
    const asked = await fake.wait(() =>
      fake.events.find((event) => event.type === 'question_requested'),
    )
    await fake.wait(() =>
      fake.events.find((event) => event.type === 'request_cancelled'),
    )
    expect(
      fake.records.filter((record) =>
        record.path.endsWith('/que_fixture/reject'),
      ),
    ).toHaveLength(1)
    if (asked.type !== 'question_requested') throw new Error('Missing question')
    await expect(
      handle.rejectQuestion(asked.request.requestId),
    ).rejects.toThrow()
  })

  it('rejects only an overflowing owned question before runtime retirement', async () => {
    const fake = await peer()
    const handle = await fake.spawn({ limits: { requestCount: 1 } })
    const receipt = await handle.prompt('capacity')
    await fake.started(receipt.turnId)
    fake.questions.push(wire.question)
    fake.send('question.asked', wire.question)
    await fake.wait(() =>
      fake.events.find((event) => event.type === 'question_requested'),
    )
    const overflow = { ...wire.question, id: 'que_overflow' }
    fake.questions.push(overflow)
    fake.send('question.asked', overflow)
    expect((await receipt.completion).status).toBe('failed')
    expect(
      fake.records
        .filter((record) => record.path.endsWith('/reject'))
        .map((record) => record.path),
    ).toEqual(['/question/que_overflow/reject'])
  })

  it('does not reuse the original reply while native presence remains uncertain', async () => {
    const fake = await peer()
    const handle = await fake.spawn({ limits: { recoveryMs: 80 } })
    const receipt = await handle.prompt('locked')
    await fake.started(receipt.turnId)
    fake.questions.push(wire.question)
    fake.send('question.asked', wire.question)
    const asked = await fake.wait(() =>
      fake.events.find((event) => event.type === 'question_requested'),
    )
    if (asked.type !== 'question_requested') throw new Error('Missing question')
    fake.state.hook = (request, response) => {
      if (!request.path.endsWith('/que_fixture/reject')) return false
      response.destroy()
      return true
    }
    const first = handle.rejectQuestion(asked.request.requestId)
    const observed = first.catch((error) => error)
    await fake.wait(() =>
      fake.records.find((record) =>
        record.path.endsWith('/que_fixture/reject'),
      ),
    )
    await expect(
      handle.rejectQuestion(asked.request.requestId),
    ).rejects.toMatchObject({ code: 'OPENCODE_REQUEST_BUSY' })
    await observed
    expect(
      fake.records.filter((record) =>
        record.path.endsWith('/que_fixture/reject'),
      ),
    ).toHaveLength(1)
  })
})

async function peer() {
  const cwd = await mkdtemp(join(tmpdir(), 'forge opencode ž-'))
  const records: Recorded[] = []
  const events: HarnessEvent[] = []
  const streams = new Set<ServerResponse>()
  const listeners = new Set<() => void>()
  const histories = new Map<string, Row[]>([['ses_fixture', []]])
  const sessions = new Map<string, Record<string, unknown>>([
    [
      'ses_fixture',
      {
        id: 'ses_fixture',
        slug: 'fixture',
        projectID: 'fixture',
        title: 'Fixture',
        version: '1.18.26',
        time: { created: 1, updated: 1 },
        directory: cwd,
        model: { providerID: 'fake', id: 'model/a' },
      },
    ],
  ])
  const status: Record<string, unknown> = {}
  const questions: Record<string, unknown>[] = []
  const permissions: Record<string, unknown>[] = []
  let eventId = 0
  const state = {
    commands: structuredClone(wire.commands),
    agents: structuredClone(wire.agents),
    provider: structuredClone(wire.provider),
    config: {} as Record<string, unknown>,
    hook: undefined as
      | undefined
      | ((
          request: Recorded,
          response: ServerResponse,
        ) => boolean | Promise<boolean>),
    connections: 0,
    sessionStatus: 200,
  }
  const pulse = () => {
    for (const listener of listeners) listener()
  }
  const wait = <T>(predicate: () => T | undefined | false): Promise<T> => {
    const value = predicate()
    if (value) return Promise.resolve(value)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check)
        reject(new Error('Fixture barrier did not arrive'))
      }, 4000)
      const check = () => {
        const result = predicate()
        if (result) {
          clearTimeout(timer)
          listeners.delete(check)
          resolve(result)
        }
      }
      listeners.add(check)
    })
  }
  const send = (
    type: string,
    properties: Record<string, unknown>,
    id = `evt_${++eventId}`,
  ) => {
    const value = { directory: cwd, payload: { id, type, properties } }
    for (const stream of streams)
      stream.write(`data: ${JSON.stringify(value)}\n\n`)
    pulse()
    return value
  }
  const put = (row: Row, live = true) => {
    const id = String(row.info.sessionID)
    const rows = histories.get(id) ?? []
    const index = rows.findIndex((existing) => existing.info.id === row.info.id)
    if (index < 0) rows.push(row)
    else rows[index] = row
    rows.sort((a, b) => (String(a.info.id) < String(b.info.id) ? -1 : 1))
    histories.set(id, rows)
    if (live) {
      send('message.updated', { sessionID: id, info: row.info })
      for (const part of row.parts)
        send('message.part.updated', { sessionID: id, part, time: 1 })
    }
    pulse()
    return row
  }
  const user = (id: string, sessionID = 'ses_fixture', live = true) =>
    put(
      {
        info: {
          id,
          sessionID,
          role: 'user',
          time: { created: 1 },
          model: { providerID: 'fake', modelID: 'model/a' },
        },
        parts: [],
      },
      live,
    )
  const selectModel = (row: Row, variant?: string) => {
    const sessionID = String(row.info.sessionID)
    const session = sessions.get(sessionID)!
    const model = row.info.model as { providerID: string; modelID: string }
    session.model = {
      providerID: model.providerID,
      id: model.modelID,
      variant: variant ?? 'default',
    }
    session.time = {
      ...(session.time as object),
      updated: (row.info.time as { created: number }).created,
    }
    send('session.updated', { sessionID, info: session })
  }
  const assistant = (
    parentID: string,
    text = 'answer',
    sessionID = 'ses_fixture',
    finish: string | undefined = 'stop',
    live = true,
  ) => {
    const id = newNativeId('msg')
    const partId = newNativeId('prt')
    return put(
      {
        info: {
          id,
          parentID,
          sessionID,
          role: 'assistant',
          time: { created: 1, ...(finish ? { completed: 2 } : {}) },
          ...(finish ? { finish } : {}),
          tokens: {
            input: 2,
            output: 3,
            reasoning: 1,
            cache: { read: 4, write: 5 },
            total: 0,
          },
          providerID: 'fake',
          modelID: 'model/a',
        },
        parts: [{ id: partId, messageID: id, sessionID, type: 'text', text }],
      },
      live,
    )
  }
  const idle = (
    sessionID = 'ses_fixture',
    encoding: 'status' | 'idle' = 'status',
  ) => {
    delete status[sessionID]
    send(encoding === 'idle' ? 'session.idle' : 'session.status', {
      sessionID,
      ...(encoding === 'status' ? { status: { type: 'idle' } } : {}),
    })
  }
  const server = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const text = Buffer.concat(chunks).toString('utf8')
      const url = new URL(request.url!, 'http://fixture')
      const record: Recorded = {
        method: request.method!,
        path: url.pathname,
        url,
        body: text ? JSON.parse(text) : undefined,
        headers: request.headers,
      }
      records.push(record)
      pulse()
      if (await state.hook?.(record, response)) return
      const path = url.pathname
      if (path === '/global/event') {
        state.connections++
        streams.add(response)
        response.on('close', () => {
          streams.delete(response)
          pulse()
        })
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(
          `data: ${JSON.stringify({ directory: cwd, payload: { id: `evt_${++eventId}`, type: 'server.connected', properties: {} } })}\n\n`,
        )
        pulse()
        return
      }
      let result: unknown
      if (path === '/global/health')
        result = { healthy: true, version: '1.18.26' }
      else if (path === '/path') result = { directory: cwd }
      else if (path === '/provider') result = state.provider
      else if (path === '/agent') result = state.agents
      else if (path === '/command') result = state.commands
      else if (path === '/config') result = state.config
      else if (path === '/session/status') result = status
      else if (path === '/session') result = sessions.get('ses_fixture')
      else if (path === '/question') result = questions
      else if (path === '/permission') result = permissions
      else if (/^\/(question|permission)\/[^/]+\/(reply|reject)$/.test(path)) {
        const list = path.startsWith('/question') ? questions : permissions
        const index = list.findIndex((entry) => entry.id === path.split('/')[2])
        if (index < 0) {
          response.writeHead(404).end('{}')
          return
        }
        list.splice(index, 1)
        result = true
      } else {
        const [, , id, operation] = path.split('/')
        if (!sessions.has(id!)) {
          response.writeHead(404).end('{}')
          return
        }
        if (!operation) {
          response
            .writeHead(state.sessionStatus, {
              'content-type': 'application/json',
            })
            .end(JSON.stringify(sessions.get(id!)))
          return
        }
        if (operation === 'children')
          result = [...sessions.values()].filter(
            (session) => session.parentID === id,
          )
        else if (operation === 'message') result = histories.get(id!) ?? []
        else if (operation === 'prompt_async' || operation === 'command') {
          status[id!] = { type: 'busy' }
          const body = record.body!
          const command =
            operation === 'command'
              ? state.commands.find(
                  (entry: { name: string }) => entry.name === body.command,
                )
              : undefined
          const agent = state.agents.find(
            (entry: { name: string }) => entry.name === command?.agent,
          )
          const selected = command?.model ?? agent?.model ?? body.model
          const current = sessions.get(id!)!.model as
            { providerID: string; id: string } | undefined
          const historical = [...(histories.get(id!) ?? [])]
            .reverse()
            .find((row) => row.info.role === 'user' && row.info.model)
          const model =
            typeof selected === 'string'
              ? {
                  providerID: selected.slice(0, selected.indexOf('/')),
                  modelID: selected.slice(selected.indexOf('/') + 1),
                }
              : (selected ??
                (current
                  ? { providerID: current.providerID, modelID: current.id }
                  : historical?.info.model) ?? {
                  providerID: 'fake',
                  modelID: 'model/a',
                })
          const row = user(String(body.messageID), id, false)
          row.info.model = model
          selectModel(row, body.variant as string | undefined)
          put(row)
          if (operation === 'prompt_async') {
            response.writeHead(204).end()
            return
          }
          result = assistant(
            String(record.body!.messageID),
            'command answer',
            id,
            'stop',
            false,
          )
          Object.assign((result as Row).info, model)
          put(result as Row)
          idle(id)
        } else if (operation === 'abort') {
          idle(id)
          result = true
        } else {
          response.writeHead(404).end('{}')
          return
        }
      }
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(result))
      pulse()
    } catch {
      response.writeHead(500).end('{}')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing fixture origin')
  const origin = `http://127.0.0.1:${address.port}`
  const scope = { provider: 'test-opencode', accountId: null, cwd }
  const options = (
    extra: Partial<OpenCodeAdapterOptions> = {},
  ): OpenCodeAdapterOptions => ({
    ...scope,
    server: {
      mode: 'attached',
      origin,
      connectionId: 'connection-A',
      scope,
      exclusiveSession: true,
      auth: { username: 'fixture', password: 'fixture-secret' },
    },
    ...extra,
  })
  const emit = (event: HarnessEvent) => {
    events.push(harnessEventSchema.parse(event))
    pulse()
  }
  const spawn = async (extra: Partial<OpenCodeAdapterOptions> = {}) => {
    const adapter = createOpenCodeAdapter(options(extra))
    const handle = await adapter.spawn({ id: 'forge-session', ...scope }, emit)
    cleanups.push(async () => {
      await handle.kill()
    })
    return handle
  }
  const admitted = () =>
    wait(() =>
      [...records]
        .reverse()
        .find(
          (record) =>
            record.method === 'POST' &&
            (record.path.endsWith('/prompt_async') ||
              record.path.endsWith('/command')),
        ),
    )
  const started = (turnId: string) =>
    wait(() =>
      events.find(
        (event) => event.type === 'turn_started' && event.turnId === turnId,
      ),
    )
  cleanups.push(async () => {
    for (const stream of streams) stream.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(cwd, { force: true, recursive: true })
  })
  return {
    cwd,
    scope,
    origin,
    records,
    events,
    histories,
    sessions,
    status,
    questions,
    permissions,
    state,
    streams,
    send,
    put,
    user,
    selectModel,
    assistant,
    idle,
    options,
    emit,
    spawn,
    wait,
    pulse,
    admitted,
    started,
  }
}

describe('OpenCode public HTTP/SSE adapter', () => {
  it('confirms binding and scope, keeps native model IDs, and completes only its owned transcript', async () => {
    const fake = await peer()
    const handle = await fake.spawn()
    expect(handle.binding).toEqual({
      ...fake.scope,
      providerSessionId: 'ses_fixture',
    })
    expect(Object.isFrozen(handle.binding)).toBe(true)
    expect(Object.isFrozen(handle.attachedResumeScope)).toBe(true)
    expect(handle.availableModels?.[0]?.id).toBe('fake/model/a')
    const receipt = await handle.prompt('hello', undefined, {
      runId: 'run-A',
      turnId: 'turn-A',
    })
    const request = await fake.admitted()
    await fake.started(receipt.turnId)
    expect(request.body).toMatchObject({
      messageID: expect.stringMatching(/^msg_[0-9a-f]+[A-Za-z0-9]+$/),
      parts: [{ type: 'text', text: 'hello' }],
    })
    expect(request.headers['x-opencode-directory']).toBe(
      encodeURIComponent(fake.cwd),
    )
    expect(request.headers.authorization).toBe(
      `Basic ${Buffer.from('fixture:fixture-secret').toString('base64')}`,
    )
    fake.idle('ses_other')
    fake.idle()
    fake.send('session.error', { error: { message: 'unowned' } })
    expect(fake.events.some((event) => event.type === 'turn_completed')).toBe(
      false,
    )
    fake.assistant(String(request.body!.messageID))
    fake.idle('ses_fixture', 'idle')
    expect(await receipt.completion).toEqual({
      status: 'completed',
      runId: 'run-A',
      turnId: 'turn-A',
    })
    expect(
      fake.events.filter((event) => event.type === 'turn_completed'),
    ).toHaveLength(1)
    const usage = fake.events.find((event) => event.type === 'usage')
    expect(usage).toMatchObject({
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 0,
      cachedInputTokens: 4,
      cacheWriteInputTokens: 5,
      reasoningOutputTokens: 1,
    })
    const timeline = fake.events.reduce(
      (state, event, index) =>
        reduceTimeline(state, { kind: 'delta', cursor: index + 1, event }),
      emptyTimeline(),
    )
    expect(timeline.terminal).toBe('completed')
    const writes = fake.records.filter(
      (record) => record.method !== 'GET',
    ).length
    await handle.kill()
    expect(
      fake.records.filter((record) => record.method !== 'GET'),
    ).toHaveLength(writes)
    expect((await fetch(fake.origin + '/global/health')).status).toBe(200)
    expect(handle.binding?.providerSessionId).toBe('ses_fixture')
  })

  it('loads only the saved connection and never creates a fallback session', async () => {
    const fake = await peer()
    const handle = await fake.spawn()
    await handle.kill()
    const session = {
      id: 'forge-session',
      ...fake.scope,
      binding: handle.binding,
    }
    const before = fake.records.length
    for (const change of [
      {},
      {
        attachedResumeScopes: new Map([
          [
            'forge-session',
            { ...handle.attachedResumeScope!, connectionId: 'B' },
          ],
        ]),
      },
      {
        attachedResumeScopes: new Map([
          [
            'forge-session',
            { ...handle.attachedResumeScope!, origin: 'http://127.0.0.1:1' },
          ],
        ]),
      },
    ]) {
      await expect(
        createOpenCodeAdapter(fake.options(change)).load(session, fake.emit),
      ).rejects.toMatchObject({ code: 'OPENCODE_RESUME_SCOPE_MISMATCH' })
    }
    expect(fake.records).toHaveLength(before)
    const options = fake.options({
      attachedResumeScopes: new Map([
        ['forge-session', handle.attachedResumeScope!],
      ]),
    })
    const loaded = await createOpenCodeAdapter(options).load(session, fake.emit)
    cleanups.push(async () => {
      await loaded.kill()
    })
    expect(loaded.binding).toEqual(handle.binding)
    await loaded.kill()
    fake.state.sessionStatus = 404
    await expect(
      createOpenCodeAdapter(options).load(session, fake.emit),
    ).rejects.toThrow()
    expect(
      fake.records.filter(
        (record) => record.path === '/session' && record.method === 'POST',
      ),
    ).toHaveLength(1)
  })

  it.each(['provider', 'account', 'cwd', 'id', 'busy'])(
    'rejects an incompatible %s load',
    async (kind) => {
      const fake = await peer()
      const initial = await fake.spawn()
      await initial.kill()
      const session = {
        id: 'forge-session',
        ...fake.scope,
        binding: initial.binding,
      }
      if (kind === 'provider') session.provider = 'different'
      if (kind === 'account')
        session.binding = { ...initial.binding!, accountId: 'different' }
      if (kind === 'cwd')
        fake.sessions.get('ses_fixture')!.directory = '/different'
      if (kind === 'id') fake.sessions.get('ses_fixture')!.id = 'ses_wrong'
      if (kind === 'busy') fake.status.ses_fixture = { type: 'busy' }
      await expect(
        createOpenCodeAdapter(
          fake.options({
            attachedResumeScopes: new Map([
              ['forge-session', initial.attachedResumeScope!],
            ]),
          }),
        ).load(session, fake.emit),
      ).rejects.toThrow()
      expect(
        fake.records.filter(
          (record) => record.path === '/session' && record.method === 'POST',
        ),
      ).toHaveLength(1)
    },
  )

  it('reserves input before resolving attachments and preserves input/options copies', async () => {
    const fake = await peer()
    const read = deferred<{
      attachmentId: string
      mime: string
      filename: string
      sizeBytes: number
      bytes: Uint8Array
    }>()
    let reads = 0
    const handle = await fake.spawn({
      defaults: { model: 'fake/model/a' },
      resolveAttachment: async () => {
        reads++
        return read.promise
      },
    })
    const input: PromptInput[] = [
      { type: 'text', text: 'before' },
      { type: 'attachment', attachmentId: 'file', mime: 'text/plain' },
      { type: 'text', text: 'after' },
    ]
    const options = {
      model: 'fake/model/a',
      reasoning: 'deep',
      permissionMode: 'manual' as const,
    }
    const receipt = await handle.prompt(input, options)
    input[0] = { type: 'text', text: 'mutated' }
    options.reasoning = 'wrong'
    expect(() => handle.prompt('racing')).toThrow(/foreground input/)
    const next = handle.queue('next')
    expect(reads).toBe(1)
    const exact = Buffer.from('ž text')
    read.resolve({
      attachmentId: 'file',
      mime: 'text/plain',
      filename: 'f.txt',
      sizeBytes: exact.length,
      bytes: exact,
    })
    const request = await fake.admitted()
    await fake.started(receipt.turnId)
    const parts = request.body!.parts as Record<string, unknown>[]
    expect(parts.map((part) => part.type)).toEqual(['text', 'file', 'text'])
    expect(parts[0]!.text).toBe('before')
    expect(parts[2]!.text).toBe('after')
    expect(Buffer.from(String(parts[1]!.url).split(',')[1]!, 'base64')).toEqual(
      exact,
    )
    expect(request.body!.variant).toBe('deep')
    fake.assistant(String(request.body!.messageID))
    fake.idle()
    expect((await receipt.completion).status).toBe('completed')
    const second = await fake.wait(
      () =>
        fake.records.filter((record) =>
          record.path.endsWith('/prompt_async'),
        )[1],
    )
    await fake.started(next.turnId)
    fake.assistant(String(second.body!.messageID))
    fake.idle()
    expect((await next.completion).status).toBe('completed')
  })

  it.each(['resolve', 'reject'])(
    'keeps cancelled actual attachment work charged until late %s',
    async (ending) => {
      const fake = await peer()
      const read = deferred<never>()
      let reads = 0
      const handle = await fake.spawn({
        defaults: { model: 'fake/model/a' },
        limits: { preparationMs: 60 },
        resolveAttachment: () => {
          reads++
          return read.promise
        },
      })
      const receipt = await handle.prompt([
        { type: 'attachment', attachmentId: 'held', mime: 'text/plain' },
      ])
      await handle.cancel()
      await handle.cancel()
      expect((await receipt.completion).status).toBe('interrupted')
      expect(() => handle.prompt('second')).toThrow(/foreground/)
      const queued = handle.queue('queued')
      expect((await queued.completion).status).toBe('failed')
      expect(reads).toBe(1)
      if (ending === 'reject') read.reject(new Error('late resolver rejection'))
      else read.resolve({ bytes: new Uint8Array(9 * 1024 * 1024) } as never)
      await read.promise.catch(() => {})
      expect(
        fake.records.filter((record) => record.path.endsWith('/prompt_async')),
      ).toHaveLength(0)
    },
  )

  it.each(['lost-found', 'lost-final', 'lost-absent', 'server-error'])(
    'never repeats a prompt after %s delivery',
    async (mode) => {
      const fake = await peer()
      const handle = await fake.spawn({ limits: { recoveryMs: 200 } })
      fake.state.hook = (request, response) => {
        if (!request.path.endsWith('/prompt_async')) return false
        if (mode === 'lost-found' || mode === 'lost-final')
          fake.user(String(request.body!.messageID), 'ses_fixture', false)
        if (mode === 'lost-final')
          fake.assistant(
            String(request.body!.messageID),
            'retained final',
            'ses_fixture',
            'stop',
            false,
          )
        if (mode === 'server-error') response.writeHead(500).end('{}')
        else response.destroy()
        return true
      }
      const receipt = await handle.prompt('uncertain')
      const queued = handle.queue('queued')
      const request = await fake.admitted()
      if (mode === 'lost-found') {
        await fake.started(receipt.turnId)
        fake.assistant(String(request.body!.messageID))
        fake.idle()
      }
      const result = await receipt.completion
      expect(result.status).toBe(
        mode === 'lost-absent' || mode === 'server-error'
          ? 'failed'
          : 'completed',
      )
      await handle.kill()
      await queued.completion
      expect(
        fake.records.filter(
          (record) => record.body?.messageID === request.body?.messageID,
        ),
      ).toHaveLength(1)
      if (result.status === 'failed')
        expect(
          fake.records.filter((record) =>
            record.path.endsWith('/prompt_async'),
          ),
        ).toHaveLength(1)
    },
  )

  it('uses exact command input, rejects interleaved text, and preserves unknown slash text', async () => {
    const fake = await peer()
    const handle = await fake.spawn()
    expect(() =>
      handle.prompt([
        { type: 'text', text: '/known a' },
        { type: 'text', text: 'extra' },
      ]),
    ).toThrow(/interleaved/)
    const receipt = await handle.prompt('/known  exact\n arguments', {
      model: 'fake/model/a',
      reasoning: 'deep',
      permissionMode: 'manual',
    })
    expect(await receipt.completion).toEqual({
      status: 'completed',
      runId: receipt.runId,
      turnId: receipt.turnId,
    })
    const request = fake.records.find(
      (entry) => entry.method === 'POST' && entry.path.endsWith('/command'),
    )!
    expect(request.body).toMatchObject({
      command: 'known',
      arguments: ' exact\n arguments',
      model: 'fake/model/a',
      variant: 'deep',
      parts: [],
    })
    const unknown = await handle.prompt('/not-known keep exact')
    await fake.started(unknown.turnId)
    expect((await fake.admitted()).body!.parts).toMatchObject([
      { text: '/not-known keep exact' },
    ])
    await handle.cancel()
    expect((await unknown.completion).status).toBe('interrupted')
    expect(
      [...fake.records]
        .reverse()
        .find((entry) => entry.path.endsWith('/abort'))!.body,
    ).toBeUndefined()
  })

  it.each([
    'subtask',
    'subagent',
    'subagent-false',
    'unknown',
    'missing-default',
    'hidden-default',
    'subagent-default',
  ])('rejects %s commands before resolver or shell work', async (mode) => {
    const fake = await peer()
    let reads = 0
    if (mode === 'subtask') fake.state.commands[0].subtask = true
    if (mode.startsWith('subagent')) {
      fake.state.agents[0].mode = 'subagent'
      if (mode === 'subagent-false') fake.state.commands[0].subtask = false
    }
    if (mode === 'unknown') fake.state.commands[0].agent = 'missing'
    if (mode === 'missing-default') fake.state.config.default_agent = 'missing'
    if (mode === 'hidden-default') {
      fake.state.config.default_agent = 'build'
      fake.state.agents[0].hidden = true
    }
    if (mode === 'subagent-default') fake.state.config.default_agent = 'build'
    const handle = await fake.spawn({
      defaults: { model: 'fake/model/a' },
      resolveAttachment: async () => {
        reads++
        throw new Error('Must not run')
      },
    })
    expect(handle.discovery.commands[0]!.executable).toBe(false)
    expect(() =>
      handle.prompt([
        { type: 'text', text: '/known args' },
        { type: 'attachment', attachmentId: 'file', mime: 'text/plain' },
      ]),
    ).toThrow()
    expect(reads).toBe(0)
    expect(
      fake.records.some(
        (record) =>
          record.method === 'POST' && record.path.endsWith('/command'),
      ),
    ).toBe(false)
  })

  it('keeps explicit hidden agent lookup and enforces configured command model precedence', async () => {
    const fake = await peer()
    fake.state.agents[0].hidden = true
    fake.state.commands[0].agent = 'build'
    fake.state.commands[0].model = 'fake/b'
    const handle = await fake.spawn()
    expect(handle.discovery.commands[0]).toMatchObject({
      executable: true,
      configuredModel: 'fake/b',
    })
    expect(() =>
      handle.prompt('/known', {
        model: 'fake/model/a',
        permissionMode: 'manual',
      }),
    ).toThrow(/conflicts/)
    expect(() =>
      handle.prompt('/known', { reasoning: 'deep', permissionMode: 'manual' }),
    ).toThrow(/variant/)
    expect(() =>
      handle.prompt([
        { type: 'text', text: '/known' },
        { type: 'attachment', attachmentId: 'file', mime: 'image/png' },
      ]),
    ).toThrow()
    fake.state.hook = (request, response) => {
      if (request.method !== 'POST' || !request.path.endsWith('/command'))
        return false
      const row = fake.user(
        String(request.body!.messageID),
        'ses_fixture',
        false,
      )
      row.info.model = { providerID: 'fake', modelID: 'b' }
      fake.put(row)
      const result = fake.assistant(
        String(request.body!.messageID),
        'B',
        'ses_fixture',
        'stop',
        false,
      )
      result.info.modelID = 'b'
      fake.put(result)
      fake.idle()
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(result))
      return true
    }
    const receipt = await handle.prompt('/known', {
      model: 'fake/b',
      reasoning: 'brief',
      permissionMode: 'manual',
    })
    expect((await receipt.completion).status).toBe('completed')
  })

  it('keeps command shell preparation outside the ordinary first-activity watchdog', async () => {
    const fake = await peer()
    const shell = deferred<void>()
    const entered = deferred<void>()
    const handle = await fake.spawn({
      limits: { activityMs: 1, commandMs: 1000 },
    })
    fake.state.hook = async (request, response) => {
      if (request.method !== 'POST' || !request.path.endsWith('/command'))
        return false
      entered.resolve()
      await shell.promise
      fake.user(String(request.body!.messageID))
      const result = fake.assistant(String(request.body!.messageID))
      fake.idle()
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(result))
      return true
    }
    const receipt = await handle.prompt('/known')
    await entered.promise
    // A completed native read provides a barrier after the shortened watchdog would fire.
    for (let index = 0; index < 4; index++)
      await fetch(fake.origin + '/global/health')
    expect(fake.events.some((event) => event.type === 'turn_completed')).toBe(
      false,
    )
    shell.resolve()
    expect((await receipt.completion).status).toBe('completed')
  })

  it('rejects changed-plugin U1/task/U2 completion without borrowing U2', async () => {
    const fake = await peer()
    const handle = await fake.spawn()
    fake.state.hook = (request, response) => {
      if (request.method !== 'POST' || !request.path.endsWith('/command'))
        return false
      fake.user(String(request.body!.messageID))
      fake.assistant(
        String(request.body!.messageID),
        '',
        'ses_fixture',
        'tool-calls',
      )
      const u2 = newNativeId('msg')
      fake.user(u2)
      const summary = fake.assistant(u2, 'synthetic summary')
      fake.idle()
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(summary))
      return true
    }
    const receipt = await handle.prompt('/known')
    expect((await receipt.completion).status).toBe('failed')
    expect(
      fake.events.filter((event) => event.type === 'turn_completed'),
    ).toHaveLength(1)
  })

  it('preserves Todo array values through status changes, duplicate content, reordering and empty replacement', async () => {
    const fake = await peer()
    const handle = await fake.spawn()
    const receipt = await handle.prompt('plan')
    await fake.started(receipt.turnId)
    const arrays = [
      [
        { content: 'same', status: 'pending', priority: 'high' },
        { content: 'same', status: 'in_progress', priority: 'low' },
      ],
      [
        { content: 'same', status: 'completed', priority: 'low' },
        { content: 'same', status: 'pending', priority: 'high' },
      ],
      [],
    ]
    for (const todos of arrays) {
      fake.send('todo.updated', { sessionID: 'ses_fixture', todos })
      fake.send('todo.updated', { sessionID: 'ses_fixture', todos })
    }
    await fake.wait(
      () =>
        fake.events.filter(
          (event) =>
            event.type === 'content_snapshot' && event.contentType === 'plan',
        ).length === 3,
    )
    const snapshots = fake.events
      .filter((event) => event.type === 'content_snapshot')
      .filter((event) => event.contentType === 'plan')
    expect(snapshots.map((event) => JSON.parse(event.text))).toEqual(arrays)
    expect(new Set(snapshots.map((event) => event.itemId)).size).toBe(1)
    expect(snapshots.every((event) => event.turnId === receipt.turnId)).toBe(
      true,
    )
    expect(
      fake.events.some((event) => event.type === 'permission_requested'),
    ).toBe(false)
  })

  it('keeps one ordered question resolver through invalid, mixed, and skipped replies', async () => {
    const fake = await peer()
    const handle = await fake.spawn()
    const receipt = await handle.prompt('question')
    await fake.started(receipt.turnId)
    const question = structuredClone(wire.question)
    fake.questions.push(question)
    fake.send('question.asked', question, 'evt_question')
    fake.send('question.asked', question, 'evt_question')
    const event = await fake.wait(() =>
      fake.events.find((event) => event.type === 'question_requested'),
    )
    if (event.type !== 'question_requested') throw new Error('Missing question')
    expect(event.request.questions[0]!.allowFreeInput).toBe(true)
    expect(() => handle.replyQuestion!(event.request.requestId, {})).toThrow()
    expect(() =>
      handle.replyQuestion!(event.request.requestId, {
        q0: { type: 'selected', optionIds: ['o99'] },
        q1: { type: 'skipped' },
      }),
    ).toThrow()
    expect(() =>
      handle.replyQuestion!(event.request.requestId, {
        q0: { type: 'selected', optionIds: ['o0', 'o1'] },
        q1: { type: 'skipped' },
      }),
    ).toThrow()
    await handle.replyQuestion!(event.request.requestId, {
      q0: { type: 'selected', optionIds: ['o1'] },
      q1: { type: 'selected_with_text', optionIds: ['o0'], text: 'Other' },
    })
    expect(
      fake.records.find((record) => record.path.endsWith('/que_fixture/reply'))!
        .body,
    ).toEqual({ answers: [['Second'], ['Third', 'Other']] })
    expect(
      fake.events.filter((event) => event.type === 'question_requested'),
    ).toHaveLength(1)
    expect(
      fake.events.filter((event) => event.type === 'request_cancelled'),
    ).toHaveLength(0)
    expect(() => handle.replyQuestion!(event.request.requestId, {})).toThrow()
    for (const [id, answers] of [
      [
        'que_skip_mixed',
        { q0: { type: 'skipped' }, q1: { type: 'free_text', text: 'text' } },
      ],
      ['que_skip_all', { q0: { type: 'skipped' }, q1: { type: 'skipped' } }],
    ] as Array<[string, Record<string, QuestionAnswer>]>) {
      const count = fake.events.filter(
        (event) => event.type === 'question_requested',
      ).length
      const next = { ...question, id }
      fake.questions.push(next)
      fake.send('question.asked', next)
      const request = await fake.wait(
        () =>
          fake.events.filter((event) => event.type === 'question_requested')
            .length > count &&
          fake.events
            .filter((event) => event.type === 'question_requested')
            .at(-1),
      )
      await handle.replyQuestion!(request.request.requestId, answers)
      expect(
        fake.records.find((record) => record.path.endsWith(`/${id}/reply`))!
          .body,
      ).toEqual({ answers: id === 'que_skip_all' ? [[], []] : [[], ['text']] })
    }
  })

  it('separates explicit question rejection and stale-generation replies', async () => {
    const fake = await peer()
    const handle = await fake.spawn()
    const receipt = await handle.prompt('question')
    await fake.started(receipt.turnId)
    fake.questions.push(wire.question)
    fake.send('question.asked', wire.question)
    const request = await fake.wait(() =>
      fake.events.find((event) => event.type === 'question_requested'),
    )
    if (request.type !== 'question_requested')
      throw new Error('Missing question')
    await handle.rejectQuestion(request.request.requestId)
    expect(
      fake.records.find((record) =>
        record.path.endsWith('/que_fixture/reject'),
      )!.body,
    ).toBeUndefined()
    await handle.kill()
    const count = fake.records.length
    await expect(
      handle.rejectQuestion(request.request.requestId),
    ).rejects.toThrow()
    expect(fake.records).toHaveLength(count)
  })

  it.each(['once', 'always', 'reject'])(
    'sends only the selected %s permission option',
    async (choice) => {
      const fake = await peer()
      const handle = await fake.spawn()
      const receipt = await handle.prompt('permission', {
        permissionMode: 'yolo',
      })
      await fake.started(receipt.turnId)
      fake.permissions.push(wire.permission)
      fake.send('permission.asked', wire.permission)
      const event = await fake.wait(() =>
        fake.events.find((event) => event.type === 'permission_requested'),
      )
      if (event.type !== 'permission_requested')
        throw new Error('Missing permission')
      expect(
        fake.records.some((record) => record.path.includes('/per_fixture/')),
      ).toBe(false)
      expect(() =>
        handle.replyPermission!({
          type: 'selected',
          requestId: event.request.requestId,
          optionId: choice,
          scope: 'session',
        }),
      ).toThrow()
      expect(() =>
        handle.replyPermission!({
          type: 'selected',
          requestId: event.request.requestId,
          optionId: 'invalid',
        }),
      ).toThrow()
      await handle.replyPermission!({
        type: 'selected',
        requestId: event.request.requestId,
        optionId: choice,
      })
      expect(
        fake.records.find((record) =>
          record.path.endsWith('/per_fixture/reply'),
        )!.body,
      ).toEqual({ reply: choice })
    },
  )

  it.each(['resolved', 'pending', 'missing', 'invalid'])(
    'handles %s reply delivery without retrying',
    async (mode) => {
      const fake = await peer()
      const handle = await fake.spawn({ limits: { recoveryMs: 80 } })
      const receipt = await handle.prompt('question')
      await fake.started(receipt.turnId)
      fake.questions.push(wire.question)
      fake.send('question.asked', wire.question)
      const event = await fake.wait(() =>
        fake.events.find((event) => event.type === 'question_requested'),
      )
      if (event.type !== 'question_requested')
        throw new Error('Missing question')
      fake.state.hook = (request, response) => {
        if (!request.path.endsWith('/que_fixture/reject')) return false
        if (mode === 'resolved') fake.questions.length = 0
        if (mode === 'missing') response.writeHead(404).end('{}')
        else if (mode === 'invalid') response.writeHead(400).end('{}')
        else response.destroy()
        return true
      }
      await expect(
        handle.rejectQuestion(event.request.requestId),
      ).rejects.toThrow()
      expect(
        fake.records.filter((record) =>
          record.path.endsWith('/que_fixture/reject'),
        ),
      ).toHaveLength(1)
      if (mode === 'invalid') {
        fake.state.hook = undefined
        await handle.rejectQuestion(event.request.requestId)
      } else
        await expect(
          handle.rejectQuestion(event.request.requestId),
        ).rejects.toThrow()
    },
  )

  it('restores missed content after stream loss and never appends a replayed delta', async () => {
    const fake = await peer()
    const handle = await fake.spawn()
    const receipt = await handle.prompt('recover')
    const request = await fake.admitted()
    await fake.started(receipt.turnId)
    const row = fake.assistant(
      String(request.body!.messageID),
      'A',
      'ses_fixture',
      undefined,
    )
    await fake.wait(() =>
      fake.events.find((event) => event.type === 'text_delta'),
    )
    for (const stream of fake.streams) stream.end()
    row.parts[0]!.text = 'AB'
    fake.put(row, false)
    await fake.wait(() => fake.state.connections >= 2)
    fake.send('message.part.delta', {
      sessionID: 'ses_fixture',
      messageID: row.info.id,
      partID: row.parts[0]!.id,
      field: 'text',
      delta: 'B',
    })
    row.info.time = { created: 1, completed: 2 }
    row.info.finish = 'stop'
    fake.put(row, false)
    fake.idle()
    expect((await receipt.completion).status).toBe('completed')
    const text = fake.events
      .filter((event) => event.type === 'text_delta')
      .map((event) => event.text)
      .join('')
    expect(text).toBe('AB')
    expect(
      fake.records
        .filter((record) => record.path === '/global/event')
        .every(
          (record) => !record.headers['last-event-id'] && !record.url.search,
        ),
    ).toBe(true)
    expect(
      fake.events.some(
        (event) =>
          event.type === 'diagnostic' && event.code === 'OPENCODE_STREAM_GAP',
      ),
    ).toBe(true)
  })

  it('replaces shorter and empty text, preserves metadata, and deduplicates exact snapshots', async () => {
    const fake = await peer()
    const handle = await fake.spawn()
    const receipt = await handle.prompt('rewrite')
    const request = await fake.admitted()
    await fake.started(receipt.turnId)
    const row = fake.assistant(
      String(request.body!.messageID),
      'long answer',
      'ses_fixture',
      undefined,
    )
    await fake.wait(() =>
      fake.events.find((event) => event.type === 'text_delta'),
    )
    row.parts[0]!.text = 'short'
    row.parts[0]!.phase = null
    row.parts[0]!.delivery = null
    fake.put(row)
    await fake.wait(() =>
      fake.events.find((event) => event.type === 'content_snapshot'),
    )
    fake.put(row)
    row.parts[0]!.text = ''
    fake.put(row)
    await fake.wait(
      () =>
        fake.events.filter((event) => event.type === 'content_snapshot')
          .length === 2,
    )
    expect(
      fake.events.filter((event) => event.type === 'content_snapshot'),
    ).toMatchObject([
      { text: 'short', phase: null, delivery: null },
      { text: '', phase: null, delivery: null },
    ])
  })

  it('does not finish quiet tools at the first-activity deadline', async () => {
    const fake = await peer()
    const handle = await fake.spawn({ limits: { activityMs: 30 } })
    const receipt = await handle.prompt('tool')
    const request = await fake.admitted()
    await fake.started(receipt.turnId)
    const row = fake.assistant(
      String(request.body!.messageID),
      '',
      'ses_fixture',
      'tool-calls',
      false,
    )
    row.parts = [
      {
        id: newNativeId('prt'),
        sessionID: 'ses_fixture',
        messageID: row.info.id,
        type: 'tool',
        callID: 'call-tool',
        tool: 'bash',
        state: { status: 'running', input: {} },
      },
    ]
    fake.put(row)
    await fake.wait(() =>
      fake.events.find((event) => event.type === 'tool_started'),
    )
    fake.state.hook = (request, response) => {
      if (request.path !== '/fixture/three-activity-intervals') return false
      setTimeout(() => response.writeHead(200).end('{}'), 100)
      return true
    }
    await fetch(fake.origin + '/fixture/three-activity-intervals')
    fake.state.hook = undefined
    fake.idle()
    await fake.wait(
      () =>
        fake.records.filter((record) => record.path.endsWith('/message'))
          .length >= 2,
    )
    expect(fake.events.some((event) => event.type === 'turn_completed')).toBe(
      false,
    )
    row.parts[0]!.state = { status: 'completed', input: {}, output: 'done' }
    fake.put(row)
    fake.assistant(String(request.body!.messageID), 'final')
    fake.idle()
    expect((await receipt.completion).status).toBe('completed')
  })

  it('keeps a fresh background child owned after root completion and a later root prompt', async () => {
    const fake = await peer()
    const handle = await fake.spawn()
    const receipt = await handle.prompt('task')
    const request = await fake.admitted()
    await fake.started(receipt.turnId)
    const childId = 'ses_child'
    fake.sessions.set(childId, {
      id: childId,
      parentID: 'ses_fixture',
      directory: fake.cwd,
    })
    fake.send('session.created', {
      sessionID: childId,
      info: fake.sessions.get(childId),
    })
    const childUser = newNativeId('msg')
    fake.user(childUser, childId)
    fake.status[childId] = { type: 'busy' }
    const task = fake.assistant(
      String(request.body!.messageID),
      '',
      'ses_fixture',
      'tool-calls',
      false,
    )
    task.parts = [
      {
        id: newNativeId('prt'),
        sessionID: 'ses_fixture',
        messageID: task.info.id,
        type: 'tool',
        callID: 'spawn-call',
        tool: 'task',
        state: {
          status: 'completed',
          input: {},
          output: 'started',
          metadata: {
            sessionId: childId,
            parentSessionId: 'ses_fixture',
            background: true,
          },
        },
      },
    ]
    fake.put(task)
    await fake.wait(() =>
      fake.events.find((event) => event.type === 'child_started'),
    )
    fake.assistant(String(request.body!.messageID), 'root done')
    fake.idle()
    expect((await receipt.completion).status).toBe('completed')
    expect(fake.events.some((event) => event.type === 'child_finished')).toBe(
      false,
    )
    const later = await handle.prompt('later')
    await fake.started(later.turnId)
    fake.assistant(childUser, 'late child', childId)
    fake.idle(childId)
    const finished = await fake.wait(() =>
      fake.events.find((event) => event.type === 'child_finished'),
    )
    expect(finished).toMatchObject({
      runId: receipt.runId,
      turnId: receipt.turnId,
      providerRunId: childId,
    })
    expect(
      fake.events.find(
        (event) => event.type === 'text_delta' && event.text === 'late child',
      ),
    ).toMatchObject({
      runId: receipt.runId,
      turnId: receipt.turnId,
      childId: expect.any(String),
    })
    expect(
      fake.events.find((event) => event.type === 'child_started'),
    ).not.toHaveProperty('providerChildId')
  })

  it('rejects child reuse despite old final history and fresh idle', async () => {
    const fake = await peer()
    fake.sessions.set('ses_reused', {
      id: 'ses_reused',
      parentID: 'ses_fixture',
      directory: fake.cwd,
    })
    const oldUser = newNativeId('msg')
    fake.user(oldUser, 'ses_reused', false)
    fake.assistant(oldUser, 'old final', 'ses_reused', 'stop', false)
    const handle = await fake.spawn()
    const receipt = await handle.prompt('reuse')
    const request = await fake.admitted()
    await fake.started(receipt.turnId)
    const task = fake.assistant(
      String(request.body!.messageID),
      '',
      'ses_fixture',
      'tool-calls',
      false,
    )
    task.parts = [
      {
        id: newNativeId('prt'),
        sessionID: 'ses_fixture',
        messageID: task.info.id,
        type: 'tool',
        callID: 'reuse-call',
        tool: 'task',
        state: {
          status: 'completed',
          input: { task_id: 'ses_reused' },
          output: 'old final',
          metadata: { sessionId: 'ses_reused', parentSessionId: 'ses_fixture' },
        },
      },
    ]
    fake.put(task)
    fake.idle('ses_reused')
    fake.idle()
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      code: 'OPENCODE_OWNERSHIP_GAP',
    })
    expect(
      fake.events.some(
        (event) =>
          event.type === 'child_finished' &&
          event.outcome.status === 'completed',
      ),
    ).toBe(false)
    expect(
      fake.events.some(
        (event) => event.type === 'text_delta' && event.text === 'old final',
      ),
    ).toBe(false)
  })

  it.each(['command', 'prompt'])(
    'expires %s submission without native admission or automatic replay',
    async (mode) => {
      const fake = await peer()
      const handle = await fake.spawn({
        limits: { commandMs: 50, activityMs: 50, recoveryMs: 60 },
      })
      fake.state.hook = (request, response) => {
        if (
          request.method !== 'POST' ||
          !request.path.endsWith(
            mode === 'command' ? '/command' : '/prompt_async',
          )
        )
          return false
        if (mode === 'prompt') response.writeHead(204).end()
        return true
      }
      const receipt = await handle.prompt(
        mode === 'command' ? '/known' : 'quiet acceptance',
      )
      const queued = handle.queue('queued')
      expect(await receipt.completion).toMatchObject({
        status: 'failed',
        code: 'OPENCODE_DELIVERY_UNKNOWN',
      })
      expect((await queued.completion).status).toBe('failed')
      expect(
        fake.records.filter(
          (record) =>
            record.method === 'POST' && record.path.includes('/ses_fixture/'),
        ),
      ).toHaveLength(1)
    },
  )

  it('retires attached local state after a stalled scoped abort without writing to other sessions', async () => {
    const fake = await peer()
    const handle = await fake.spawn({ limits: { abortMs: 40 } })
    const receipt = await handle.prompt('abort')
    await fake.started(receipt.turnId)
    fake.status.ses_unrelated = { type: 'busy' }
    fake.state.hook = (request) => request.path.endsWith('/abort')
    await handle.cancel()
    expect((await receipt.completion).status).toBe('failed')
    const aborts = fake.records.filter((record) =>
      record.path.endsWith('/abort'),
    )
    expect(aborts.map((record) => record.path)).toEqual([
      '/session/ses_fixture/abort',
    ])
    expect(fake.status.ses_unrelated).toEqual({ type: 'busy' })
    expect((await fetch(fake.origin + '/global/health')).status).toBe(200)
  })

  it.each(['mime', 'id', 'size', 'oversize', 'utf8', 'missing'])(
    'rejects %s attachment resolver violations before POST',
    async (mode) => {
      const fake = await peer()
      const handle = await fake.spawn({
        defaults: { model: 'fake/model/a' },
        limits: { attachmentBytes: 10 },
        resolveAttachment: async () => {
          if (mode === 'missing')
            throw new Error('Attachment is not authorized')
          return {
            attachmentId: mode === 'id' ? 'different' : 'file',
            mime: mode === 'mime' ? 'image/png' : 'text/plain',
            filename: 'file.txt',
            sizeBytes: mode === 'size' ? 5 : mode === 'oversize' ? 11 : 1,
            bytes:
              mode === 'oversize'
                ? new Uint8Array(11)
                : mode === 'utf8'
                  ? new Uint8Array([0xff])
                  : Buffer.from('x'),
          }
        },
      })
      const receipt = await handle.prompt([
        { type: 'attachment', attachmentId: 'file', mime: 'text/plain' },
      ])
      expect((await receipt.completion).status).toBe('failed')
      expect(
        fake.records.some((record) => record.path.endsWith('/prompt_async')),
      ).toBe(false)
    },
  )

  it('rejects receipt and queue capacity before allocating visible acceptance', async () => {
    const fake = await peer()
    const handle = await fake.spawn({
      limits: { receiptCount: 2, queueCount: 1, inputBytes: 128 },
    })
    expect(() => handle.prompt('ž'.repeat(100))).toThrow()
    expect(fake.events).toHaveLength(0)
    const receipt = await handle.prompt('first', undefined, {
      runId: 'one',
      turnId: 'one',
    })
    await fake.started(receipt.turnId)
    handle.queue('next', undefined, { runId: 'two', turnId: 'two' })
    const accepted = fake.events.filter(
      (event) => event.type === 'prompt_accepted',
    ).length
    expect(() => handle.queue('overflow')).toThrow()
    expect(
      fake.events.filter((event) => event.type === 'prompt_accepted'),
    ).toHaveLength(accepted)
    expect(() =>
      handle.queue('duplicate', undefined, { runId: 'one', turnId: 'one' }),
    ).toThrow()
  })

  it('follows opaque native pagination and ignores a hostile Link origin', async () => {
    const fake = await peer()
    const handle = await fake.spawn()
    const receipt = await handle.prompt('pages')
    const request = await fake.admitted()
    await fake.started(receipt.turnId)
    const userId = String(request.body!.messageID)
    for (let index = 0; index < 101; index++)
      fake.assistant(
        userId,
        `text-${index}`,
        'ses_fixture',
        index === 100 ? 'stop' : 'tool-calls',
        false,
      )
    const rows = fake.histories.get('ses_fixture')!
    // HTTP header values are ASCII. The cursor remains opaque after query encoding.
    fake.state.hook = (request, response) => {
      if (request.url.searchParams.has('before'))
        expect(request.url.searchParams.get('before')).toBe(
          'opaque /+ %C5%BE cursor',
        )
      if (!request.path.endsWith('/message')) return false
      expect(request.url.searchParams.get('limit')).toBe('100')
      const before = request.url.searchParams.get('before')
      response
        .writeHead(200, {
          'content-type': 'application/json',
          ...(before
            ? {}
            : {
                'x-next-cursor': 'opaque /+ %C5%BE cursor',
                link: '<https://hostile.invalid/stolen>; rel="next"',
              }),
        })
        .end(JSON.stringify(before ? rows.slice(0, 3) : rows.slice(-100)))
      return true
    }
    fake.idle()
    expect((await receipt.completion).status).toBe('completed')
    expect(
      fake.records.some(
        (record) =>
          record.url.searchParams.get('before') === 'opaque /+ %C5%BE cursor',
      ),
    ).toBe(true)
  })

  it('reports partial baseline history with the original opaque cursor', async () => {
    const fake = await peer()
    fake.state.hook = (request, response) => {
      if (!request.path.endsWith('/message')) return false
      response
        .writeHead(200, {
          'content-type': 'application/json',
          'x-next-cursor': 'opaque-baseline',
        })
        .end(
          JSON.stringify([
            {
              info: {
                id: 'msg_old',
                sessionID: 'ses_fixture',
                role: 'user',
                time: { created: 1 },
              },
              parts: [],
            },
          ]),
        )
      return true
    }
    const handle = await fake.spawn({ limits: { historyPages: 1 } })
    expect(handle.discovery.history).toEqual({
      availability: 'partial',
      nextCursor: 'opaque-baseline',
    })
    expect(fake.events).toHaveLength(0)
  })

  it('retires on deleted emitted content and preserves prior successful turns', async () => {
    const fake = await peer()
    const handle = await fake.spawn()
    const first = await handle.prompt('first')
    const initial = await fake.admitted()
    await fake.started(first.turnId)
    const row = fake.assistant(String(initial.body!.messageID))
    fake.idle()
    expect((await first.completion).status).toBe('completed')
    const second = await handle.prompt('second')
    await fake.started(second.turnId)
    row.parts = []
    fake.put(row, false)
    fake.send('message.part.removed', {
      sessionID: 'ses_fixture',
      messageID: row.info.id,
      partID: 'prt_removed',
    })
    fake.idle()
    expect(await second.completion).toMatchObject({
      status: 'failed',
      code: 'OPENCODE_HISTORY_GAP',
    })
    expect(
      fake.events.filter(
        (event) =>
          event.type === 'turn_completed' && event.turnId === first.turnId,
      ),
    ).toMatchObject([{ outcome: { status: 'completed' } }])
    expect(
      fake.events.some(
        (event) => event.type === 'run_failed' && event.runId === first.runId,
      ),
    ).toBe(false)
  })

  it('restores two unknown reasoning parts without appending held deltas to snapshots', async () => {
    const fake = await peer()
    const handle = await fake.spawn()
    const receipt = await handle.prompt('reasoning')
    const request = await fake.admitted()
    await fake.started(receipt.turnId)
    for (const text of ['first thought', 'second thought']) {
      const row = fake.assistant(
        String(request.body!.messageID),
        text,
        'ses_fixture',
        undefined,
        false,
      )
      row.parts[0]!.type = 'reasoning'
      fake.put(row, false)
      fake.send('message.part.delta', {
        sessionID: 'ses_fixture',
        messageID: row.info.id,
        partID: row.parts[0]!.id,
        field: 'text',
        delta: text,
      })
    }
    fake.idle()
    await fake.wait(
      () =>
        fake.events.filter((event) => event.type === 'thought_delta').length ===
        2,
    )
    expect(
      fake.events
        .filter((event) => event.type === 'thought_delta')
        .map((event) => event.text),
    ).toEqual(['first thought', 'second thought'])
  })

  it('redacts known native retry credentials without settling the turn', async () => {
    const fake = await peer()
    const handle = await fake.spawn()
    const receipt = await handle.prompt('retry')
    await fake.started(receipt.turnId)
    fake.send('session.status', {
      sessionID: 'ses_fixture',
      status: {
        type: 'retry',
        attempt: 1,
        message: 'failed fixture-secret',
        next: 1,
      },
    })
    const event = await fake.wait(() =>
      fake.events.find(
        (event) =>
          event.type === 'diagnostic' && event.code === 'OPENCODE_RETRY',
      ),
    )
    expect(event).toMatchObject({
      message: 'failed [REDACTED]',
      retryable: true,
    })
    expect(fake.events.some((event) => event.type === 'turn_completed')).toBe(
      false,
    )
  })
})
