import { describe, expect, it, vi } from 'vitest'
import {
  saveWorkspaceFile,
  searchWorkspaceFiles,
  WorkspaceFilesError,
} from './workspace-files'

describe('workspace file client', () => {
  it('sends the resolved session identity and normalizes newlines on save', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ saved: true }), { status: 200 }),
      )
    const snapshot = {
      workspace: {
        target: { kind: 'session' as const, sessionId: 's1' },
        projectId: 'p1',
        cwd: '/tmp/p1',
        worktreePath: null,
        workspaceId: 'w1',
        workspaceRevision: 4,
      },
      file: {
        path: 'src/a.ts',
        text: 'old',
        contentHash: 'a'.repeat(64),
        fileRevision: 'rev-1',
        sizeBytes: 3,
        modifiedAt: 'now',
        encoding: 'utf8' as const,
        lineEnding: 'lf' as const,
        readOnlyReason: null,
        truncated: false,
      },
    }
    await saveWorkspaceFile(
      { sessionId: 's1', workspaceId: 'w1', workspaceRevision: 4 },
      snapshot,
      'a\r\nb\r',
    )
    const [, init] = fetcher.mock.calls[0]
    expect(JSON.parse(String(init?.body))).toMatchObject({
      target: { kind: 'session', sessionId: 's1' },
      path: 'src/a.ts',
      expectedWorkspaceId: 'w1',
      expectedWorkspaceRevision: 4,
      text: 'a\nb\n',
    })
    fetcher.mockRestore()
  })

  it('preserves server conflict details for recovery UI', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'conflict',
          message: 'File changed on disk',
          current: { path: 'a' },
        }),
        { status: 409 },
      ),
    )
    await expect(
      searchWorkspaceFiles({ sessionId: 's1' }, 'a'),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: 'File changed on disk',
      current: { path: 'a' },
    } satisfies Partial<WorkspaceFilesError>)
    vi.restoreAllMocks()
  })
})
