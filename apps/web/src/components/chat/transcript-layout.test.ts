import { describe, expect, it } from 'vitest'
import type { ChatRenderItem } from './render-model'
import {
  flavourWord,
  FLAVOUR_WORDS,
  fnv1a,
  formatElapsed,
  formatTimestamp,
  rowGap,
  rowMeta,
  sendingBridge,
} from './transcript-layout'

const user = (id: string, value = 'prompt'): ChatRenderItem => ({
  kind: 'message',
  id,
  seq: 1,
  role: 'user',
  text: value,
})
const reply = (id: string, value = 'reply'): ChatRenderItem => ({
  kind: 'message',
  id,
  seq: 1,
  role: 'agent',
  text: value,
})
const group = (id: string): ChatRenderItem => ({
  kind: 'tool-group',
  id,
  entries: [],
})
const attachment = (id: string): ChatRenderItem => ({
  kind: 'attachment',
  id,
  filename: 'a.png',
  path: 'a.png',
})
const working: ChatRenderItem = { kind: 'working', id: 'working' }

describe('transcript layout', () => {
  it('spaces rows with zeron gaps', () => {
    expect(rowGap(undefined, user('u'))).toBe(26)
    expect(rowGap(user('u'), reply('a'))).toBe(16)
    expect(rowGap(reply('a'), user('u'))).toBe(16)
    expect(rowGap(reply('a'), group('g'))).toBe(12)
    expect(rowGap(group('g'), reply('a'))).toBe(12)
    expect(rowGap(reply('a'), reply('b'))).toBe(12)
    expect(rowGap(attachment('f'), user('u'))).toBe(4)
    expect(rowGap(reply('a'), working)).toBe(16)
    expect(
      rowGap(reply('a'), { kind: 'system', id: 's', text: 'x', alert: true }),
    ).toBe(8)
  })

  it('puts one lane on the last reply of a settled entry', () => {
    const items = [
      user('u1'),
      reply('a1', 'one'),
      group('g1'),
      reply('a2', 'two'),
      user('u2'),
      reply('a3', 'three'),
    ]
    const meta = rowMeta(items, false)
    expect(meta.map((row) => row.lane?.copyText)).toEqual([
      undefined,
      undefined,
      undefined,
      'one\n\ntwo',
      undefined,
      'three',
    ])
    expect(meta.every((row) => !row.streaming)).toBe(true)
  })

  it('holds the lane back and streams the tail while running', () => {
    const items = [user('u1'), reply('a1'), user('u2'), reply('a2'), working]
    const meta = rowMeta(items, true)
    expect(meta[1].lane?.copyText).toBe('reply')
    expect(meta[3].lane).toBeUndefined()
    expect(meta[3].streaming).toBe(true)
  })

  it('keeps the previous entry settled before the new reply starts', () => {
    const meta = rowMeta([user('u1'), reply('a1'), user('u2'), working], true)
    expect(meta[1].lane?.copyText).toBe('reply')
  })

  it('does not stream text that a tool group follows', () => {
    const meta = rowMeta([user('u1'), reply('a1'), group('g1'), working], true)
    expect(meta[1].streaming).toBe(false)
    expect(meta[1].lane).toBeUndefined()
  })

  it('rotates the flavour word every 7 seconds from a per-chat seed', () => {
    const seed = fnv1a('session-1')
    expect(seed).toBe(fnv1a('session-1'))
    expect(seed).not.toBe(fnv1a('session-2'))
    expect(flavourWord(0, 0)).toBe(FLAVOUR_WORDS[0])
    expect(flavourWord(0, 6.9)).toBe(FLAVOUR_WORDS[0])
    expect(flavourWord(0, 7)).toBe(FLAVOUR_WORDS[1])
    expect(flavourWord(20, 7)).toBe(FLAVOUR_WORDS[0])
  })

  it('formats elapsed time with two units at most', () => {
    expect(formatElapsed(12)).toBe('12s')
    expect(formatElapsed(184)).toBe('3m 4s')
    expect(formatElapsed(7500)).toBe('2h 5m')
    expect(formatElapsed(97_200)).toBe('1d 3h')
    expect(formatElapsed(-3)).toBe('0s')
  })

  it('formats lane timestamps like zeron', () => {
    expect(formatTimestamp('2026-07-01T15:45:00')).toBe('Jul 1, 3:45 PM')
    expect(formatTimestamp(undefined)).toBeUndefined()
    expect(formatTimestamp('not a date')).toBeUndefined()
  })

  it('bridges a send until a newer turn starts', () => {
    const send = '2026-07-01T10:00:05Z'
    expect(sendingBridge(undefined, undefined)).toBe(false)
    expect(sendingBridge(send, undefined)).toBe(true)
    expect(sendingBridge(send, '2026-07-01T10:00:00Z')).toBe(true)
    expect(sendingBridge(send, '2026-07-01T10:00:06Z')).toBe(false)
  })
})
