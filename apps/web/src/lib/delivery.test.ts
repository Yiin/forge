import { describe, expect, it } from 'vitest'
import type { ReviewNote } from '@forge/protocol/review'
import type { PendingUserMessage } from '../stores/messages'
import {
  carriedNoteIds,
  connectionNotice,
  isOffline,
  sendFailure,
} from './delivery'

describe('delivery', () => {
  it('counts only a dropped connection as offline', () => {
    expect(isOffline('connecting')).toBe(false)
    expect(isOffline('connected')).toBe(false)
    expect(isOffline('reconnecting')).toBe(true)
    expect(isOffline('error')).toBe(true)
    expect(isOffline('disconnected')).toBe(true)
  })

  it('words the composer caption after zeron, without dashes', () => {
    expect(connectionNotice('connected', true)).toBeUndefined()
    expect(connectionNotice('connecting', false)).toBeUndefined()
    expect(connectionNotice('reconnecting', true)).toEqual({
      text: 'Messages will send once the connection recovers.',
      offline: false,
    })
    expect(connectionNotice('reconnecting', false)).toEqual({
      text: "Offline, messages will send when you're back online.",
      offline: true,
    })
  })

  it('tells a request that got no answer from a refusal', () => {
    expect(sendFailure(new TypeError('Failed to fetch'))).toBe('unsent')
    expect(
      sendFailure(new Error('Forge API request failed (503): refused')),
    ).toBe('refused')
    expect(sendFailure('odd')).toBe('refused')
  })

  it('names the notes that a prompt on its way already carries', () => {
    const note = (id: string) => ({ id }) as ReviewNote
    const pending = (
      status: PendingUserMessage['status'],
      notes: ReviewNote[],
    ): PendingUserMessage => ({
      sessionId: 's',
      itemId: `client_${status}`,
      text: 'hi',
      createdAt: 'now',
      status,
      prompt: { sessionId: 's', text: 'hi', reviewReferences: notes },
    })
    expect(
      carriedNoteIds([
        pending('sending', [note('a')]),
        pending('unsent', [note('b')]),
        pending('accepted', [note('c')]),
      ]),
    ).toEqual(new Set(['a', 'b']))
  })
})
