// @vitest-environment jsdom
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from './Composer'
import { accountsApi } from '../../lib/accounts-api'
import { api } from '../../lib/api'
import { useMessagesStore } from '../../stores/messages'
import type { HarnessSelection } from './harness-picker-logic'

const openModelPicker = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Model' }))

describe('Composer', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }))
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
  })
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
      connectionNotice?: { text: string; offline: boolean }
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
        connectionNotice={options.connectionNotice}
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

  it('shows a quiet caption above the pill while the connection is down', () => {
    renderComposer(undefined, undefined, {
      connectionNotice: {
        text: "Offline, messages will send when you're back online.",
        offline: true,
      },
    })
    const caption = screen
      .getAllByRole('status')
      .find((node) => node.textContent?.includes('Offline'))!
    expect(caption.textContent).toBe(
      "Offline, messages will send when you're back online.",
    )
    // One caption line with an amber dot, not a warning box.
    expect(caption.querySelector('.bg-warning')).not.toBeNull()
    expect(caption.className).toContain('text-faint-foreground')
    expect(caption.className).not.toContain('border')
    expect(screen.queryByRole('alert')).toBeNull()
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

  it('sends completed attachments without typed text', async () => {
    vi.spyOn(api, 'upload').mockResolvedValue({
      attachmentId: 'attachment-only',
      putUrl: 'https://uploads.test/attachment-only',
    })
    const onSend = vi.fn().mockResolvedValue(undefined)
    renderComposer(onSend)
    fireEvent.paste(screen.getByLabelText('Message composer'), {
      clipboardData: {
        files: [new File(['image'], 'image.png', { type: 'image/png' })],
      },
    })
    await waitFor(() => expect(screen.getByText('image.png')).toBeTruthy())
    fireEvent.submit(screen.getByRole('textbox').closest('form')!)
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith('', ['attachment-only'], {
        harness: 'claude',
        accountId: 'main',
      }),
    )
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

    openModelPicker()
    const account = await screen.findByRole('button', { name: /Account/ })
    await waitFor(() => expect(account.textContent).toContain('Main'))
    fireEvent.click(account)
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Work' }))
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

    openModelPicker()
    const account = await screen.findByRole('button', { name: /Account/ })
    await waitFor(() => expect(account.textContent).toContain('Main'))
    fireEvent.click(account)
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Work' }))
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

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Model' }).textContent,
      ).toContain('No agents available'),
    )
    openModelPicker()
    expect(
      (
        await screen.findByRole('link', { name: 'Add an account' })
      ).getAttribute('href'),
    ).toBe('/settings/accounts')
  })

  it('keeps the initial harness usable when account lookup is unavailable', async () => {
    vi.spyOn(accountsApi, 'listAccounts').mockRejectedValue(
      new Error('offline'),
    )
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<Composer sessionId="session-1" harness="codex" onSend={onSend} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Model' })).toBeTruthy(),
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
    openModelPicker()
    fireEvent.click(await screen.findByRole('option', { name: /^Fast/ }))
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
        screen.getByRole('button', { name: 'Model' }).textContent,
      ).toContain('Fast'),
    )
    expect(
      screen.getByRole('button', { name: 'Model' }).textContent,
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
    openModelPicker()
    fireEvent.click(await screen.findByRole('option', { name: /^Fast/ }))
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

  it('explains an empty model list inside the picker', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
    )
    renderComposer()
    openModelPicker()
    expect(
      await screen.findByText('This session does not expose model choices'),
    ).toBeTruthy()
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
      expect(
        screen.getByRole('button', { name: 'Model' }).textContent,
      ).toContain('High'),
    )
    openModelPicker()
    fireEvent.click(await screen.findByRole('button', { name: /Reasoning/ }))
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
    openModelPicker()
    await screen.findByRole('listbox', { name: 'Models' })
    expect(screen.queryByRole('button', { name: /Reasoning/ })).toBeNull()
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

  it.each([undefined, 'project-1'])(
    'stages a pasted draft image with project %s',
    async (projectId) => {
      const upload = vi.spyOn(api, 'upload').mockResolvedValue({
        attachmentId: 'attachment-1',
        putUrl: 'https://uploads.test/attachment-1',
      })
      render(
        <Composer
          sessionId="draft-1"
          draftMode
          draftProjectId={projectId}
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
        { draftId: 'draft-1', projectId },
      )
    },
  )

  it('paints live Markdown under a transparent textarea and keeps the text plain', () => {
    const onTextChange = vi.fn()
    const composer = renderComposer(undefined, onTextChange)
    fireEvent.change(composer, { target: { value: '**bold** and `code`' } })
    expect(composer).toHaveProperty('value', '**bold** and `code`')
    expect(composer.className).toContain('text-transparent')
    const layer = composer.nextElementSibling as HTMLElement
    expect(layer.getAttribute('aria-hidden')).toBe('true')
    expect(layer.querySelector('.composer-md-strong')?.textContent).toBe('bold')
    expect(layer.textContent).toBe('**bold** and `code`')
    // IME composition shows the textarea's own text instead.
    fireEvent.compositionStart(composer)
    expect(composer.className).toContain('text-foreground')
    expect(composer.nextElementSibling).toBeNull()
    fireEvent.compositionEnd(composer)
    expect(composer.nextElementSibling).not.toBeNull()
  })

  it('continues a list on Shift+Enter and indents it with Tab', () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    const onTextChange = vi.fn()
    const composer = renderComposer(onSend, onTextChange) as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: '- one' } })
    composer.setSelectionRange(5, 5)
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true })
    expect(composer.value).toBe('- one\n- ')
    expect(onTextChange).toHaveBeenLastCalledWith('- one\n- ')
    expect(composer.selectionStart).toBe(8)

    const tab = createEvent.keyDown(composer, { key: 'Tab' })
    fireEvent(composer, tab)
    expect(tab.defaultPrevented).toBe(true)
    expect(composer.value).toBe('- one\n  - ')
    fireEvent.keyDown(composer, { key: 'Tab', shiftKey: true })
    expect(composer.value).toBe('- one\n- ')
    expect(onSend).not.toHaveBeenCalled()

    // Outside a list, Tab keeps moving focus.
    fireEvent.change(composer, { target: { value: 'plain' } })
    const plainTab = createEvent.keyDown(composer, { key: 'Tab' })
    fireEvent(composer, plainTab)
    expect(plainTab.defaultPrevented).toBe(false)
  })

  it('shows a picked skill as a chip that Backspace removes whole', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(
          String(input).endsWith('/skills')
            ? new Response(
                JSON.stringify({
                  skills: [{ name: 'beads', description: '' }],
                }),
                { status: 200 },
              )
            : new Response('{}', { status: 404 }),
        ),
      ),
    )
    const composer = renderComposer() as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: '$' } })
    fireEvent.click(await screen.findByRole('option', { name: /\$beads/ }))
    fireEvent.change(composer, { target: { value: 'use $beads' } })
    const layer = composer.nextElementSibling as HTMLElement
    expect(layer.querySelector('.bg-code-wash')?.textContent).toBe('$beads')
    composer.setSelectionRange(10, 10)
    fireEvent.keyDown(composer, { key: 'Backspace' })
    expect(composer.value).toBe('use ')
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

  it('keeps projectless draft uploads available for removal', async () => {
    const upload = vi
      .spyOn(api, 'upload')
      .mockResolvedValue({ attachmentId: 'projectless', putUrl: '/put' })
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

    await waitFor(() => expect(upload).toHaveBeenCalledOnce())
    expect(upload.mock.calls[0][3]).toEqual({
      draftId: 'draft-1',
      projectId: undefined,
    })
    expect(screen.getByRole('button', { name: /Remove/ })).toBeTruthy()
  })
})

