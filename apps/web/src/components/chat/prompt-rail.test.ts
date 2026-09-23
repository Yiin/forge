import { describe, expect, it } from 'vitest'
import type { ChatRenderItem } from './render-model'
import {
  activePrompt,
  cubicBezier,
  easeInOut,
  previewText,
  railBuckets,
  railCapacity,
  railPrompts,
  showRail,
} from './prompt-rail'

const text = (
  id: string,
  role: 'user' | 'agent',
  value: string,
  extra: Partial<Extract<ChatRenderItem, { kind: 'message' }>> = {},
): ChatRenderItem => ({
  kind: 'message',
  id,
  seq: 1,
  role,
  text: value,
  ...extra,
})

describe('prompt rail', () => {
  it('takes one tick per prompt with the opening of its reply', () => {
    const prompts = railPrompts([
      text('u1', 'user', 'First'),
      text('t1', 'agent', 'thinking', { thought: true }),
      text('a1', 'agent', '  '),
      text('a2', 'agent', 'Reply one'),
      text('a3', 'agent', 'Reply two'),
      text('u2', 'user', 'Second'),
      text('u3', 'user', 'Pending', { pending: true }),
    ])
    expect(prompts).toEqual([
      { index: 0, text: 'First', reply: 'Reply one' },
      { index: 5, text: 'Second' },
      { index: 6, text: 'Pending' },
    ])
  })

  it('shows only on a 768px column with two or more prompts', () => {
    expect(showRail(778, 2)).toBe(true)
    expect(showRail(777, 2)).toBe(false)
    expect(showRail(1200, 1)).toBe(false)
  })

  it('fits at most 12 ticks and at least one', () => {
    expect(railCapacity(900)).toBe(12)
    expect(railCapacity(600)).toBe(12)
    expect(railCapacity(100)).toBe(4)
    expect(railCapacity(10)).toBe(1)
  })

  it('buckets prompts evenly past the cap', () => {
    expect(railBuckets(3, 12)).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ])
    const buckets = railBuckets(30, 12)
    expect(buckets).toHaveLength(12)
    expect(buckets[0]).toEqual({ start: 0, end: 2 })
    expect(buckets.at(-1)).toEqual({ start: 27, end: 30 })
    expect(buckets.reduce((sum, b) => sum + b.end - b.start, 0)).toBe(30)
  })

  it('lights the last prompt above the reading line', () => {
    expect(activePrompt([0, 400, 900], 10.5)).toBe(0)
    expect(activePrompt([100, 400, 900], 10.5)).toBe(0)
    expect(activePrompt([0, 400, 900], 410.5)).toBe(1)
    expect(activePrompt([0, 400, 900], 5000)).toBe(2)
  })

  it('collapses whitespace and cuts previews with an ellipsis', () => {
    expect(previewText('a\n\n  b', 10)).toBe('a b')
    expect(previewText('abcdefghij', 5)).toBe('abcd…')
    expect(previewText('abc   defgh', 5)).toBe('abc…')
  })

  it('eases the glide like the CSS curve', () => {
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(1)).toBe(1)
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 5)
    // The first 16ms frame of a 500ms glide moves less than 2%.
    expect(easeInOut(16 / 500)).toBeLessThan(0.02)
    expect(cubicBezier(0, 0, 1, 1)(0.3)).toBeCloseTo(0.3, 5)
  })
})
