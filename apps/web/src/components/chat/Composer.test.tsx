// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from './Composer'
import { accountsApi } from '../../lib/accounts-api'

describe('Composer', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const renderComposer = (
    onSend = vi.fn().mockResolvedValue(undefined),
    onTextChange?: (text: string) => void,
  ) => {
    vi.spyOn(accountsApi, 'listAccounts').mockResolvedValue([
      {
        id: 'main',
        harness: 'claude',
        harnessKey: 'claude',
        kind: 'claude',
        label: 'Main',
        storageDir: '/tmp/main',
        homePath: '/tmp/main',
        enabled: true,
        authStatus: 'authenticated',
        email: null,
        cooldownUntil: null,
        cooldownReason: null,
        lastUsedAt: null,
      },
    ])
    render(
      <Composer
        sessionId="session-1"
        harness="claude"
        accountId="main"
        onSend={onSend}
        onTextChange={onTextChange}
      />,
    )
    return screen.getByLabelText('Message composer')
  }

  it('sends on Enter, keeps Shift Enter as a newline, and ignores composing Enter', () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    const composer = renderComposer(onSend)

    fireEvent.change(composer, { target: { value: 'hello' } })
    fireEvent.keyDown(composer, { key: 'Enter', isComposing: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hello', [], {
      harness: 'claude',
      accountId: 'main',
    })
  })

  it('lets the trigger menu consume Enter and Escape', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    HTMLElement.prototype.scrollIntoView = vi.fn()
    const onSend = vi.fn().mockResolvedValue(undefined)
    const composer = renderComposer(onSend)

    fireEvent.change(composer, { target: { value: '/' } })
    expect(screen.getByText('/btw')).toBeTruthy()
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    expect(composer).toHaveProperty('value', '/btw ')

    fireEvent.change(composer, { target: { value: '/help' } })
    fireEvent.keyDown(composer, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('/btw')).toBeNull())
  })

  it('retains the draft and announces a failed send', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('Connection lost'))
    const onTextChange = vi.fn()
    const composer = renderComposer(onSend, onTextChange)

    fireEvent.change(composer, { target: { value: 'keep this draft' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'Connection lost',
      ),
    )
    expect(composer).toHaveProperty('value', 'keep this draft')
    expect(onTextChange).toHaveBeenLastCalledWith('keep this draft')
  })

  it('clears the composer before a send resolves', async () => {
    let resolveSend!: () => void
    const onSend = vi.fn(
      () => new Promise<void>((resolve) => (resolveSend = resolve)),
    )
    const onTextChange = vi.fn()
    const composer = renderComposer(onSend, onTextChange)

    fireEvent.change(composer, { target: { value: 'send now' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(composer).toHaveProperty('value', '')
    expect(onTextChange).toHaveBeenLastCalledWith('')

    resolveSend()
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce())
  })

  it('exposes the manual end-turn action for a running PTY session', () => {
    const onInterrupt = vi.fn().mockResolvedValue(undefined)

    render(
      <Composer
        sessionId="session-1"
        protocol="pty"
        running
        onInterrupt={onInterrupt}
        onSend={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'End turn' }))

    expect(onInterrupt).toHaveBeenCalledOnce()
  })

  it('shows account groups and sends the selected account', async () => {
    vi.spyOn(accountsApi, 'listAccounts').mockResolvedValue([
      {
        id: 'main',
        harness: 'claude',
        harnessKey: 'claude-code-acp',
        kind: 'claude',
        label: 'Main',
        storageDir: '/tmp/main',
        homePath: '/tmp/main',
        enabled: true,
        authStatus: 'authenticated',
        email: null,
        cooldownUntil: null,
        cooldownReason: null,
        lastUsedAt: null,
      },
      {
        id: 'work',
        harness: 'claude',
        harnessKey: 'claude-code-acp',
        kind: 'claude',
        label: 'Work',
        storageDir: '/tmp/work',
        homePath: '/tmp/work',
        enabled: true,
        authStatus: 'authenticated',
        email: null,
        cooldownUntil: null,
        cooldownReason: null,
        lastUsedAt: null,
      },
    ])
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ harnesses: [{ key: 'claude' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    const onSend = vi.fn().mockResolvedValue(undefined)
    const onSelectionChange = vi.fn()
    render(
      <Composer
        sessionId="session-1"
        harness="claude"
        accountId="main"
        onSend={onSend}
        onSelectionChange={onSelectionChange}
      />,
    )

    await waitFor(() =>
      expect(screen.getAllByText('Work').length).toBeGreaterThan(0),
    )
    fireEvent.click(screen.getByRole('combobox', { name: 'Harness' }))
    fireEvent.click(screen.getByRole('option', { name: 'Work' }))
    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenCalledWith({
        harness: 'claude',
        accountId: 'work',
      }),
    )
    const composer = screen.getByLabelText('Message composer')
    fireEvent.change(composer, { target: { value: 'hello' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith('hello', [], {
        harness: 'claude',
        accountId: 'work',
      }),
    )
  })

  it('keeps the initial harness usable when account lookup is unavailable', async () => {
    vi.spyOn(accountsApi, 'listAccounts').mockRejectedValue(
      new Error('offline'),
    )
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<Composer sessionId="session-1" harness="codex" onSend={onSend} />)
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Harness' })).toBeTruthy(),
    )
    const composer = screen.getByLabelText('Message composer')
    fireEvent.change(composer, { target: { value: 'hello' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hello', [], { harness: 'codex' })
  })

  it('shows model choices and sends the selected model', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({ models: [{ id: 'fast', displayName: 'Fast' }] }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          ),
        ),
    )
    const onSend = vi.fn().mockResolvedValue(undefined)
    renderComposer(onSend)
    await waitFor(() =>
      expect(
        screen
          .getByRole('combobox', { name: 'Model' })
          .hasAttribute('disabled'),
      ).toBe(false),
    )
    fireEvent.click(screen.getByRole('combobox', { name: 'Model' }))
    fireEvent.click(screen.getByRole('option', { name: 'Fast' }))
    const composer = screen.getByLabelText('Message composer')
    fireEvent.change(composer, { target: { value: 'hello' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith('hello', [], {
        harness: 'claude',
        accountId: 'main',
        model: 'fast',
      }),
    )
  })

  it('disables the model picker when no models are available', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
    )
    renderComposer()
    await waitFor(() =>
      expect(
        screen
          .getByRole('combobox', { name: 'Model' })
          .hasAttribute('disabled'),
      ).toBe(true),
    )
  })
})