it('keeps an accountless session selection while provider metadata loads', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  )
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
  )
  let resolveHarnesses!: (
    value: Awaited<ReturnType<typeof accountsApi.listHarnesses>>,
  ) => void
  const pending = new Promise<
    Awaited<ReturnType<typeof accountsApi.listHarnesses>>
  >((resolve) => {
    resolveHarnesses = resolve
  })
  vi.spyOn(accountsApi, 'listHarnesses').mockReturnValue(pending)
  vi.spyOn(accountsApi, 'listAccounts').mockResolvedValue([])
  vi.spyOn(accountsApi, 'listHarnessStatus').mockResolvedValue([])
  const send = vi.fn().mockResolvedValue(undefined)
  const view = render(
    <Composer sessionId="accountless" harness="grok" onSend={send} />,
  )
  try {
    fireEvent.change(screen.getByLabelText('Message composer'), {
      target: { value: 'Preserve selection' },
    })
    resolveHarnesses([
      {
        key: 'custom-acp',
        name: 'Custom',
        enabled: true,
        protocol: 'acp',
        adapterKind: 'custom',
      },
      {
        key: 'grok',
        name: 'Grok',
        enabled: true,
        protocol: 'acp',
        adapterKind: 'acp',
      },
    ])
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled'),
      ).toBe(false),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'Preserve selection',
        [],
        expect.objectContaining({ harness: 'grok', accountId: undefined }),
      ),
    )
  } finally {
    view.unmount()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
