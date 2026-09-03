// @vitest-environment jsdom
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from './Composer'
import { accountsApi } from '../../lib/accounts-api'
import { api } from '../../lib/api'
import { useMessagesStore } from '../../stores/messages'
import type { HarnessSelection } from './harness-picker-logic'

describe('Composer', () => {
  afterEach(() => {
    cleanup()
    useMessagesStore.setState({ volatile: [] })
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const renderComposer = (
    onSend = vi.fn().mockResolvedValue(undefined),
    onTextChange?: (text: string) => void,
    options: {
      running?: boolean
      onQueue?: (
        text: string,
        attachmentIds: string[],
        selection: HarnessSelection,
      ) => Promise<void>
    } = {},
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
        onQueue={options.onQueue}
        running={options.running}
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

  it('queues on Enter while running and labels the send control', () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    const onQueue = vi.fn().mockResolvedValue(undefined)
    const composer = renderComposer(onSend, undefined, {
      running: true,
      onQueue,
    })
    fireEvent.change(composer, { target: { value: 'wait for turn' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    expect(onQueue).toHaveBeenCalledWith('wait for turn', [], {
      harness: 'claude',
      accountId: 'main',
    })
    expect(screen.getByRole('button', { name: 'Queue message' })).toBeTruthy()
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

  it('loads skills for the dollar menu and inserts the selected skill', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/skills'))
          return Promise.resolve(
            new Response(
              JSON.stringify({
                skills: [{ name: 'beads', description: 'Track work' }],
              }),
              { status: 200 },
            ),
          )
        return Promise.resolve(new Response('{}', { status: 404 }))
      }),
    )
    const composer = renderComposer()
    fireEvent.change(composer, { target: { value: '$' } })
    expect(await screen.findByText('$beads')).toBeTruthy()
    fireEvent.click(screen.getByRole('option', { name: /\$beads/ }))
    expect(composer).toHaveProperty('value', '$beads ')
  })

  it('maps object-shaped available commands into the slash menu', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    const composer = renderComposer()
    useMessagesStore.setState({
      volatile: [
        {
          type: 'availableCommands',
          seq: null,
          sessionId: 'session-1',
          commands: [{ name: 'review', description: 'Review changes' }],
        },
      ],
    })
    fireEvent.change(composer, { target: { value: '/' } })
    expect(await screen.findByText('/review')).toBeTruthy()
    useMessagesStore.setState({ volatile: [] })
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

  it('does not send again while a send is in flight', async () => {
    let resolveSend!: () => void
    const onSend = vi.fn(
      () => new Promise<void>((resolve) => (resolveSend = resolve)),
    )
    render(
      <Composer
        sessionId="session-1"
        harness="claude"
        accountId="main"
        onSend={onSend}
      />,
    )
    const composer = screen.getByLabelText('Message composer')
    fireEvent.change(composer, { target: { value: 'hello' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledOnce()
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
      expect(
        screen.getByRole('combobox', { name: 'Harness' }).textContent,
      ).toContain('Main'),
    )
    fireEvent.click(screen.getByRole('combobox', { name: 'Harness' }))
    const workOption = await screen.findByRole('option', { name: 'Work' })
    fireEvent.keyDown(workOption, { key: 'ArrowDown' })
    fireEvent.keyDown(workOption, { key: 'Enter' })
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

  it('keeps the selected model when switching accounts of the same harness', async () => {
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
    const onSelectionChange = vi.fn()
    render(
      <Composer
        sessionId="session-1"
        harness="claude"
        accountId="main"
        model="opus"
        onSend={vi.fn().mockResolvedValue(undefined)}
        onSelectionChange={onSelectionChange}
      />,
    )

    await waitFor(() =>
      expect(
        screen.getByRole('combobox', { name: 'Harness' }).textContent,
      ).toContain('Main'),
    )
    fireEvent.click(screen.getByRole('combobox', { name: 'Harness' }))
    const workOption = await screen.findByRole('option', { name: 'Work' })
    fireEvent.keyDown(workOption, { key: 'ArrowDown' })
    fireEvent.keyDown(workOption, { key: 'Enter' })
    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenCalledWith({
        harness: 'claude',
        accountId: 'work',
        model: 'opus',
      }),
    )
  })

  it('does not render dead accountless harness rows', async () => {
    vi.spyOn(accountsApi, 'listAccounts').mockResolvedValue([])
    vi.spyOn(accountsApi, 'listHarnesses').mockResolvedValue([
      { key: 'claude', name: 'Claude', enabled: true, protocol: 'acp' },
    ])
    render(
      <Composer
        sessionId="session-1"
        harness="claude"
        onSend={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    await waitFor(() => expect(screen.queryByText('No account')).toBeNull())
  })

  it('links to harness settings when no harness is available', async () => {
    vi.spyOn(accountsApi, 'listAccounts').mockResolvedValue([])
    vi.spyOn(accountsApi, 'listHarnesses').mockResolvedValue([
      { key: 'claude', name: 'Claude', enabled: false, protocol: 'acp' },
    ])
    render(
      <Composer
        sessionId="session-1"
        harness="claude"
        onSend={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    await waitFor(() => {
      expect(screen.queryByRole('combobox', { name: 'Harness' })).toBeNull()
      expect(
        screen
          .getByRole('link', { name: 'Add an account' })
          .getAttribute('href'),
      ).toBe('/settings/harnesses')
    })
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

  it('shows the selected model display name in the trigger', async () => {
    vi.spyOn(accountsApi, 'getModels').mockResolvedValue({
      accountId: 'main',
      harnessKey: 'claude-code-acp',
      models: [{ id: 'fast', displayName: 'Fast' }],
      source: 'static',
      updatedAt: Date.now(),
    })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ models: [{ id: 'fast', displayName: 'Fast' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
    )
    render(
      <Composer
        sessionId="session-1"
        harness="claude"
        accountId="main"
        model="fast"
        onSend={vi.fn().mockResolvedValue(undefined)}
      />,
    )
    await waitFor(() =>
      expect(
        screen.getByRole('combobox', { name: 'Model' }).textContent,
      ).toContain('Fast'),
    )
    expect(
      screen.getByRole('combobox', { name: 'Model' }).textContent,
    ).not.toContain('Model')
  })

  it('shows and sends the model picker in draft mode', async () => {
    vi.spyOn(accountsApi, 'getModels').mockResolvedValue({
      accountId: 'main',
      harnessKey: 'claude-code-acp',
      models: [{ id: 'fast', displayName: 'Fast' }],
      source: 'static',
      updatedAt: Date.now(),
    })
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(
      <Composer
        sessionId="draft-1"
        harness="claude"
        accountId="main"
        draftMode
        onSend={onSend}
      />,
    )
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

  it('shows config options and sends only changed values', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        const body = url.includes('config-options')
          ? {
              configOptions: [
                {
                  id: 'thought_level',
                  name: 'Reasoning',
                  type: 'select',
                  currentValue: 'high',
                  category: 'thought_level',
                  options: [
                    { value: 'high', name: 'High' },
                    { value: 'low', name: 'Low' },
                  ],
                },
              ],
            }
          : { models: [] }
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }),
    )
    const onSend = vi.fn().mockResolvedValue(undefined)
    renderComposer(onSend)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Reasoning' })).toBeTruthy(),
    )
    expect(
      screen.getByRole('button', { name: 'Reasoning' }).textContent,
    ).toContain('High')
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning' }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Low' }))
    const composer = screen.getByLabelText('Message composer')
    fireEvent.change(composer, { target: { value: 'hello' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith('hello', [], {
        harness: 'claude',
        accountId: 'main',
        configOptions: { thought_level: 'low' },
      }),
    )
  })

  it('does not show config options in draft mode or when none are advertised', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ configOptions: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    renderComposer()
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Reasoning' })).toBeNull(),
    )
    cleanup()
    render(
      <Composer
        sessionId="draft-1"
        harness="claude"
        accountId="main"
        draftMode
        onSend={vi.fn().mockResolvedValue(undefined)}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Reasoning' })).toBeNull()
  })

  it('stages a pasted image in a draft and uploads it to the draft project', async () => {
    const upload = vi.spyOn(api, 'upload').mockResolvedValue({
      attachmentId: 'attachment-1',
      putUrl: 'https://uploads.test/attachment-1',
    })
    render(
      <Composer
        sessionId="draft-1"
        draftMode
        draftProjectId="project-1"
        harness="claude"
        accountId="main"
        onSend={vi.fn().mockResolvedValue(undefined)}
      />,
    )
    const composer = screen.getByLabelText('Message composer')
    const file = new File(['image'], 'pasted.png', { type: 'image/png' })

    fireEvent.paste(composer, { clipboardData: { files: [file] } })

    await waitFor(() => expect(screen.getByText('pasted.png')).toBeTruthy())
    expect(upload).toHaveBeenCalledWith(
      'draft-1',
      file,
      expect.any(Function),
      'project-1',
    )
  })

  it('prevents the browser from inserting pasted files into the composer', () => {
    vi.spyOn(api, 'upload').mockResolvedValue({
      attachmentId: 'attachment-1',
      putUrl: 'https://uploads.test/attachment-1',
    })
    renderComposer()
    const composer = screen.getByLabelText('Message composer')
    const event = createEvent.paste(composer, {
      clipboardData: {
        files: [new File(['image'], 'image.png', { type: 'image/png' })],
      },
    })
    const preventDefault = vi.spyOn(event, 'preventDefault')

    fireEvent(composer, event)

    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('does not prevent or stage a text-only paste', () => {
    const upload = vi.spyOn(api, 'upload')
    renderComposer()
    const composer = screen.getByLabelText('Message composer')
    const event = createEvent.paste(composer, {
      clipboardData: { files: [] },
    })
    const preventDefault = vi.spyOn(event, 'preventDefault')

    fireEvent(composer, event)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull()
  })

  it('names a nameless pasted image before upload', async () => {
    const upload = vi.spyOn(api, 'upload').mockResolvedValue({
      attachmentId: 'attachment-1',
      putUrl: 'https://uploads.test/attachment-1',
    })
    renderComposer()
    const composer = screen.getByLabelText('Message composer')
    const file = new File(['image'], '', { type: 'image/png' })

    fireEvent.paste(composer, { clipboardData: { files: [file] } })

    await waitFor(() => expect(upload).toHaveBeenCalledOnce())
    const uploaded = upload.mock.calls[0][1]
    expect(uploaded.name).toMatch(/^pasted-\d+\.png$/)
  })

  it('keeps uploads disabled in draft mode without a project id', () => {
    const upload = vi.spyOn(api, 'upload')
    render(
      <Composer
        sessionId="draft-1"
        draftMode
        harness="claude"
        accountId="main"
        onSend={vi.fn().mockResolvedValue(undefined)}
      />,
    )
    fireEvent.paste(screen.getByLabelText('Message composer'), {
      clipboardData: {
        files: [new File(['image'], 'image.png', { type: 'image/png' })],
      },
    })

    expect(upload).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull()
  })
})
