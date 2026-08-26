// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  handleShortcut,
  registerShortcuts,
  resetShortcutRegistry,
  shortcutCommands,
} from './shortcuts'

afterEach(() => resetShortcutRegistry())

describe('shortcut registry', () => {
  it('exposes one accessible command record per registered action', () => {
    const action = vi.fn()
    registerShortcuts({ 'palette.open': action, 'navigate.chat': action })
    expect(shortcutCommands().map((command) => command.id)).toEqual([
      'palette.open',
      'navigate.chat',
    ])
    expect(shortcutCommands()[0]).toMatchObject({
      label: 'Open command palette',
      ariaKeyshortcuts: 'Meta+K',
    })
  })

  it('handles platform modifiers and ignores browser numeric shortcuts', () => {
    const action = vi.fn()
    registerShortcuts({ 'palette.open': action })
    const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })
    handleShortcut(event)
    expect(action).toHaveBeenCalledOnce()
    expect(
      handleShortcut(new KeyboardEvent('keydown', { key: '1', ctrlKey: true })),
    ).toBe(false)
  })

  it('does not act inside editable or composing contexts', () => {
    const action = vi.fn()
    registerShortcuts({ 'palette.open': action })
    const input = document.createElement('input')
    document.body.append(input)
    const inputEvent = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })
    Object.defineProperty(inputEvent, 'target', { value: input })
    const composingEvent = new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
    })
    Object.defineProperty(composingEvent, 'isComposing', { value: true })
    expect(handleShortcut(inputEvent)).toBe(false)
    expect(handleShortcut(composingEvent)).toBe(false)
    expect(action).not.toHaveBeenCalled()
  })
})
