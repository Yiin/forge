import { describe, expect, it } from 'vitest'
import type { QuestionAnswer } from '@forge/protocol/harness'
import { peer, turn, turnFrame, notify, eventually } from './test-helpers.js'
import { mapMcpForm, validatePermissionSubset } from './requests.js'
import { JsonlTransport } from '../jsonl.js'
import { vi } from 'vitest'

const request = (
  id: string | number,
  method: string,
  params: Record<string, unknown> = {},
) => ({
  id,
  method,
  params: {
    threadId: 'root',
    turnId: 't1',
    itemId: 'shared-tool',
    startedAtMs: 123,
    ...params,
  },
})
async function active() {
  const p = await peer([{ method: 'turn/start', result: { turn: turn() } }])
  const h = await p.start()
  const receipt = await h.prompt('input')
  return { p, h, receipt }
}
const grants = {
  network: { enabled: true },
  fileSystem: {
    entries: [
      {
        path: { type: 'path' as const, path: '/fixture/allowed' },
        access: 'write' as const,
      },
      {
        path: { type: 'glob_pattern' as const, pattern: '**/secret' },
        access: 'deny' as const,
      },
      {
        path: { type: 'special' as const, value: { kind: 'tmpdir' as const } },
        access: 'deny' as const,
      },
    ],
    globScanMaxDepth: 2,
    read: ['/fixture/read'],
    write: ['/fixture/write'],
  },
}

