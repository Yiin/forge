// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureComposerGlide,
  clearComposerGlide,
  peekComposerGlide,
} from './composer-glide'

const hero = () => {
  const root = document.createElement('div')
  root.innerHTML = `
    <div data-glide-ghost><button>Polish project</button></div>
    <div class="chat-composer-glass"></div>
    <div data-glide-ghost>Current checkout</div>`
  const pill = root.querySelector('.chat-composer-glass')!
  pill.getBoundingClientRect = () =>
    ({ left: 100, top: 300, width: 736, height: 120 }) as DOMRect
  return root
}

const input = {
  sessionId: 's-1',
  itemId: 'client_1',
  selection: { harness: 'claude' },
}

describe('composer glide hand-off', () => {
  afterEach(() => {
    vi.useRealTimers()
    const glide = peekComposerGlide('s-1')
    if (glide) clearComposerGlide(glide)
  })

  it('records the hero pill and copies of its chrome for the session', () => {
    const root = hero()
    captureComposerGlide(root, input)
    const glide = peekComposerGlide('s-1')!
    expect(glide.pill).toEqual({ left: 100, top: 300, width: 736, height: 120 })
    expect(glide.itemId).toBe('client_1')
    expect(glide.ghosts.map(({ node }) => node.textContent?.trim())).toEqual([
      'Polish project',
      'Current checkout',
    ])
    // Copies, so the hero can unmount.
    expect(glide.ghosts[0]!.node.isConnected).toBe(false)
    expect(peekComposerGlide('other')).toBeUndefined()
  })

  it('is used once and goes stale', () => {
    captureComposerGlide(hero(), input)
    const glide = peekComposerGlide('s-1')!
    clearComposerGlide(glide)
    expect(peekComposerGlide('s-1')).toBeUndefined()

    vi.useFakeTimers({ toFake: ['performance'] })
    captureComposerGlide(hero(), input)
    vi.advanceTimersByTime(6000)
    expect(peekComposerGlide('s-1')).toBeUndefined()
  })

  it('does nothing without a hero pill', () => {
    captureComposerGlide(document.createElement('div'), input)
    captureComposerGlide(null, input)
    expect(peekComposerGlide('s-1')).toBeUndefined()
  })
})
