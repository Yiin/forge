import { describe, expect, it } from 'vitest'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expectStopped } from '../transport-test-helpers.js'
import { readCodexHistoryPage, forkCodexThread } from './history.js'
import { peer, turn, methods, sandbox, type Step } from './test-helpers.js'

async function history(extra: Step[]) {
  const p = await peer()
  await p.save([
    ...p.startup.slice(0, 3),
    {
      method: 'thread/read',
      expected: { threadId: 'root', includeTurns: false },
      result: { thread: p.thread },
    },
    ...extra,
  ])
  const binding = {
    provider: 'codex-test',
    accountId: null,
    cwd: p.root,
    providerSessionId: 'root',
  }
  return { p, binding }
}

describe('Codex bounded native history helpers', () => {
  it('42: turn pages preserve opaque cursors, direction, and notLoaded distinction', async () => {
    const { p, binding } = await history([
      {
        method: 'thread/turns/list',
        expected: {
          threadId: 'root',
          limit: 50,
          itemsView: 'summary',
          sortDirection: 'desc',
          cursor: 'opaque/α',
        },
        result: {
          data: [turn('stored', 'completed', [], 'notLoaded')],
          nextCursor: 'more',
          backwardsCursor: 'anchor',
        },
      },
    ])
    const page = await readCodexHistoryPage(p.options, binding, {
      type: 'turns',
      cursor: 'opaque/α',
    })
    expect(page).toMatchObject({
      type: 'turns',
      itemsView: 'summary',
      complete: false,
      nextCursor: 'more',
      backwardsCursor: 'anchor',
      data: [{ itemsView: 'notLoaded', items: [] }],
    })
    expect(await methods(p)).toEqual([
      'initialize',
      'initialized',
      'config/read',
      'thread/read',
      'thread/turns/list',
    ])
    await expectStopped(
      (await p.trace()).find((frame) => frame.event === 'spawned')!
        .pid as number,
    )
  })
  it('42: item anchor corrections keep the last payload without changing item position', async () => {
    const { p, binding } = await history([
      {
        method: 'thread/items/list',
        expected: {
          threadId: 'root',
          turnId: 'stored',
          limit: 100,
          sortDirection: 'asc',
        },
        result: {
          data: [
            {
              turnId: 'stored',
              item: { id: 'a', type: 'agentMessage', text: 'old' },
            },
            { turnId: 'stored', item: { id: 'b', type: 'plan', text: 'plan' } },
            {
              turnId: 'stored',
              item: { id: 'a', type: 'agentMessage', text: 'new' },
            },
          ],
          nextCursor: null,
          backwardsCursor: 'anchor',
        },
      },
    ])
    const page = await readCodexHistoryPage(p.options, binding, {
      type: 'items',
      turnId: 'stored',
    })
    expect(page.data).toMatchObject([
      { item: { id: 'a', text: 'new' } },
      { item: { id: 'b', text: 'plan' } },
    ])
    expect(page.complete).toBe(true)
  })
  it('42: unavailable hydration preserves the caller binding and closes its helper', async () => {
    const { p, binding } = await history([
      {
        method: 'thread/turns/list',
        error: { code: -32601, message: 'Method unavailable' },
      },
    ])
    const before = structuredClone(binding)
    await expect(
      readCodexHistoryPage(p.options, binding, { type: 'turns' }),
    ).rejects.toThrow('Method unavailable')
    expect(binding).toEqual(before)
    expect(await methods(p)).not.toContain('thread/resume')
    await expectStopped(
      (await p.trace()).find((frame) => frame.event === 'spawned')!
        .pid as number,
    )
  })
  it('73: oversized cursors and foreign item turns fail explicitly', async () => {
    const { p, binding } = await history([
      {
        method: 'thread/items/list',
        result: {
          data: [
            { turnId: 'other', item: { id: 'a', type: 'plan', text: '' } },
          ],
        },
      },
    ])
    await expect(
      readCodexHistoryPage(p.options, binding, {
        type: 'items',
        turnId: 'stored',
        cursor: 'x'.repeat(16385),
      }),
    ).rejects.toThrow()
    expect(await p.trace()).toEqual([])
    await expect(
      readCodexHistoryPage(p.options, binding, {
        type: 'items',
        turnId: 'stored',
      }),
    ).rejects.toThrow('HISTORY_TURN')
  })
})

