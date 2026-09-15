// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeContentRow } from './NativeContentRow'
import { useShellStore } from '../../stores/shell'

const content = [
  { type: 'content_block', block: { kind: 'text_resource', text: 'source' } },
  { type: 'source_reference', subject: { kind: 'item', itemId: 'item-1' } },
  { type: 'usage', totalTokens: 12 },
  { type: 'usage_snapshot', measurementId: 'measurement-1' },
  { type: 'file_change', kind: 'modified', path: 'src/main.ts' },
  { type: 'child_updated', childId: 'child-1' },
] as const

describe('NativeContentRow', () => {
  afterEach(cleanup)

  it.each(content)('renders %s content in the transcript', (value) => {
    const view = render(
      <NativeContentRow
        item={{ kind: 'native', id: value.type, content: value }}
      />,
    )
    expect(
      view.container.querySelector(`[data-native-type="${value.type}"]`),
    ).not.toBeNull()
    expect(view.container.textContent).toContain(
      value.type === 'file_change'
        ? 'src/main.ts'
        : value.type === 'usage'
          ? '12 tokens'
          : value.type === 'usage_snapshot'
            ? 'measurement-1'
            : value.type === 'child_updated'
              ? 'child-1'
              : value.type === 'source_reference'
                ? 'item'
                : 'text_resource',
    )
  })

  it('keeps raw native details collapsed until requested', () => {
    render(
      <NativeContentRow
        item={{ kind: 'native', id: 'file', content: content[4] }}
      />,
    )
    expect(screen.queryByText(/"path": "src\/main.ts"/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /file change/i }))
    expect(screen.getAllByText('modified src/main.ts')).toHaveLength(2)
  })

  it('opens file changes and child transcripts in the dock', () => {
    useShellStore.setState({ docks: {}, dockWidth: 480 })
    const view = render(
      <NativeContentRow
        sessionId="session-1"
        item={{ kind: 'native', id: 'file', content: content[4] }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /file change/i }))
    fireEvent.click(
      screen.getAllByRole('button', { name: /^open src\/main\.ts$/i })[0]!,
    )
    expect(useShellStore.getState().dock('session-1').tabs).toContainEqual(
      expect.objectContaining({ kind: 'file', path: 'src/main.ts' }),
    )
    view.unmount()
  })
})