describe('Codex native callbacks', () => {
  it.each([7, '7'])(
    'C1: buffered resolution dismisses native ID %s before owner discovery and permits later reuse',
    async (id) => {
      const frame = request(id, 'item/tool/requestUserInput', {
        questions: [
          {
            id: 'q',
            header: 'Choose',
            question: 'Pick',
            options: [{ label: 'One', description: 'Choice' }],
          },
        ],
      })
      const p = await peer([
        {
          method: 'turn/start',
          before: [
            turnFrame('started'),
            frame,
            notify('serverRequest/resolved', {
              threadId: 'root',
              requestId: id,
            }),
          ],
          result: { turn: turn() },
        },
      ])
      const h = await p.start()
      await h.prompt('input')
      expect(
        p.events.filter((event) => event.type === 'question_requested'),
      ).toEqual([])
      expect((await p.trace()).filter((entry) => entry.id === id)).toEqual([])
      await p.send([frame])
      await eventually(() =>
        p.events.some((event) => event.type === 'question_requested'),
      )
      const question = p.events.find(
        (event) => event.type === 'question_requested',
      )!.request
      await h.replyQuestion!(question.requestId, {
        q: {
          type: 'selected',
          optionIds: [question.questions[0]!.options[0]!.id],
        },
      })
      await eventually(async () =>
        (await p.trace()).some((entry) => entry.id === id),
      )
      expect((await p.trace()).filter((entry) => entry.id === id)).toEqual([
        { id, result: { answers: { q: { answers: ['One'] } } } },
      ])
      expect(
        p.events.filter((event) => event.type === 'question_requested'),
      ).toHaveLength(1)
      expect(
        p.events.filter((event) => event.type === 'request_cancelled'),
      ).toEqual([])
    },
  )

  it('C1: buffered resolution matches the native thread and ID type', async () => {
    const p = await peer([
      {
        method: 'turn/start',
        before: [
          turnFrame('started'),
          request(9, 'item/commandExecution/requestApproval'),
          request('9', 'item/commandExecution/requestApproval'),
          notify('serverRequest/resolved', {
            threadId: 'other',
            requestId: '9',
          }),
          notify('serverRequest/resolved', { threadId: 'root', requestId: 9 }),
        ],
        result: { turn: turn() },
      },
    ])
    const h = await p.start()
    await h.prompt('input')
    const permissions = p.events.filter(
      (event) => event.type === 'permission_requested',
    )
    expect(permissions).toHaveLength(1)
    await h.replyPermission!({
      type: 'denied',
      requestId: permissions[0]!.request.requestId,
    })
    await eventually(async () =>
      (await p.trace()).some((entry) => entry.id === '9'),
    )
    expect(
      (await p.trace()).filter((entry) => entry.id === 9 || entry.id === '9'),
    ).toEqual([{ id: '9', result: { decision: 'decline' } }])
  })

  it.each(['startup', 'idle', 'active'])(
    '84: a turnless form during %s declines without question ownership',
    async (phase) => {
      const extra =
        phase === 'active'
          ? [{ method: 'turn/start', result: { turn: turn() } }]
          : []
      const p = await peer(extra)
      const frame = request('turnless', 'mcpServer/elicitation/request', {
        turnId: null,
        mode: 'form',
        serverName: 'fixture',
        message: 'Fixture',
        requestedSchema: { type: 'object', properties: {} },
      })
      if (phase === 'startup') {
        p.startup[0]!.before = [frame]
        await p.save([...p.startup, ...extra])
      }
      const h = await p.start()
      if (phase === 'active') await h.prompt('input')
      if (phase !== 'startup') await p.send([frame])
      await eventually(async () =>
        (await p.trace()).some((frame) => frame.id === 'turnless'),
      )
      expect(
        (await p.trace()).find((frame) => frame.id === 'turnless'),
      ).toMatchObject({ result: { action: 'decline', content: null } })
      expect(
        p.events.some((event) => event.type === 'question_requested'),
      ).toBe(false)
    },
  )
  it('31: 300 native resolutions release capacity without reusing public request IDs', async () => {
    const { p, h } = await active()
    let first: string | undefined
    for (let batch = 0; batch < 6; batch++) {
      await p.send(
        Array.from({ length: 50 }, (_, index) =>
          request(index, 'item/commandExecution/requestApproval'),
        ),
      )
      await eventually(
        () =>
          p.events.filter((event) => event.type === 'permission_requested')
            .length ===
          (batch + 1) * 50,
      )
      first ??= p.events.find((event) => event.type === 'permission_requested')!
        .request.requestId
      await p.send(
        Array.from({ length: 50 }, (_, index) =>
          notify('serverRequest/resolved', {
            threadId: 'root',
            requestId: index,
          }),
        ),
      )
      await eventually(
        () =>
          p.events.filter((event) => event.type === 'request_cancelled')
            .length ===
          (batch + 1) * 50,
      )
    }
    expect(
      new Set(
        p.events
          .filter((event) => event.type === 'permission_requested')
          .map((event) => event.request.requestId),
      ).size,
    ).toBe(300)
    await expect(
      h.replyPermission!({ type: 'denied', requestId: first! }),
    ).rejects.toThrow('STALE')
    expect(
      (await p.trace()).filter((frame) => Object.hasOwn(frame, 'result')),
    ).toEqual([])
  })

  it('32, 100: native resolution aborts a queued reply while a real child pipe is blocked', async () => {
    const p = await peer([
      { method: 'turn/start', result: { turn: turn() } },
      { method: 'turn/steer', result: { turnId: 't1' } },
    ])
    const h = await p.start()
    await h.prompt('input')
    const frame = request('reused', 'item/commandExecution/requestApproval')
    await p.send([frame])
    await eventually(() =>
      p.events.some((event) => event.type === 'permission_requested'),
    )
    const first = p.events.find(
      (event) => event.type === 'permission_requested',
    )!.request.requestId
    await p.input(true)
    await eventually(async () =>
      (await p.trace()).some((frame) => frame.event === 'pauseInput'),
    )
    let wireState: (() => JsonlTransport['state']) | undefined
    const send = JsonlTransport.prototype.sendWithSubmission
    const spy = vi
      .spyOn(JsonlTransport.prototype, 'sendWithSubmission')
      .mockImplementation(function (this: JsonlTransport, ...args) {
        wireState = () => this.state
        return send.apply(this, args)
      })
    try {
      const steer = h.steer!('x'.repeat(2 * 1024 * 1024))
      await eventually(() => wireState?.().queuedFrames === 1)
      const reply = Promise.resolve(
        h.replyPermission!({ type: 'denied', requestId: first }),
      ).then(
        () => 'sent',
        () => 'cancelled',
      )
      await eventually(() => wireState?.().queuedFrames === 2)
      await p.send([
        notify('serverRequest/resolved', {
          threadId: 'root',
          requestId: 'reused',
        }),
      ])
      expect(await reply).toBe('cancelled')
      await p.input(false)
      await steer
      expect((await p.trace()).some((frame) => frame.id === 'reused')).toBe(
        false,
      )
      await p.send([frame])
      await eventually(
        () =>
          p.events.filter((event) => event.type === 'permission_requested')
            .length === 2,
      )
      await expect(
        h.replyPermission!({ type: 'denied', requestId: first }),
      ).rejects.toThrow('STALE')
      const second = p.events.filter(
        (event) => event.type === 'permission_requested',
      )[1]!.request.requestId
      await h.replyPermission!({ type: 'denied', requestId: second })
      await eventually(async () =>
        (await p.trace()).some((frame) => frame.id === 'reused'),
      )
      expect(
        (await p.trace()).filter((frame) => frame.id === 'reused'),
      ).toEqual([{ id: 'reused', result: { decision: 'decline' } }])
    } finally {
      spy.mockRestore()
    }
  })
  it('25, 26, 27: interleaved approvals keep exact RPC IDs and distinct decision scopes', async () => {
    const { p, h } = await active()
    await p.send([
      request(7, 'item/commandExecution/requestApproval', {
        command: 'fixture',
        approvalId: 'first',
        cwd: p.root,
      }),
      request('7', 'item/fileChange/requestApproval', { grantRoot: p.root }),
      ...Array.from({ length: 310 }, (_, index) =>
        notify('item/agentMessage/delta', {
          threadId: 'root',
          turnId: 't1',
          itemId: 'message',
          delta: String(index % 2),
        }),
      ),
    ])
    await eventually(
      () =>
        p.events.filter((event) => event.type === 'permission_requested')
          .length === 2,
    )
    const approvals = p.events.filter(
      (event) => event.type === 'permission_requested',
    )
    expect(approvals[0]!.request.toolCallId).toBe(
      approvals[1]!.request.toolCallId,
    )
    expect(approvals[0]!.request.approvalId).toBe('first')
    await h.replyPermission!({
      type: 'selected',
      requestId: approvals[1]!.request.requestId,
      optionId: approvals[1]!.request.options[1]!.id,
    })
    await h.replyPermission!({
      type: 'denied',
      requestId: approvals[0]!.request.requestId,
    })
    await eventually(
      async () =>
        (await p.trace()).filter((frame) => Object.hasOwn(frame, 'result'))
          .length === 2,
    )
    const replies = (await p.trace()).filter((frame) =>
      Object.hasOwn(frame, 'result'),
    )
    expect(replies).toEqual([
      { id: '7', result: { decision: 'acceptForSession' } },
      { id: 7, result: { decision: 'decline' } },
    ])
    await expect(
      Promise.resolve().then(() =>
        h.replyPermission!({
          type: 'denied',
          requestId: approvals[0]!.request.requestId,
        }),
      ),
    ).rejects.toThrow('STALE')
  })

  it.each(['manual', 'auto', 'yolo'] as const)(
    '27: %s never answers a residual callback automatically',
    async (permissionMode) => {
      const p = await peer([{ method: 'turn/start', result: { turn: turn() } }])
      const h = await p.start()
      await h.prompt('input', { permissionMode })
      await p.send([
        request('permission', 'item/commandExecution/requestApproval'),
      ])
      await eventually(() =>
        p.events.some((event) => event.type === 'permission_requested'),
      )
      expect((await p.trace()).some((frame) => frame.id === 'permission')).toBe(
        false,
      )
    },
  )

  it('27, 93: native amendments and writeStdin keep their exact payloads', async () => {
    const { p, h } = await active()
    await p.send([
      request('amend', 'item/commandExecution/requestApproval', {
        kind: 'writeStdin',
        approvalId: 'callback',
        cwd: p.root,
        environmentId: null,
        reason: 'fixture reason',
        proposedExecpolicyAmendment: ['tool', '--exact'],
        proposedNetworkPolicyAmendments: [
          { action: 'allow', host: 'example.test' },
        ],
      }),
    ])
    await eventually(() =>
      p.events.some((event) => event.type === 'permission_requested'),
    )
    const event = p.events.find(
      (event) => event.type === 'permission_requested',
    )!
    expect(event.request.title).toBe('Approve terminal input')
    expect(event.request.detail).toContain('123')
    await h.replyPermission!({
      type: 'selected',
      requestId: event.request.requestId,
      optionId: event.request.options[4]!.id,
    })
    await eventually(async () =>
      (await p.trace()).some((frame) => frame.id === 'amend'),
    )
    expect(
      (await p.trace()).find((frame) => frame.id === 'amend')!.result,
    ).toEqual({
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ['tool', '--exact'],
        },
      },
    })
  })

  it('28, 29, 94: invalid broader grants remain answerable; valid grants preserve denies and depth', async () => {
    const { p, h } = await active()
    await p.send([
      request('grant', 'item/permissions/requestApproval', {
        cwd: p.root,
        permissions: grants,
      }),
    ])
    await eventually(() =>
      p.events.some((event) => event.type === 'permission_requested'),
    )
    const event = p.events.find(
      (event) => event.type === 'permission_requested',
    )!
    const reply = {
      type: 'granted' as const,
      requestId: event.request.requestId,
      scope: 'session' as const,
      strictAutoReview: false,
    }
    await expect(
      Promise.resolve().then(() =>
        h.replyPermission!({
          ...reply,
          permissions: {
            fileSystem: { entries: [grants.fileSystem.entries[0]!] },
          },
        }),
      ),
    ).rejects.toThrow('INVALID')
    expect((await p.trace()).some((frame) => frame.id === 'grant')).toBe(false)
    await h.replyPermission!({ ...reply, permissions: grants })
    await eventually(async () =>
      (await p.trace()).some((frame) => frame.id === 'grant'),
    )
    expect(
      (await p.trace()).find((frame) => frame.id === 'grant')!.result,
    ).toEqual({
      permissions: grants,
      scope: 'session',
      strictAutoReview: false,
    })
  })

  it('30: Unicode labels, free text, secret questions, skip, and selected-with-text reach native IDs', async () => {
    const { p, h } = await active()
    await p.send([
      request('questions', 'item/tool/requestUserInput', {
        isBlocking: false,
        questions: [
          {
            id: 'native/α',
            header: 'Choose',
            question: 'Pick',
            options: [{ label: 'Žalias, taip!', description: 'Choice' }],
            isOther: true,
          },
          {
            id: 'secret',
            header: 'Secret',
            question: 'Value',
            options: null,
            isSecret: true,
          },
          { id: 'skip', header: 'Skip', question: 'Optional', options: null },
        ],
      }),
    ])
    await eventually(() =>
      p.events.some((event) => event.type === 'question_requested'),
    )
    const event = p.events.find((event) => event.type === 'question_requested')!
    expect(event.request.isBlocking).toBe(false)
    expect(event.request.questions[1]).toMatchObject({
      isSecret: true,
      allowFreeInput: true,
      multiSelect: false,
    })
    const chosen = event.request.questions[0]!.options[0]!.id
    await expect(
      Promise.resolve().then(() =>
        h.replyQuestion!(event.request.requestId, {
          'native/α': { type: 'selected', optionIds: [chosen, chosen] },
          secret: { type: 'skipped' },
          skip: { type: 'skipped' },
        }),
      ),
    ).rejects.toThrow('INVALID')
    await h.replyQuestion!(event.request.requestId, {
      'native/α': {
        type: 'selected_with_text',
        optionIds: [chosen],
        text: 'detail',
      },
      secret: { type: 'free_text', text: 'fixture secret' },
      skip: { type: 'skipped' },
    })
    await eventually(async () =>
      (await p.trace()).some((frame) => frame.id === 'questions'),
    )
    expect(
      (await p.trace()).find((frame) => frame.id === 'questions')!.result,
    ).toEqual({
      answers: {
        'native/α': { answers: ['Žalias, taip!', 'detail'] },
        secret: { answers: ['fixture secret'] },
        skip: { answers: [] },
      },
    })
    expect(JSON.stringify(p.events)).not.toContain('fixture secret')
  })

  it('31, 32: native resolution preserves the owner and rejects stale answers after ID reuse', async () => {
    const { p, h } = await active()
    const frame = request('reused', 'item/commandExecution/requestApproval')
    await p.send([frame])
    await eventually(() =>
      p.events.some((event) => event.type === 'permission_requested'),
    )
    const first = p.events.find(
      (event) => event.type === 'permission_requested',
    )!
    await p.send([
      notify('serverRequest/resolved', {
        threadId: 'root',
        requestId: 'reused',
      }),
    ])
    await eventually(() =>
      p.events.some((event) => event.type === 'request_cancelled'),
    )
    await p.send([frame])
    await eventually(
      () =>
        p.events.filter((event) => event.type === 'permission_requested')
          .length === 2,
    )
    await expect(
      Promise.resolve().then(() =>
        h.replyPermission!({
          type: 'denied',
          requestId: first.request.requestId,
        }),
      ),
    ).rejects.toThrow('STALE')
    const second = p.events.filter(
      (event) => event.type === 'permission_requested',
    )[1]!
    await h.replyPermission!({
      type: 'denied',
      requestId: second.request.requestId,
    })
    expect(
      p.events.find((event) => event.type === 'request_cancelled'),
    ).toMatchObject({
      requestId: first.request.requestId,
      runId: first.runId,
      turnId: first.turnId,
    })
  })

  it.each([
    'account/chatgptAuthTokens/refresh',
    'attestation/generate',
    'item/tool/call',
    'applyPatchApproval',
    'execCommandApproval',
    'unknown/call',
  ])('33: unsupported %s receives an explicit error', async (method) => {
    const { p } = await active()
    await p.send([request('unsupported', method)])
    await eventually(async () =>
      (await p.trace()).some((frame) => frame.id === 'unsupported'),
    )
    expect(
      (await p.trace()).find((frame) => frame.id === 'unsupported'),
    ).toMatchObject({ error: { code: -32601 } })
  })

  it.each(['url', 'openai/form', 'openaiForm'])(
    '84, 85: declines %s without inventing question ownership',
    async (mode) => {
      const { p } = await active()
      await p.send([
        request('form', 'mcpServer/elicitation/request', {
          mode,
          turnId: null,
          serverName: 'fixture',
        }),
      ])
      await eventually(async () =>
        (await p.trace()).some((frame) => frame.id === 'form'),
      )
      expect(
        (await p.trace()).find((frame) => frame.id === 'form')!.result,
      ).toEqual({ action: 'decline', content: null })
      expect(
        p.events.some((event) => event.type === 'question_requested'),
      ).toBe(false)
    },
  )

  it.each([
    'item/commandExecution/requestApproval',
    'item/permissions/requestApproval',
  ])(
    '93: rejects nonlocal %s before presenting local approval',
    async (method) => {
      const { p } = await active()
      await p.send([
        request('remote', method, {
          environmentId: 'remote',
          cwd: '/foreign/path',
          ...(method.includes('permissions') ? { permissions: grants } : {}),
        }),
      ])
      await eventually(async () =>
        (await p.trace()).some((frame) => frame.id === 'remote'),
      )
      expect(
        (await p.trace()).find((frame) => frame.id === 'remote'),
      ).toMatchObject({ error: { code: -32601 } })
      expect(
        p.events.some((event) => event.type === 'permission_requested'),
      ).toBe(false)
    },
  )
})

