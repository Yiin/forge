import { describe, expect, it } from 'vitest'
import { writeFile, truncate, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { peer, turn, methods, model } from './test-helpers.js'
import { deferred } from '../transport-test-helpers.js'

describe('Codex atomic attachment admission', () => {
  it('55: a setter during preparation cannot change the admitted prompt options or identity', async () => {
    const p = await peer([{ method: 'turn/start', result: { turn: turn() } }])
    const path = join(p.root, 'image.png')
    await writeFile(path, 'png')
    const gate = deferred<{
      mime: string
      name: string
      path: string
      sizeBytes: number
    }>()
    p.options.loadAttachment = () => gate.promise
    const h = await p.start()
    const sent = h.prompt(
      [{ type: 'attachment', attachmentId: 'image', mime: 'image/png' }],
      undefined,
      { runId: 'captured-run', turnId: 'captured-turn' },
    )
    await h.setConfigOption!('permissionMode', 'yolo')
    await expect(h.prompt('overlap')).rejects.toThrow('BUSY')
    gate.resolve({ mime: 'image/png', name: 'image', path, sizeBytes: 3 })
    const receipt = await sent
    expect(receipt).toMatchObject({
      runId: 'captured-run',
      turnId: 'captured-turn',
    })
    expect(
      (await p.trace()).find((frame) => frame.method === 'turn/start')!.params,
    ).toMatchObject({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'workspaceWrite' },
    })
  })
  it.each([
    'foreign',
    'missing',
    'partial',
    'changed',
    'mime',
    'oversize',
    'unsupported',
    'symlink',
  ])(
    '40, 41: %s attachment rejects the complete input before native dispatch',
    async (kind) => {
      const p = await peer(
        [],
        kind === 'unsupported'
          ? {
              modelPages: [
                {
                  method: 'model/list',
                  result: {
                    data: [{ ...model, inputModalities: ['text'] }],
                    nextCursor: null,
                  },
                },
              ],
            }
          : {},
      )
      const path = join(p.root, 'image.png')
      await writeFile(path, 'png')
      if (kind === 'oversize') await truncate(path, 10 * 1024 * 1024 + 1)
      if (kind === 'symlink') await symlink(path, join(p.root, 'link.png'))
      let calls = 0
      p.options.loadAttachment = async (sessionId, id) => {
        expect(sessionId).toBe('session')
        calls++
        if (kind === 'foreign' || (kind === 'partial' && id === 'second'))
          throw new Error('Fixture ownership failure')
        if (kind === 'changed' && id === 'second')
          await writeFile(path, 'changed')
        return {
          mime: kind === 'mime' ? 'image/jpeg' : 'image/png',
          name: 'image',
          path:
            kind === 'missing'
              ? join(p.root, 'missing')
              : kind === 'symlink'
                ? join(p.root, 'link.png')
                : path,
          sizeBytes:
            kind === 'oversize'
              ? 10 * 1024 * 1024 + 1
              : kind === 'changed' && id === 'second'
                ? 7
                : 3,
        }
      }
      const h = await p.start()
      const inputs = [
        { type: 'text' as const, text: 'keep draft' },
        {
          type: 'attachment' as const,
          attachmentId: 'first',
          mime: 'image/png',
        },
        {
          type: 'attachment' as const,
          attachmentId: 'second',
          mime: 'image/png',
        },
      ]
      await expect(h.prompt(inputs)).rejects.toThrow()
      expect(calls).toBeGreaterThan(0)
      expect(await methods(p)).not.toContain('turn/start')
      expect(p.events).toEqual([])
    },
  )

  it('40: image steering sends the authorized path and captured turn ID', async () => {
    const p = await peer([
      { method: 'turn/start', result: { turn: turn() } },
      { method: 'turn/steer', result: { turnId: 't1' } },
    ])
    const path = join(p.root, 'image.png')
    await writeFile(path, 'png')
    p.options.loadAttachment = async () => ({
      mime: 'image/png',
      name: 'image',
      path,
      sizeBytes: 3,
    })
    const h = await p.start()
    const root = await h.prompt('start')
    const receipt = await h.steer!([
      { type: 'attachment', attachmentId: 'image', mime: 'image/png' },
    ])
    expect(receipt.completion).toBe(root.completion)
    expect(
      (await p.trace()).find((frame) => frame.method === 'turn/steer')!.params,
    ).toMatchObject({
      expectedTurnId: 't1',
      input: [{ type: 'localImage', path }],
    })
  })
})