describe('Codex explicit native fork', () => {
  it('88, 91: forks the exact terminal source boundary into a different target cwd and session tree', async () => {
    const p = await peer()
    const target = join(p.root, 'target')
    await mkdir(target)
    p.startup[2]!.expected = { cwd: target, includeLayers: false }
    const result = {
      ...p.response,
      cwd: target,
      thread: {
        ...p.thread,
        id: 'forked',
        sessionId: 'new-tree',
        cwd: target,
        forkedFromId: 'root',
      },
    }
    await p.save([
      ...p.startup.slice(0, 3),
      {
        method: 'thread/read',
        expected: { threadId: 'root', includeTurns: false },
        result: { thread: p.thread },
      },
      {
        method: 'thread/turns/list',
        result: {
          data: [turn('boundary', 'completed', [], 'summary')],
          nextCursor: null,
        },
      },
      {
        method: 'thread/fork',
        expected: {
          threadId: 'root',
          cwd: target,
          lastTurnId: 'boundary',
          ephemeral: false,
          excludeTurns: true,
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          sandbox: 'workspace-write',
          model: 'm',
          serviceTier: 'default',
          config: {
            model_reasoning_effort: 'medium',
            sandbox_workspace_write: {
              writable_roots: [],
              network_access: false,
              exclude_slash_tmp: false,
              exclude_tmpdir_env_var: false,
            },
          },
        },
        result,
      },
    ])
    const fork = await forkCodexThread(
      p.options,
      {
        provider: 'codex-test',
        accountId: null,
        cwd: p.root,
        providerSessionId: 'root',
      },
      { cwd: target, lastTurnId: 'boundary', sourceSessionId: 'tree' },
    )
    expect(fork.binding).toEqual({
      provider: 'codex-test',
      accountId: null,
      cwd: target,
      providerSessionId: 'forked',
    })
    expect(fork.thread.sessionId).toBe('new-tree')
    expect(await methods(p)).not.toContain('thread/start')
    await expectStopped(
      (await p.trace()).find((frame) => frame.event === 'spawned')!
        .pid as number,
    )
  })
  it.each(['active', 'missing', 'cursor-loop'])(
    '90: rejects %s boundaries without sending fork',
    async (kind) => {
      const { p, binding } = await history([])
      const pages: Step[] =
        kind === 'cursor-loop'
          ? [
              {
                method: 'thread/turns/list',
                result: { data: [], nextCursor: 'loop' },
              },
              {
                method: 'thread/turns/list',
                result: { data: [], nextCursor: 'loop' },
              },
            ]
          : [
              {
                method: 'thread/turns/list',
                result: {
                  data: kind === 'active' ? [turn('boundary')] : [],
                  nextCursor: null,
                },
              },
            ]
      await p.save([
        ...p.startup.slice(0, 3),
        { method: 'thread/read', result: { thread: p.thread } },
        ...pages,
      ])
      await expect(
        forkCodexThread(p.options, binding, {
          cwd: p.root,
          lastTurnId: 'boundary',
        }),
      ).rejects.toThrow('CODEX_FORK_')
      expect(await methods(p)).not.toContain('thread/fork')
    },
  )
  it.each([
    'reused-id',
    'known-id',
    'lineage',
    'cwd',
    'ephemeral',
    'sandbox',
    'missing-id',
  ])(
    '89, 90: rejects invalid %s fork responses and publishes no binding',
    async (kind) => {
      const { p, binding } = await history([])
      const thread = { ...p.thread, id: 'forked', forkedFromId: 'root' }
      const response = { ...p.response, thread, sandbox }
      if (kind === 'reused-id') thread.id = 'root'
      if (kind === 'known-id') thread.id = 'known-source'
      if (kind === 'lineage') thread.forkedFromId = 'foreign'
      if (kind === 'cwd') thread.cwd = '/wrong'
      if (kind === 'ephemeral') thread.ephemeral = true
      if (kind === 'missing-id') thread.id = ''
      if (kind === 'sandbox')
        Object.assign(response, { sandbox: { type: 'dangerFullAccess' } })
      await p.save([
        ...p.startup.slice(0, 3),
        { method: 'thread/read', result: { thread: p.thread } },
        { method: 'thread/fork', result: response },
      ])
      await expect(
        forkCodexThread(p.options, binding, {
          cwd: p.root,
          knownSourceThreadIds: ['known-source'],
        }),
      ).rejects.toThrow()
      expect(
        (await methods(p)).filter((method) => method === 'thread/fork'),
      ).toHaveLength(1)
      await expectStopped(
        (await p.trace()).find((frame) => frame.event === 'spawned')!
          .pid as number,
      )
    },
  )
  it('89: mismatched provider or account fails before process creation', async () => {
    const { p, binding } = await history([])
    for (const value of [
      { ...binding, provider: 'other' },
      { ...binding, accountId: 'other' },
    ])
      await expect(
        forkCodexThread(p.options, value, { cwd: p.root }),
      ).rejects.toThrow('BINDING_SCOPE')
    expect(await p.trace()).toEqual([])
  })
  it('91: cancellation during fork stops its helper without retry', async () => {
    const { p, binding } = await history([
      { method: 'thread/fork', delay: 1000, result: {} },
    ])
    await expect(
      forkCodexThread(
        p.options,
        binding,
        { cwd: p.root },
        AbortSignal.timeout(50),
      ),
    ).rejects.toThrow()
    expect(
      (await methods(p)).filter((method) => method === 'thread/fork').length,
    ).toBeLessThanOrEqual(1)
  })
})
