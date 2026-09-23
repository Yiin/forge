import { describe, expect, it } from 'vitest'
import type { ChatRenderItem } from './render-model'
import {
  arrivalDelay,
  connectorContinuation,
  connectorFrames,
  connectorParts,
  noteArrivals,
  type Arrivals,
} from './tool-reveal'
import { easeOutQuint } from './motion'

const group = (id: string, entries: string[]): ChatRenderItem => ({
  kind: 'tool-group',
  id,
  entries: entries.map((entry) => ({
    kind: 'tool',
    id: entry,
    name: 'Bash',
    state: 'done',
    input: {},
  })),
})

describe('tool row arrival', () => {
  it('waits 90ms for a new group, then staggers rows by 65ms', () => {
    expect(arrivalDelay(0, true)).toBe(90)
    expect(arrivalDelay(2, true)).toBe(220)
    expect(arrivalDelay(0, false)).toBe(0)
    expect(arrivalDelay(1, false)).toBe(65)
  })

  it('treats what the transcript opened with as history', () => {
    const arrivals: Arrivals = new Map()
    noteArrivals(arrivals, [group('g', ['a', 'b'])], 1000, false)
    expect(arrivals.get('g')).toBeNull()
    expect(arrivals.get('a')).toBeNull()
    // Later rows of that group arrive with no header wait.
    noteArrivals(arrivals, [group('g', ['a', 'b', 'c', 'd'])], 2000, true)
    expect(arrivals.get('b')).toBeNull()
    expect(arrivals.get('c')).toBe(2000)
    expect(arrivals.get('d')).toBe(2065)
  })

  it('reveals a new group header at once and its first rows after it', () => {
    const arrivals: Arrivals = new Map()
    noteArrivals(arrivals, [group('g', ['a', 'b'])], 500, true)
    expect(arrivals.get('g')).toBe(500)
    expect(arrivals.get('a')).toBe(590)
    expect(arrivals.get('b')).toBe(655)
    // Seeing the same rows again changes nothing.
    noteArrivals(arrivals, [group('g', ['a', 'b'])], 900, true)
    expect(arrivals.get('a')).toBe(590)
  })

  it('draws the trunk, then the branch, overlapping at the bend', () => {
    expect(connectorParts(0, false)).toEqual({ incoming: 0, branch: 0 })
    expect(connectorParts(0.31, false).incoming).toBeCloseTo(0.5, 6)
    expect(connectorParts(0.6, false).branch).toBeGreaterThan(0)
    expect(connectorParts(0.6, false).incoming).toBeLessThan(1)
    // With a row above, the trunk waits for the row above to extend.
    expect(connectorParts(0.4, true).incoming).toBe(0)
    expect(connectorParts(0.72, true).incoming).toBe(1)
    expect(connectorParts(1, true)).toEqual({ incoming: 1, branch: 1 })
    expect(connectorContinuation(0.225)).toBeCloseTo(0.5, 6)
    expect(connectorContinuation(0.5)).toBe(1)
  })

  it('samples the quint-out draw evenly in time', () => {
    const frames = connectorFrames((progress) => progress, 4)
    expect(frames.map((frame) => frame.offset)).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(frames[2].value).toBeCloseTo(easeOutQuint(0.5), 6)
    expect(frames.at(-1)!.value).toBe(1)
  })
})