describe('Codex typed MCP form validation', () => {
  const form = (properties: Record<string, unknown>, required: string[] = []) =>
    mapMcpForm(
      {
        mode: 'form',
        message: 'Fixture form',
        requestedSchema: { type: 'object', properties, required },
      },
      'request',
    )
  const answer = (
    presentation: ReturnType<typeof form>,
    answers: Record<string, QuestionAnswer>,
  ) => {
    if (presentation.type !== 'question') throw new Error('Expected question')
    return presentation.answer(answers)
  }
  it('85, 86: returns booleans, numbers, Unicode strings, enum values, and omitted optional skips', () => {
    const p = form(
      {
        bool: { type: 'boolean', default: true },
        int: { type: 'integer', minimum: 1, maximum: 9 },
        str: { type: 'string', minLength: 1, maxLength: 1 },
        enum: {
          type: 'string',
          oneOf: [
            { const: 'first', title: 'Same' },
            { const: 'second', title: 'Same' },
          ],
        },
        array: {
          type: 'array',
          items: {
            anyOf: [
              { const: 'α', title: 'Alpha' },
              { const: 'β', title: 'Beta' },
            ],
          },
          minItems: 1,
          maxItems: 2,
        },
        optional: { type: 'string' },
      },
      ['bool', 'int', 'str', 'enum', 'array'],
    )
    if (p.type !== 'question') throw new Error('Expected form')
    const q = Object.fromEntries(
      p.request.questions.map((question) => [question.id, question]),
    )
    expect(
      answer(p, {
        bool: { type: 'selected', optionIds: [q.bool!.options[1]!.id] },
        int: { type: 'free_text', text: '9' },
        str: { type: 'free_text', text: '😀' },
        enum: { type: 'selected', optionIds: [q.enum!.options[1]!.id] },
        array: {
          type: 'selected',
          optionIds: q.array!.options.map((choice) => choice.id),
        },
        optional: { type: 'skipped' },
      }),
    ).toEqual({
      action: 'accept',
      content: {
        bool: false,
        int: 9,
        str: '😀',
        enum: 'second',
        array: ['α', 'β'],
      },
    })
    expect(() => answer(p, {})).toThrow()
  })
  it.each([
    'NaN',
    'Infinity',
    '1x',
    '01',
    '+1',
    ' 1',
    '1.1',
    '9007199254740993',
  ])('87: rejects invalid integer text %s', (value) => {
    expect(() =>
      answer(form({ value: { type: 'integer' } }), {
        value: { type: 'free_text', text: value },
      }),
    ).toThrow()
  })
  it.each([
    { type: 'object' },
    { type: 'array', items: { type: 'number' } },
    { type: 'string', enum: ['same', 'same'] },
    { type: 'string', enum: ['one'], enumNames: [] },
    { type: 'string', minLength: 3, maxLength: 1 },
    { type: 'string', format: 'unknown' },
  ])(
    '87: unsupported or contradictory form %j never becomes a question',
    (schema) => {
      expect(() => form({ value: schema })).toThrow()
    },
  )
  it.each([
    ['email', 'person@example.test', 'bad'],
    ['uri', 'https://example.test/path', 'bad'],
    ['date', '2024-02-29', '2023-02-29'],
    ['date-time', '2024-02-29T10:00:00Z', '2024-02-29'],
  ])('86: enforces the %s format', (format, valid, invalid) => {
    const p = form({ value: { type: 'string', format } })
    expect(answer(p, { value: { type: 'free_text', text: valid! } })).toEqual({
      action: 'accept',
      content: { value: valid },
    })
    expect(() =>
      answer(p, { value: { type: 'free_text', text: invalid! } }),
    ).toThrow()
  })
  it('85, 87: required skip fails and defaults do not synthesize answers', () => {
    const p = form({ value: { type: 'boolean', default: true } }, ['value'])
    expect(() => answer(p, { value: { type: 'skipped' } })).toThrow('REQUIRED')
    expect(() => answer(p, {})).toThrow()
  })
  it('28, 94: conservative grant validation retains unrelated deny entries and exact depth', () => {
    expect(validatePermissionSubset(grants, grants)).toEqual(grants)
    for (const permissions of [
      { network: { enabled: true } },
      { fileSystem: { read: ['/unknown'] } },
      { fileSystem: { ...grants.fileSystem, globScanMaxDepth: 3 } },
    ]) {
      const source = 'network' in permissions ? {} : grants
      expect(() => validatePermissionSubset(source, permissions)).toThrow()
    }
  })
})
