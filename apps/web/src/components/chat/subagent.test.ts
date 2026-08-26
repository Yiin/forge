import { describe, expect, it } from 'vitest'
import type { Message } from '@forge/protocol/message'
import {
  deriveSubagentStatus,
  elapsedSeconds,
  placeSubagents,
} from './subagent'

const message = (type: Message['content']['type'], seq: number): Message => ({
  seq,
  sessionId: 'child',
  turnId: 'turn',
  itemId: `item-${seq}`,
  role: type === 'turn_start' ? 'user' : 'agent',
  type,
  content:
    type === 'turn_start'
      ? { type }
      : type === 'turn_end'
        ? { type }
        : { type: 'turn_interrupted' },
  createdAt: 'now',
})

describe('subagent display model', () => {
  it('derives running, settled, interrupted, and unknown states', () => {
    expect(deriveSubagentStatus([message('turn_start', 1)])).toBe('running')
    expect(deriveSubagentStatus([message('turn_end', 2)])).toBe('done')
    expect(deriveSubagentStatus([message('turn_interrupted', 3)])).toBe(
      'interrupted',
    )
    expect(deriveSubagentStatus([])).toBe('unknown')
    expect(
      elapsedSeconds(
        [
          {
            ...message('turn_start', 1),
            createdAt: '2020-01-01T00:00:00.000Z',
          },
        ],
        Date.parse('2020-01-01T00:00:12.000Z'),
      ),
    ).toBe(12)
  })

  it('places a child card after its spawn anchor', () => {
    const child = { id: 'child', title: 'Research', spawnedBySeq: 7 }
    expect(
      placeSubagents(
        [
          { id: 'before', seq: 6 },
          { id: 'spawn', seq: 7 },
        ],
        [child],
      ),
    ).toEqual([
      { id: 'before', seq: 6 },
      { id: 'spawn', seq: 7 },
      { kind: 'subagent', id: 'subagent-child', child },
    ])
  })

  it('places each child card once when anchors resolve the spawn seq', () => {
    const child = { id: 'child', title: 'Research', spawnedBySeq: 7 }
    expect(
      placeSubagents(
        [{ id: 'item-a' }, { id: 'item-b' }],
        [child],
        new Map([['item-a', 7]]),
      ),
    ).toEqual([
      { id: 'item-a' },
      { kind: 'subagent', id: 'subagent-child', child },
      { id: 'item-b' },
    ])
  })

  it('places concurrent children at the same spawn anchor', () => {
    const children = [
      { id: 'child-a', title: 'Research', spawnedBySeq: 7 },
      { id: 'child-b', title: 'Review', spawnedBySeq: 7 },
    ]
    expect(placeSubagents([{ id: 'spawn', seq: 7 }], children)).toEqual([
      { id: 'spawn', seq: 7 },
      { kind: 'subagent', id: 'subagent-child-a', child: children[0] },
      { kind: 'subagent', id: 'subagent-child-b', child: children[1] },
    ])
  })
})
