// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatRenderItem, ToolGroupEntry, ToolItem } from './render-model'
import { AgentToolCard, ToolGroup } from './ToolGroup'
import { useShellStore } from '../../stores/shell'

let next = 0
const tool = (
  name: string,
  input: unknown,
  extra: Partial<ToolItem> = {},
): ToolItem => ({
  kind: 'tool',
  id: `tool-${next++}`,
  name,
  state: 'done',
  input,
  ...extra,
})
const group = (
  entries: ToolGroupEntry[],
): Extract<ChatRenderItem, { kind: 'tool-group' }> => ({
  kind: 'tool-group',
  id: `tool-group:${entries[0].id}`,
  entries,
})

describe('ToolGroup', () => {
  afterEach(cleanup)

  it('stays closed once settled and opens on click', () => {
    render(<ToolGroup item={group([tool('Bash', { command: 'hostname' })])} />)
    const header = screen.getByRole('button', { name: 'Ran 1 command' })
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: 'Run hostname' })).toBeNull()
    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'Run hostname' })).toBeTruthy()
  })

  it('opens the live tail group and shimmers its summary', () => {
    const view = render(
      <ToolGroup
        live
        item={group([tool('Bash', { command: 'pwd' }, { state: 'running' })])}
      />,
    )
    expect(
      screen
        .getByRole('button', { name: 'Ran 1 command' })
        .getAttribute('aria-expanded'),
    ).toBe('true')
    expect(screen.getByRole('button', { name: 'Run pwd' })).toBeTruthy()
    expect(view.container.querySelector('.tool-shimmer')).not.toBeNull()
  })

  it('shows the call first, then output capped with a show-full link', () => {
    const output = Array.from({ length: 30 }, (_, index) => `line ${index}`)
    render(
      <ToolGroup
        live
        item={group([
          tool('Bash', { command: 'seq 30' }, { output: output.join('\n') }),
        ])}
      />,
    )
    const row = screen.getByRole('button', { name: 'Run seq 30' })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(row)
    const detail = document.getElementById(
      row.getAttribute('aria-controls') ?? '',
    )
    expect(detail?.textContent).toMatch(/^seq 30line 0/)
    expect(detail?.textContent).toContain('line 23')
    expect(detail?.textContent).not.toContain('line 24')
    expect(detail?.textContent).toContain('… 6 more lines')
    fireEvent.click(screen.getByRole('button', { name: /^Show full output/ }))
    expect(detail?.textContent).toContain('line 29')
  })

  it('marks a failed tool on its row, not on the header', () => {
    render(
      <ToolGroup
        live
        item={group([tool('Bash', { command: 'false' }, { state: 'error' })])}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'Ran 1 command · 1 failed' }),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Run false Failed' }),
    ).toBeTruthy()
  })

  it('opens a file tool path in the workspace dock', () => {
    useShellStore.setState({ docks: {}, dockWidth: 480 })
    render(
      <ToolGroup
        live
        sessionId="session-1"
        item={group([tool('Read', { file_path: 'src/main.ts' })])}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Read main.ts' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open src/main.ts' }))
    expect(useShellStore.getState().dock('session-1').tabs).toContainEqual(
      expect.objectContaining({ kind: 'file', path: 'src/main.ts' }),
    )
  })

  it('renders an edit as a diff with markers', () => {
    render(
      <ToolGroup
        live
        item={group([
          tool('Edit', {
            file_path: 'a.ts',
            old_string: 'old line',
            new_string: 'new line',
          }),
        ])}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit a.ts' }))
    expect(screen.getByText('old line')).toBeTruthy()
    expect(screen.getByText('new line')).toBeTruthy()
    expect(screen.getByText('−')).toBeTruthy()
    expect(screen.getByText('+')).toBeTruthy()
  })

  it('opens a streaming thought and closes it once settled', () => {
    const thought = {
      kind: 'message' as const,
      id: 'thought-1',
      seq: 1,
      role: 'agent' as const,
      thought: true,
      text: 'Checking **the** tests',
    }
    const view = render(<ToolGroup live item={group([thought])} />)
    // A thought-only group reads "Thought process" too; the row comes second.
    const row = screen.getAllByRole('button', { name: 'Thought process' })[1]
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('the').className).toContain('font-semibold')
    // Settled: the group folds and the thought inside it closes.
    view.rerender(<ToolGroup item={group([thought])} />)
    for (const button of screen.getAllByRole('button', {
      name: 'Thought process',
    }))
      expect(button.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('ToolGroup arrivals', () => {
  const played: { node: Element; keyframes: Keyframe[]; delay?: number }[] = []
  const setup = (reduce = false) => {
    played.length = 0
    vi.spyOn(performance, 'now').mockReturnValue(1000)
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: reduce && query.includes('reduce'),
    }))
    Element.prototype.animate = function (
      this: Element,
      keyframes: Keyframe[],
      options?: KeyframeAnimationOptions,
    ) {
      played.push({ node: this, keyframes, delay: Number(options?.delay) })
      return {} as Animation
    } as Element['animate']
  }
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete (Element.prototype as Partial<Element>).animate
  })
  const property = (name: string) =>
    played.filter((entry) => name in (entry.keyframes[0] ?? {}))

  it('grows a new row in, draws its connector, then fades its content in', () => {
    setup()
    const old = tool('Bash', { command: 'pwd' })
    const fresh = tool('Read', { file_path: 'a.ts' })
    const arrivals = new Map<string, number | null>([
      [`tool-group:${old.id}`, null],
      [old.id, null],
      [fresh.id, 1000],
    ])
    render(<ToolGroup live arrivals={arrivals} item={group([old, fresh])} />)
    // Height: the new row's grid track grows from 0fr, 360ms expo-out.
    const grow = property('gridTemplateRows')
    expect(grow).toHaveLength(1)
    expect(grow[0].delay).toBe(0)
    expect(grow[0].node.textContent).toContain('Read')
    // The trunk of the row above extends, then this row's trunk and branch
    // draw, and the icon and content follow the branch.
    const trunks = property('transform').filter((entry) =>
      String(entry.keyframes[0].transform).startsWith('scaleY'),
    )
    expect(trunks).toHaveLength(2)
    expect(property('strokeDashoffset')).toHaveLength(1)
    const lifted = played.find((entry) =>
      String(entry.keyframes[0].transform).startsWith('translateY'),
    )
    expect(lifted?.keyframes[0]).toMatchObject({
      opacity: 0,
      transform: 'translateY(4px)',
    })
    expect(lifted?.keyframes.at(-1)).toMatchObject({
      opacity: 1,
      transform: 'translateY(0px)',
    })
  })

  it('keeps history and landed rows still', () => {
    setup()
    const first = tool('Bash', { command: 'pwd' })
    const second = tool('Bash', { command: 'ls' })
    const arrivals = new Map<string, number | null>([
      [first.id, null],
      // Arrived a second ago: long landed when this row mounts.
      [second.id, 0],
    ])
    render(<ToolGroup live arrivals={arrivals} item={group([first, second])} />)
    expect(played).toHaveLength(0)
  })

  it('fades a new row in place under reduced motion', () => {
    setup(true)
    const fresh = tool('Bash', { command: 'pwd' })
    const arrivals = new Map<string, number | null>([
      [`tool-group:${fresh.id}`, 1000],
      [fresh.id, 1090],
    ])
    render(<ToolGroup live arrivals={arrivals} item={group([fresh])} />)
    expect(played.length).toBeGreaterThan(0)
    for (const entry of played)
      expect(Object.keys(entry.keyframes[0])).toEqual(['opacity'])
  })
})

describe('AgentToolCard', () => {
  afterEach(cleanup)

  it('opens the child transcript in the dock', () => {
    useShellStore.setState({ docks: {}, dockWidth: 480 })
    const view = render(
      <AgentToolCard
        sessionId="session-1"
        tool={tool(
          'child',
          { description: 'Research the parser' },
          { nativeChildId: 'child-1', state: 'running' },
        )}
      />,
    )
    expect(view.container.textContent).toContain('Research the parser')
    fireEvent.click(
      screen.getByRole('button', { name: 'Open child transcript' }),
    )
    expect(useShellStore.getState().dock('session-1').tabs).toContainEqual(
      expect.objectContaining({
        kind: 'subagent',
        nativeChildId: 'child-1',
        title: 'Research the parser',
      }),
    )
  })
})
