import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAcpServices } from './services.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

describe('ACP client services', () => {
  it('auto-grants allow_always and reads and writes inside the project', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-acp-'))
    dirs.push(dir)
    const services = createAcpServices({ cwd: dir, projectRoot: dir })
    const permission = await services.onRequestPermission?.({
      sessionId: 'session',
      toolCall: { toolCallId: 'tool', title: 'Run command' },
      options: [
        { kind: 'allow_once', name: 'once', optionId: 'once' },
        { kind: 'allow_always', name: 'always', optionId: 'always' },
      ],
    })
    expect(permission).toEqual({
      outcome: { outcome: 'selected', optionId: 'always' },
    })
    await services.onWriteTextFile?.({
      sessionId: 'session',
      path: 'note.txt',
      content: 'one\ntwo\nthree',
    })
    expect(
      await services.onReadTextFile?.({
        sessionId: 'session',
        path: 'note.txt',
        line: 2,
        limit: 1,
      }),
    ).toEqual({ content: 'two' })
    expect(await readFile(join(dir, 'note.txt'), 'utf8')).toBe(
      'one\ntwo\nthree',
    )
  })

  it('rejects path escapes and retains the output tail', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-acp-'))
    dirs.push(dir)
    const services = createAcpServices({ cwd: dir, projectRoot: dir })
    await expect(
      services.onReadTextFile?.({
        sessionId: 'session',
        path: '../../etc/passwd',
      }),
    ).rejects.toThrow('outside')
    const terminal = await services.onTerminalCreate?.({
      sessionId: 'session',
      command: 'printf',
      args: ['123456789'],
      outputByteLimit: 4,
    })
    await services.onTerminalWaitForExit?.({
      sessionId: 'session',
      terminalId: terminal!.terminalId,
    })
    expect(
      await services.onTerminalOutput?.({
        sessionId: 'session',
        terminalId: terminal!.terminalId,
      }),
    ).toMatchObject({
      output: '6789',
      truncated: true,
      exitStatus: { exitCode: 0 },
    })
  })

  it('kills a running terminal and releases all session terminals', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-acp-'))
    dirs.push(dir)
    const services = createAcpServices({ cwd: dir, projectRoot: dir })
    const terminal = await services.onTerminalCreate?.({
      sessionId: 'session',
      command: 'sleep',
      args: ['30'],
    })
    await services.onTerminalKill?.({
      sessionId: 'session',
      terminalId: terminal!.terminalId,
    })
    const result = await services.onTerminalWaitForExit?.({
      sessionId: 'session',
      terminalId: terminal!.terminalId,
    })
    expect(result!.signal).toBe('SIGTERM')
    await services.releaseSession('session')
    await expect(
      services.onTerminalOutput?.({
        sessionId: 'session',
        terminalId: terminal!.terminalId,
      }),
    ).rejects.toThrow('not found')
  })

  it('runs a piped command through a shell', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-acp-'))
    dirs.push(dir)
    const services = createAcpServices({ cwd: dir, projectRoot: dir })
    const terminal = await services.onTerminalCreate?.({
      sessionId: 'session',
      command: 'echo hello | tr a-z A-Z',
    })

    expect(
      await services.onTerminalWaitForExit?.({
        sessionId: 'session',
        terminalId: terminal!.terminalId,
      }),
    ).toEqual({ exitCode: 0, signal: null })
    expect(
      await services.onTerminalOutput?.({
        sessionId: 'session',
        terminalId: terminal!.terminalId,
      }),
    ).toMatchObject({ output: 'HELLO\n' })
  })

  it('runs an explicit argv without a shell', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-acp-'))
    dirs.push(dir)
    const services = createAcpServices({ cwd: dir, projectRoot: dir })
    const terminal = await services.onTerminalCreate?.({
      sessionId: 'session',
      command: 'echo',
      args: ['$HOME'],
    })

    await services.onTerminalWaitForExit?.({
      sessionId: 'session',
      terminalId: terminal!.terminalId,
    })
    expect(
      await services.onTerminalOutput?.({
        sessionId: 'session',
        terminalId: terminal!.terminalId,
      }),
    ).toMatchObject({ output: '$HOME\n' })
  })

  it('kills a shell-wrapped terminal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-acp-'))
    dirs.push(dir)
    const services = createAcpServices({ cwd: dir, projectRoot: dir })
    const terminal = await services.onTerminalCreate?.({
      sessionId: 'session',
      command: 'sleep 30',
    })

    await services.onTerminalKill?.({
      sessionId: 'session',
      terminalId: terminal!.terminalId,
    })
    const result = await services.onTerminalWaitForExit?.({
      sessionId: 'session',
      terminalId: terminal!.terminalId,
    })
    expect(result!.signal).toBe('SIGTERM')
    await services.releaseSession('session')
  })

  it('reports a missing command as a failed terminal instead of crashing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-acp-'))
    dirs.push(dir)
    const services = createAcpServices({ cwd: dir, projectRoot: dir })
    const terminal = await services.onTerminalCreate?.({
      sessionId: 'session',
      command: 'definitely-not-a-real-binary-xyz',
    })

    const result = await services.onTerminalWaitForExit?.({
      sessionId: 'session',
      terminalId: terminal!.terminalId,
    })

    expect(result?.exitCode).not.toBe(0)
    expect(
      await services.onTerminalOutput?.({
        sessionId: 'session',
        terminalId: terminal!.terminalId,
      }),
    ).toMatchObject({ exitStatus: { exitCode: 127, signal: null } })
  })
})
