import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendFile,
  open,
  realpath,
  stat,
  readFile,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import {
  createPiAdapter,
  type ConfirmedPiBinding,
  type PiAdapterOptions,
  type PiHandle,
} from './index.js'
import { fileLines, nativeArguments, validateResume } from './session.js'
import { physicalState, limits, MiB, reservePhysical, check } from './wire.js'
import { imageHash } from './input.js'
import {
  fixture,
  png,
  latch,
  waitPhysicalIdle,
  assistant,
  imageLoader,
  type PeerConfig,
} from './fixtures/test-support.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: vi.fn(actual.open),
    realpath: vi.fn(actual.realpath),
    stat: vi.fn(actual.stat),
  }
})

const owned: Array<Awaited<ReturnType<typeof fixture>>> = []
async function peer(config?: PeerConfig) {
  const f = await fixture(config)
  owned.push(f)
  return f
}
afterEach(async () => {
  for (const f of owned.splice(0)) await f.close()
  await waitPhysicalIdle()
})
async function history(
  f: Awaited<ReturnType<typeof fixture>>,
  bodies: object[] = [
    {
      type: 'message',
      message: { role: 'user', content: 'saved', timestamp: 0 },
    },
  ],
) {
  const sessionFile = join(f.home, 'sessions', 'saved.jsonl')
  const binding: ConfirmedPiBinding = {
    provider: 'pi',
    accountId: 'pi-account',
    cwd: f.cwd,
    providerSessionId: 'saved-id',
    sessionFile,
  }
  const rows = [
    {
      type: 'session',
      version: 3,
      id: 'saved-id',
      timestamp: new Date(0).toISOString(),
      cwd: f.cwd,
    },
    ...bodies.map((body, index) => ({
      ...body,
      id: `entry-${index}`,
      parentId: index ? `entry-${index - 1}` : null,
      timestamp: new Date(index + 1).toISOString(),
    })),
  ]
  await writeFile(
    sessionFile,
    rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
  )
  return { binding, rows }
}
describe('Pi session scope and immutable history', () => {
  it('E2, E7, 48: a changed line rejects before parsing beyond its scanned allocation', async () => {
    const f = await peer()
    const path = join(f.directory, 'changed-line.jsonl')
    const original = JSON.stringify({ value: 'x'.repeat(200_000) }) + '\n'
    const replacement =
      JSON.stringify({
        value: Array.from({ length: 30_000 }, () => ({})),
      }).padEnd(original.length - 1, ' ') + '\n'
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original))
    await writeFile(path, original)
    const file = await open(path, 'r+')
    let changed = false,
      parsed = 0
    const descriptor = {
      async read(
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) {
        if (!changed && buffer.length === Buffer.byteLength(original)) {
          changed = true
          await file.write(
            Buffer.from(replacement),
            0,
            Buffer.byteLength(replacement),
            0,
          )
        }
        return file.read(buffer, offset, length, position)
      },
    }
    try {
      await expect(async () => {
        for await (const _line of fileLines(
          descriptor as never,
          Buffer.byteLength(original),
          new AbortController().signal,
        ))
          parsed++
      }).rejects.toThrow('PI_SESSION_FILE_CHANGED')
      expect(changed).toBe(true)
      expect(parsed).toBe(0)
    } finally {
      await file.close()
    }
    expect(physicalState().count).toBe(0)
  })
  it('R1, 49: actual history imports redact overlapping assistant diagnostics', async () => {
    const f = await peer()
    const shorter = 'fixture-diagnostic',
      longer = shorter + '-private'
    const env = { FORGE_PI_SHORT: shorter, FORGE_PI_LONG: longer }
    const message = {
      ...assistant(),
      errorMessage: longer,
      rawStopReason: longer,
      diagnostics: [
        {
          type: 'fixture',
          timestamp: 1,
          error: { message: longer, stack: longer },
          details: { nested: [longer] },
        },
      ],
    }
    const target = await history(f, [{ type: 'message', message }])
    const reader = createPiAdapter({
      ...f.options,
      env,
      launch: { ...f.options.launch, selectedEnvOverrides: env },
    }).createHistoryReader(
      f.session,
      { binding: target.binding },
      { signal: new AbortController().signal },
    )
    try {
      const page = await reader.read(null)
      expect(page.records).toHaveLength(1)
      expect(JSON.stringify(page).includes(shorter)).toBe(false)
      expect(JSON.stringify(page).includes('-private')).toBe(false)
      expect(JSON.stringify(page).includes('[REDACTED]')).toBe(true)
      expect(f.pages).toHaveLength(1)
    } finally {
      reader.close()
    }
  })
  it.each(['load', 'history'] as const)(
    'Q5, 07, 48, 52: %s rejects another persisted file with the same native ID',
    async (kind) => {
      const f = await peer()
      const original = await history(f)
      const alternate = {
        binding: {
          ...original.binding,
          sessionFile: join(f.home, 'sessions', 'alternate.jsonl'),
        },
      }
      await writeFile(
        alternate.binding.sessionFile,
        await readFile(original.binding.sessionFile),
      )
      const adapter = createPiAdapter({ ...f.options, resume: alternate })
      const session = { ...f.session, binding: original.binding }
      vi.mocked(open).mockClear()
      vi.mocked(realpath).mockClear()
      vi.mocked(stat).mockClear()
      if (kind === 'load')
        await expect(adapter.load(session, f.emit)).rejects.toThrow(
          'PI_RESUME_SCOPE_MISMATCH',
        )
      else
        expect(() =>
          adapter.createHistoryReader(session, alternate, {
            signal: new AbortController().signal,
          }),
        ).toThrow('PI_RESUME_SCOPE_MISMATCH')
      expect(open).not.toHaveBeenCalled()
      expect(realpath).not.toHaveBeenCalled()
      expect(stat).not.toHaveBeenCalled()
      expect(f.pages).toEqual([])
      expect(f.images).toEqual([])
      expect(f.records).toEqual([])
      expect(await f.wire()).toEqual([])
      expect(session.binding.sessionFile).toBe(original.binding.sessionFile)
    },
  )
  it.each([
    { importPublications: 1, importPublicationBytes: 1 },
    { importPublications: 1 },
  ])(
    'E3, 50: every empty history commit consumes count and envelope bytes: %j',
    async (configured) => {
      const f = await peer()
      const target = await history(f, [])
      const reader = createPiAdapter({
        ...f.options,
        limits: configured,
      }).createHistoryReader(f.session, target, {
        signal: new AbortController().signal,
      })
      try {
        if ('importPublicationBytes' in configured) {
          await expect(reader.read(null)).rejects.toThrow(
            'PI_PUBLICATION_LIMIT',
          )
          expect(f.pages).toHaveLength(0)
        } else {
          const first = await reader.read(null)
          expect(first.records).toHaveLength(0)
          await expect(reader.read(first.end)).rejects.toThrow(
            'PI_PUBLICATION_LIMIT',
          )
          expect(f.pages).toHaveLength(1)
        }
      } finally {
        reader.close()
      }
    },
  )
  it('E6, 48: overflow pages reuse one persisted image and contiguous admitted ordinals', async () => {
    const f = await peer()
    const target = await history(f, [
      { type: 'session_info', name: 'first' },
      {
        type: 'message',
        message: {
          role: 'user',
          timestamp: 0,
          content: [
            {
              type: 'image',
              mimeType: 'image/png',
              data: png.toString('base64'),
            },
          ],
        },
      },
    ])
    const reader = createPiAdapter(f.options).createHistoryReader(
      f.session,
      target,
      { signal: new AbortController().signal },
    )
    try {
      const first = await reader.read(null, { maxBytes: 700 })
      expect(first.records).toHaveLength(1)
      expect(f.images).toHaveLength(1)
      expect(physicalState().classes.sink).toBe(1)
      const second = await reader.read(first.end, { maxBytes: 700 })
      expect(second.records).toHaveLength(1)
      expect(f.images).toHaveLength(1)
      expect([
        first.records[0]!.source.ordinal,
        second.records[0]!.source.ordinal,
      ]).toEqual([1, 2])
      expect(JSON.stringify(second.records)).toContain('image-1')
      expect(physicalState().classes.sink).toBe(0)
    } finally {
      reader.close()
    }
  })
  it('E7, 48: large UTF-8 file lines have linear copy volume and charged allocations', async () => {
    const f = await peer()
    const path = join(f.directory, 'large-lines.jsonl')
    const first = JSON.stringify({ value: 'x'.repeat(4 * MiB) }) + '\r\n'
    const second = JSON.stringify({ value: '界\u2028\u2029' }) + '\n'
    const raw = Buffer.from(first + second)
    await writeFile(path, raw)
    const file = await open(path, 'r')
    let readBytes = 0
    let copiedBytes = 0
    const concat = Buffer.concat
    const copies = vi
      .spyOn(Buffer, 'concat')
      .mockImplementation((chunks, length) => {
        copiedBytes +=
          length ?? chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
        return concat(chunks, length)
      })
    const descriptor = {
      async read(...args: Parameters<typeof file.read>) {
        expect(physicalState().classes.file).toBeGreaterThan(0)
        const result = await file.read(...args)
        readBytes += result.bytesRead
        return result
      },
    }
    try {
      const received: Buffer[] = []
      for await (const line of fileLines(
        descriptor as never,
        raw.length,
        new AbortController().signal,
      )) {
        expect(physicalState().bytes).toBeGreaterThanOrEqual(
          3 * line.raw.length,
        )
        received.push(line.raw)
      }
      expect(concat(received).equals(raw)).toBe(true)
      expect(readBytes).toBe(2 * raw.length)
      expect(readBytes).toBeLessThan(3 * raw.length)
      expect(copiedBytes).toBeLessThan(3 * raw.length)
    } finally {
      copies.mockRestore()
      await file.close()
    }
    expect(physicalState().count).toBe(0)
  })
  it('E2, E7, 08, 33: resume admits the full supported image line before allocating its buffers', async () => {
    const f = await peer()
    const sizes = [9 * MiB, 8 * MiB, 8 * MiB]
    const content = sizes.map((size) => {
      const data = Buffer.alloc(size)
      png.copy(data)
      return {
        type: 'image',
        mimeType: 'image/png',
        data: data.toString('base64'),
      }
    })
    const target = await history(f, [
      { type: 'message', message: { role: 'user', timestamp: 0, content } },
    ])
    const imagePeer = await peer({ behavior: 'manual' }),
      loaderPeer = await peer({ behavior: 'manual' })
    const imageEntered = latch(),
      loaderEntered = latch(),
      imageHeld = latch(),
      loaderHeld = latch()
    let imageCalls = 0,
      loaderCalls = 0
    let imageHandle: PiHandle | undefined, loaderHandle: PiHandle | undefined
    try {
      const imageStart = await imagePeer.start({
        persistImage: async (...args) => {
          imageCalls++
          imageEntered.resolve()
          await imageHeld.promise
          check(args[2])
          return imagePeer.options.persistImage(...args)
        },
      })
      imageHandle = imageStart.handle
      await imageHandle.prompt('Image work').acceptance
      await imagePeer.control({
        events: [
          { type: 'agent_start' },
          {
            type: 'message_end',
            message: {
              role: 'user',
              timestamp: 0,
              content: [
                {
                  type: 'image',
                  mimeType: 'image/png',
                  data: png.toString('base64'),
                },
              ],
            },
          },
        ],
      })
      await imageEntered.promise
      await imageHandle.kill()
      const loaderStart = await loaderPeer.start({
        loadImage: async () => {
          loaderCalls++
          loaderEntered.resolve()
          await loaderHeld.promise
          return imageLoader()()
        },
      })
      loaderHandle = loaderStart.handle
      loaderHandle.prompt([
        { type: 'attachment', attachmentId: 'owned', mime: 'image/png' },
      ])
      await loaderEntered.promise
      await expect(
        validateResume(
          target.binding,
          join(f.home, 'sessions'),
          new AbortController().signal,
          limits(),
        ),
      ).rejects.toThrow('PI_PHYSICAL_WORK_CAPACITY')
      expect(physicalState().classes.resume).toBe(0)
      expect(physicalState().classes.file).toBe(0)
      expect(physicalState().count).toBe(2)
      expect(imageCalls).toBe(1)
      expect(loaderCalls).toBe(1)
    } finally {
      await loaderHandle?.kill()
      await imageHandle?.kill()
      imageHeld.resolve()
      loaderHeld.resolve()
      await waitPhysicalIdle()
    }
    expect(imagePeer.images).toEqual([])
    const held = await validateResume(
      target.binding,
      join(f.home, 'sessions'),
      new AbortController().signal,
      limits(),
    )
    try {
      expect(physicalState().bytes).toBe(33 * MiB)
      await held.verify()
    } finally {
      await held.close()
    }
    const reader = createPiAdapter(f.options).createHistoryReader(
      f.session,
      { binding: target.binding },
      { signal: new AbortController().signal },
    )
    try {
      expect((await reader.read(null)).complete).toBe(true)
      expect(f.images.map((image) => image.size)).toEqual(sizes)
    } finally {
      reader.close()
    }
    expect(physicalState().count).toBe(0)
  })
  it('E2, 33, 48, 55: a blocked history image sink retains its parsed line and shared admission', async () => {
    const f = await peer()
    const content = [9, 8, 8].map((size) => {
      const data = Buffer.alloc(size * MiB)
      png.copy(data)
      return {
        type: 'image',
        mimeType: 'image/png',
        data: data.toString('base64'),
      }
    })
    const target = await history(f, [
      { type: 'message', message: { role: 'user', timestamp: 0, content } },
    ])
    const held = latch(),
      entered = latch()
    const controller = new AbortController()
    const reader = createPiAdapter({
      ...f.options,
      persistImage: async (...args) => {
        entered.resolve()
        await held.promise
        check(args[2])
        return f.options.persistImage(...args)
      },
    }).createHistoryReader(
      f.session,
      { binding: target.binding },
      { signal: controller.signal },
    )
    const reading = reader.read(null)
    const rejected = expect(reading).rejects.toThrow('PI_CANCELLED')
    try {
      await entered.promise
      expect(physicalState().classes.file).toBe(2)
      expect(physicalState().classes.image).toBe(1)
      expect(physicalState().bytes).toBeGreaterThan(200 * MiB)
      expect(() => reservePhysical('attachment')).toThrow(
        'PI_PHYSICAL_WORK_CAPACITY',
      )
      controller.abort()
      await rejected
      expect(physicalState().classes.image).toBe(1)
    } finally {
      held.resolve()
      reader.close()
      await waitPhysicalIdle()
    }
    expect(f.images).toEqual([])
    expect(physicalState().count).toBe(0)
  })
  it('07: resumes only the exact validated file and native session ID', async () => {
    const f = await peer()
    const target = await history(f)
    const { handle } = await f.start({ resume: target }, true)
    expect(handle.binding).toEqual(target.binding)
    expect((await f.started()).args.slice(-2)).toEqual([
      '--session',
      target.binding.sessionFile,
    ])
    expect(
      (await f.wire()).some((command) =>
        ['switch_session', 'new_session', 'prompt'].includes(
          String(command.type),
        ),
      ),
    ).toBe(false)
  })
  it.each([
    'missing',
    'empty',
    'malformed',
    'wrong-id',
    'wrong-cwd',
    'outside-root',
    'version',
    'symlink',
  ])('08: rejects %s resume files before launch', async (kind) => {
    const f = await peer()
    const target = await history(f)
    if (kind === 'missing')
      target.binding = {
        ...target.binding,
        sessionFile: join(f.home, 'sessions', 'missing'),
      }
    else if (kind === 'outside-root')
      target.binding = {
        ...target.binding,
        sessionFile: join(f.cwd, 'outside'),
      }
    else if (kind === 'symlink') {
      await rename(
        target.binding.sessionFile,
        `${target.binding.sessionFile}.source`,
      )
      await symlink(
        `${target.binding.sessionFile}.source`,
        target.binding.sessionFile,
      )
    } else if (kind === 'empty' || kind === 'malformed')
      await writeFile(
        target.binding.sessionFile,
        kind === 'empty' ? '' : '{malformed}\n',
      )
    else {
      const header = {
        ...target.rows[0],
        ...(kind === 'wrong-id'
          ? { id: 'foreign' }
          : kind === 'wrong-cwd'
            ? { cwd: f.home }
            : { version: 2 }),
      }
      await writeFile(target.binding.sessionFile, `${JSON.stringify(header)}\n`)
    }
    await expect(f.start({ resume: target }, true)).rejects.toThrow()
    expect(await f.wire()).toEqual([])
  })
  it.each(['remove', 'replace', 'empty', 'append'] as const)(
    '09, 11: detects native startup file race %s without restoring external changes',
    async (resumeRace) => {
      const f = await peer({ resumeRace })
      const target = await history(f)
      const original = { ...target.binding }
      await expect(f.start({ resume: target }, true)).rejects.toThrow()
      expect(target.binding).toEqual(original)
      expect(
        (await f.wire()).some((command) => command.type === 'prompt'),
      ).toBe(false)
      if (resumeRace === 'empty' || resumeRace === 'remove')
        expect(await readFile(target.binding.sessionFile, 'utf8')).toContain(
          'native-rewritten',
        )
    },
  )
  it('10: changed native startup identity leaves the caller binding intact', async () => {
    const f = await peer({ changeIdentity: true })
    const target = await history(f)
    await expect(f.start({ resume: target }, true)).rejects.toThrow(
      'PI_RESUME_IDENTITY_CHANGED',
    )
    expect(target.binding.providerSessionId).toBe('saved-id')
  })
  it('12: an extension session replacement prevents later prompt admission', async () => {
    const f = await peer({ behavior: 'manual' })
    const { handle } = await f.start()
    const receipt = handle.prompt('change')
    await receipt.acceptance
    await f.control({
      state: { isStreaming: false, sessionId: 'replacement' },
      events: [
        { type: 'agent_start' },
        { type: 'agent_end', messages: [], willRetry: false },
        { type: 'agent_settled' },
      ],
    })
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      code: 'PI_RESUME_IDENTITY_CHANGED',
    })
    expect(await handle.prompt('later').acceptance).toMatchObject({
      status: 'rejected',
    })
    expect(
      (await f.wire()).filter((command) => command.type === 'prompt'),
    ).toHaveLength(1)
  })
  it('48, 49: imports native entry identities and commits exact end checkpoints', async () => {
    const f = await peer()
    const target = await history(f, [
      { type: 'session_info', name: 'Native name' },
      { type: 'custom', customType: 'extension-state', data: { stable: true } },
      { type: 'thinking_level_change', thinkingLevel: 'off' },
    ])
    const adapter = createPiAdapter(f.options)
    const reader = adapter.createHistoryReader(f.session, target, {
      signal: new AbortController().signal,
    })
    try {
      const first = await reader.read(null, { maxEntries: 2 })
      expect(first.complete).toBe(false)
      expect(first.next).toEqual(first.end)
      expect(
        first.records.map(
          (record) => record.source.kind === 'history' && record.source.entryId,
        ),
      ).toEqual(['entry-0', 'entry-1'])
      const last = await reader.read(first.next)
      expect(last.complete).toBe(true)
      expect(last.next).toBeNull()
      expect(last.end.offset).toBe(
        (await readFile(target.binding.sessionFile)).length,
      )
      expect(f.pages).toEqual([first, last])
      expect(f.events).toEqual([])
      expect(await f.wire()).toEqual([])
      expect(Object.isFrozen(first.records[0]?.body)).toBe(true)
      expect('runtimeGeneration' in reader.owner).toBe(false)
      await appendFile(
        target.binding.sessionFile,
        `${JSON.stringify({ type: 'session_info', id: 'appended', parentId: 'entry-2', timestamp: new Date(5).toISOString(), name: 'later' })}\n`,
      )
      expect((await reader.read(last.end)).records).toHaveLength(1)
    } finally {
      reader.close()
    }
  })
  it('48: history image persistence gets the real Forge owner and import ID', async () => {
    const f = await peer()
    const target = await history(f, [
      {
        type: 'message',
        message: {
          role: 'user',
          timestamp: 0,
          content: [
            {
              type: 'image',
              mimeType: 'image/png',
              data: png.toString('base64'),
            },
          ],
        },
      },
    ])
    const reader = createPiAdapter(f.options).createHistoryReader(
      f.session,
      target,
      { signal: new AbortController().signal },
    )
    try {
      const page = await reader.read(null)
      expect(f.images[0]?.owner).toEqual(reader.owner)
      expect(reader.owner.forgeSessionId).toBe('forge-session')
      expect(JSON.stringify(page)).toContain('attachmentId')
      expect(JSON.stringify(page)).not.toContain(png.toString('base64'))
    } finally {
      reader.close()
    }
  })
  it('48: rejects changed prefix or inode cursors', async () => {
    const f = await peer()
    const target = await history(f)
    const adapter = createPiAdapter(f.options)
    const reader = adapter.createHistoryReader(f.session, target, {
      signal: new AbortController().signal,
    })
    try {
      const first = await reader.read(null)
      await writeFile(
        target.binding.sessionFile,
        (await readFile(target.binding.sessionFile, 'utf8')).replace(
          'saved"',
          'other"',
        ),
      )
      await expect(reader.read(first.end)).rejects.toThrow(
        'PI_HISTORY_CURSOR_CHANGED',
      )
    } finally {
      reader.close()
    }
  })
  it('49, 54: failed page commit never returns an advanced checkpoint', async () => {
    const f = await peer()
    const target = await history(f)
    const reader = createPiAdapter({
      ...f.options,
      commitHistoryPage: async () => {
        throw new Error('transaction failed')
      },
    }).createHistoryReader(f.session, target, {
      signal: new AbortController().signal,
    })
    try {
      await expect(reader.read(null)).rejects.toThrow('transaction failed')
      expect(f.pages).toEqual([])
    } finally {
      reader.close()
    }
  })
  it('49, 54: repeated immutable history bodies are idempotent and changed bodies fail the sink transaction', async () => {
    const f = await peer()
    const target = await history(f)
    const stored = new Map<string, string>()
    let commits = 0
    const adapter = createPiAdapter({
      ...f.options,
      commitHistoryPage: async (_owner, _binding, { page }) => {
        for (const record of page.records) {
          if (record.source.kind !== 'history')
            throw new Error('Expected history owner')
          const key = record.source.entryId
          const value = JSON.stringify({
            body: record.body,
            parentId: record.source.parentId,
          })
          if (stored.has(key) && stored.get(key) !== value)
            throw new Error('Immutable record conflict')
        }
        for (const record of page.records)
          if (record.source.kind === 'history')
            stored.set(
              record.source.entryId,
              JSON.stringify({
                body: record.body,
                parentId: record.source.parentId,
              }),
            )
        commits++
      },
    })
    const reader = adapter.createHistoryReader(f.session, target, {
      signal: new AbortController().signal,
    })
    try {
      await reader.read(null)
      await reader.read(null)
      expect(commits).toBe(2)
      expect(stored.size).toBe(1)
      const original = await readFile(target.binding.sessionFile, 'utf8')
      await writeFile(
        target.binding.sessionFile,
        original.replace('"saved"', '"changed"'),
      )
      await expect(reader.read(null)).rejects.toThrow(
        'Immutable record conflict',
      )
      expect(commits).toBe(2)
      expect(stored.get('entry-0')).toContain('saved')
    } finally {
      reader.close()
    }
  })
  it('55: history remains independent when a live generation dies', async () => {
    const f = await peer()
    const target = await history(f)
    const { adapter, handle } = await f.start()
    const reader = adapter.createHistoryReader(f.session, target, {
      signal: new AbortController().signal,
    })
    await handle.kill()
    try {
      expect((await reader.read(null)).complete).toBe(true)
    } finally {
      reader.close()
    }
  })
  it('48, 55: cancelled page commit retains a completed transaction for reconciliation', async () => {
    const f = await peer()
    const target = await history(f)
    const held = latch()
    const entered = latch()
    const controller = new AbortController()
    const reader = createPiAdapter({
      ...f.options,
      commitHistoryPage: async (owner, binding, input, signal) => {
        await f.options.commitHistoryPage(owner, binding, input, signal)
        entered.resolve()
        await held.promise
      },
    }).createHistoryReader(f.session, target, { signal: controller.signal })
    const read = reader.read(null)
    const rejected = expect(read).rejects.toThrow('PI_CANCELLED')
    await entered.promise
    controller.abort()
    await rejected
    expect(f.pages).toHaveLength(1)
    held.resolve()
    reader.close()
  })
  it('33, 48, 55: cancelled history image sinks retain capacity across new factories', async () => {
    const held = latch()
    let calls = 0
    const image = {
      type: 'message',
      message: {
        role: 'user',
        timestamp: 0,
        content: [
          {
            type: 'image',
            mimeType: 'image/png',
            data: png.toString('base64'),
          },
        ],
      },
    }
    try {
      for (let index = 0; index < 2; index++) {
        const f = await peer()
        const target = await history(f, [image])
        const entered = latch()
        const controller = new AbortController()
        const reader = createPiAdapter({
          ...f.options,
          persistImage: async (...args) => {
            calls++
            entered.resolve()
            await held.promise
            return {
              type: 'image',
              attachmentId: 'late-result',
              mimeType: args[1].mimeType,
              sizeBytes: args[1].bytes.length,
              sha256: imageHash(args[1].bytes),
            }
          },
        }).createHistoryReader(f.session, target, { signal: controller.signal })
        const read = reader.read(null)
        const rejected = expect(read).rejects.toThrow('PI_CANCELLED')
        await entered.promise
        controller.abort()
        await rejected
        reader.close()
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      expect(physicalState().classes.image).toBe(2)
      const f = await peer()
      const target = await history(f, [image])
      let added = 0
      const reader = createPiAdapter({
        ...f.options,
        persistImage: async (...args) => {
          added++
          return f.options.persistImage(...args)
        },
      }).createHistoryReader(f.session, target, {
        signal: new AbortController().signal,
      })
      try {
        await expect(reader.read(null)).rejects.toThrow(
          'PI_PHYSICAL_WORK_CAPACITY',
        )
      } finally {
        reader.close()
      }
      expect(added).toBe(0)
      expect(calls).toBe(2)
    } finally {
      held.resolve()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(physicalState().classes.image).toBe(0)
  })
  it('50: one history import retains publication charges across pages', async () => {
    const f = await peer()
    const target = await history(
      f,
      [1, 2, 3].map((number) => ({
        type: 'session_info',
        name: String(number),
      })),
    )
    const reader = createPiAdapter({
      ...f.options,
      limits: { importPublications: 2 },
    }).createHistoryReader(f.session, target, {
      signal: new AbortController().signal,
    })
    try {
      const first = await reader.read(null, { maxEntries: 1 })
      await expect(reader.read(first.end, { maxEntries: 1 })).rejects.toThrow(
        'PI_PUBLICATION_LIMIT',
      )
      expect(f.pages).toHaveLength(1)
    } finally {
      reader.close()
    }
  })
  it.each([
    '--mode=rpc',
    '--session=x',
    '--resume',
    '-c',
    '--api-key=secret',
    '@file',
    'prompt',
    '--fork',
    '--help',
  ])('02: rejects controlled or positional argument %s', (arg) => {
    expect(() => nativeArguments([arg])).toThrow()
  })
  it('03, 43: preserves explicit extension flags and account defaults without settings writes', () => {
    expect(
      nativeArguments(
        [
          '--extension',
          'local-extension.ts',
          '--custom=true',
          '--model',
          'explicit',
        ],
        { model: 'default', provider: 'fake', thinking: 'off' },
      ),
    ).toEqual([
      '--extension',
      'local-extension.ts',
      '--custom=true',
      '--model',
      'explicit',
      '--provider',
      'fake',
      '--thinking',
      'off',
    ])
  })
  it.each([
    'disabled',
    'kind',
    'provider',
    'account',
    'cwd',
    'command',
    'args',
    'env',
    'policy',
    'missing-authority',
    'missing-account',
    'null-selected-home',
    'home',
    'disabled-harness',
  ])(
    '52: rejects invalid captured authority %s before native launch',
    async (kind) => {
      const f = await peer()
      const options = structuredClone({
        ...f.options,
        loadImage: undefined,
        persistImage: undefined,
        persistRecord: undefined,
        persistSnapshot: undefined,
        commitHistoryPage: undefined,
      }) as unknown as PiAdapterOptions
      Object.assign(options, {
        loadImage: f.options.loadImage,
        persistImage: f.options.persistImage,
        persistRecord: f.options.persistRecord,
        persistSnapshot: f.options.persistSnapshot,
        commitHistoryPage: f.options.commitHistoryPage,
      })
      if (kind === 'missing-authority') options.launch = undefined as never
      else if (kind === 'missing-account')
        options.launch = { ...options.launch, account: undefined as never }
      else if (kind === 'null-selected-home')
        options.launch = { ...options.launch, account: null }
      else if (kind === 'home') options.launch.account!.homePath = f.cwd
      else if (kind === 'disabled-harness')
        options.launch.harness.enabled = false
      else if (kind === 'disabled') options.launch.account!.disabledAt = 1
      else if (kind === 'kind') options.launch.account!.kind = 'claude'
      else if (kind === 'provider') options.providerId = 'foreign'
      else if (kind === 'account') options.launch.account!.id = 'foreign'
      else if (kind === 'cwd')
        options.launch = { ...options.launch, canonicalCwd: f.home }
      else if (kind === 'command') options.executable = '/bin/false'
      else if (kind === 'args') options.args = ['--custom']
      else if (kind === 'env') options.env = { FORGE_FAKE: 'mismatch' }
      else
        options.launch = {
          ...options.launch,
          credentials: 'selected-home-only' as 'native-configured-sources',
        }
      await expect(async () =>
        createPiAdapter(options).spawn(f.session, f.emit),
      ).rejects.toThrow()
      expect(await f.wire()).toEqual([])
    },
  )
  it('05, 53: captures known and custom environment values with exact own-undefined removal', async () => {
    const names = [
      'OPENAI_API_KEY',
      'MY_PI_KEY',
      'FORGE_PI_NEW_ENV',
      'FORGE_PI_DEV_ENV',
    ]
    const previous = Object.fromEntries(
      names.map((key) => [key, process.env[key]]),
    )
    try {
      process.env.OPENAI_API_KEY = 'fake-known'
      process.env.MY_PI_KEY = 'fake-custom'
      process.env.FORGE_PI_DEV_ENV = 'fake-development'
      delete process.env.FORGE_PI_NEW_ENV
      const f = await peer({ envKeys: names })
      const overrides = {
        OPENAI_API_KEY: undefined,
        MY_PI_KEY: 'fake-replacement',
      }
      const adapter = createPiAdapter({
        ...f.options,
        env: overrides,
        launch: { ...f.options.launch, selectedEnvOverrides: overrides },
      })
      process.env.FORGE_PI_NEW_ENV = 'added-after-snapshot'
      process.env.MY_PI_KEY = 'mutated-after-snapshot'
      f.track(await adapter.spawn(f.session, f.emit))
      expect((await f.started()).env).toEqual({
        OPENAI_API_KEY: null,
        MY_PI_KEY: 'fake-replacement',
        FORGE_PI_NEW_ENV: null,
        FORGE_PI_DEV_ENV: 'fake-development',
      })
    } finally {
      for (const key of names) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
    }
  })
  it.each(['inherit', 'replace', 'remove'] as const)(
    '05, 53: known and custom references receive equivalent %s environment policy',
    async (policy) => {
      const keys = [
        'OPENAI_API_KEY',
        'MY_PI_KEY',
        'AWS_PROFILE',
        'GOOGLE_CLOUD_PROJECT',
        'FORGE_PI_DEV_ENV',
      ]
      const previous = Object.fromEntries(
        keys.map((key) => [key, process.env[key]]),
      )
      try {
        for (const key of keys) process.env[key] = `fake-${key}`
        const f = await peer({ envKeys: keys })
        const overrides: Record<string, string | undefined> =
          policy === 'inherit'
            ? {}
            : {
                OPENAI_API_KEY:
                  policy === 'remove' ? undefined : 'fake-selected-known',
                MY_PI_KEY:
                  policy === 'remove' ? undefined : 'fake-selected-custom',
              }
        const adapter = createPiAdapter({
          ...f.options,
          env: overrides,
          launch: { ...f.options.launch, selectedEnvOverrides: overrides },
        })
        f.track(await adapter.spawn(f.session, f.emit))
        expect((await f.started()).env).toEqual({
          OPENAI_API_KEY:
            policy === 'remove'
              ? null
              : policy === 'replace'
                ? 'fake-selected-known'
                : 'fake-OPENAI_API_KEY',
          MY_PI_KEY:
            policy === 'remove'
              ? null
              : policy === 'replace'
                ? 'fake-selected-custom'
                : 'fake-MY_PI_KEY',
          AWS_PROFILE: 'fake-AWS_PROFILE',
          GOOGLE_CLOUD_PROJECT: 'fake-GOOGLE_CLOUD_PROJECT',
          FORGE_PI_DEV_ENV: 'fake-FORGE_PI_DEV_ENV',
        })
      } finally {
        for (const key of keys) {
          if (previous[key] === undefined) delete process.env[key]
          else process.env[key] = previous[key]
        }
      }
    },
  )
  it.each(['load', 'history'] as const)(
    '48, 52: %s rejects a foreign Forge session before file or sink access',
    async (method) => {
      const f = await peer()
      const target = {
        binding: {
          provider: 'pi',
          accountId: 'pi-account',
          cwd: f.cwd,
          providerSessionId: 'saved-id',
          sessionFile: join(f.home, 'sessions', 'does-not-exist'),
        },
      }
      let calls = 0
      const adapter = createPiAdapter({
        ...f.options,
        resume: target,
        persistImage: async () => {
          calls++
          throw new Error('Unexpected sink')
        },
        commitHistoryPage: async () => {
          calls++
        },
      })
      const foreign = { ...f.session, accountId: 'foreign' }
      await expect(async () =>
        method === 'load'
          ? adapter.load(foreign, f.emit)
          : adapter.createHistoryReader(foreign, target, {
              signal: new AbortController().signal,
            }),
      ).rejects.toThrow('PI_ACCOUNT_LAUNCH_SCOPE_MISMATCH')
      expect(calls).toBe(0)
      expect(await f.wire()).toEqual([])
    },
  )
})
