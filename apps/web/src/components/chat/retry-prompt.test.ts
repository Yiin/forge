import { describe, expect, it } from 'vitest'
import type { Message } from '@forge/protocol/message'
import { serializeReviewNotes, type ReviewNote } from '@forge/protocol/review'
import { lastPrompt } from './retry-prompt'

const message = (
  content: Message['content'],
  overrides: Partial<Message> = {},
): Message => ({
  seq: 1,
  sessionId: 's',
  turnId: 't',
  itemId: 'i',
  role: 'user',
  createdAt: 'now',
  type: content.type,
  content,
  ...overrides,
})

const note: ReviewNote = {
  id: 'note-1',
  body: 'Rename this',
  anchor: {
    workspaceId: 'w',
    workspaceRevision: 1,
    revision: { kind: 'git', scope: 'working', revision: 'HEAD' },
    oldPath: null,
    newPath: 'src/a.ts',
    side: 'new',
    line: 3,
  },
}

const attachment = (attachmentId: string, turnId: string) =>
  message(
    {
      type: 'attachment_ref',
      attachmentId,
      path: `/tmp/${attachmentId}`,
      filename: `${attachmentId}.png`,
    },
    { turnId },
  )

const turnStart = (turnId: string) =>
  message({ type: 'turn_start' }, { turnId })

describe('lastPrompt', () => {
  it('returns the plain text of the last prompt', () => {
    expect(
      lastPrompt([
        turnStart('t1'),
        message({ type: 'text_delta', text: 'first' }, { turnId: 't1' }),
        message(
          { type: 'text_delta', text: 'reply' },
          { role: 'agent', turnId: 't1' },
        ),
        turnStart('t2'),
        message({ type: 'text_delta', text: 'second' }, { turnId: 't2' }),
      ]),
    ).toEqual({ text: 'second', reviewReferences: [], attachmentIds: [] })
  })

  it('strips serialized review notes and returns them', () => {
    expect(
      lastPrompt([
        turnStart('t'),
        message({
          type: 'text_delta',
          text: `fix it${serializeReviewNotes([note])}`,
          reviewReferences: [note],
        }),
      ]),
    ).toEqual({ text: 'fix it', reviewReferences: [note], attachmentIds: [] })
  })

  it('keeps only the attachments of the same turn', () => {
    expect(
      lastPrompt([
        turnStart('t1'),
        attachment('a1', 't1'),
        message({ type: 'text_delta', text: 'old' }, { turnId: 't1' }),
        turnStart('t2'),
        attachment('a2', 't2'),
        attachment('a3', 't2'),
        message({ type: 'text_delta', text: 'new' }, { turnId: 't2' }),
      ])?.attachmentIds,
    ).toEqual(['a2', 'a3'])
  })

  it('retries an attachment-only prompt', () => {
    expect(
      lastPrompt([
        turnStart('t1'),
        message({ type: 'text_delta', text: 'old' }, { turnId: 't1' }),
        turnStart('t2'),
        attachment('a1', 't2'),
      ]),
    ).toEqual({ text: '', reviewReferences: [], attachmentIds: ['a1'] })
  })

  it('skips steers written into the turn', () => {
    expect(
      lastPrompt([
        turnStart('t1'),
        attachment('a1', 't1'),
        message({ type: 'text_delta', text: 'mine' }, { turnId: 't1' }),
        message(
          { type: 'text_delta', text: 'steer', steeringRequestId: 'r1' },
          { turnId: 't1' },
        ),
        attachment('a2', 't1'),
      ]),
    ).toEqual({ text: 'mine', reviewReferences: [], attachmentIds: ['a1'] })
  })

  it('skips a steer after an attachment-only prompt', () => {
    expect(
      lastPrompt([
        turnStart('t1'),
        attachment('a1', 't1'),
        message(
          { type: 'text_delta', text: 'steer', steeringRequestId: 'r1' },
          { turnId: 't1' },
        ),
        attachment('a2', 't1'),
      ]),
    ).toEqual({ text: '', reviewReferences: [], attachmentIds: ['a1'] })
  })

  it('ignores child agent prompts', () => {
    expect(
      lastPrompt([
        turnStart('t'),
        message({ type: 'text_delta', text: 'child', childId: 'c1' }),
        message({ type: 'text_delta', text: 'mine' }),
      ])?.text,
    ).toBe('mine')
  })

  it('returns undefined without a prompt', () => {
    expect(
      lastPrompt([
        message({ type: 'text_delta', text: 'hi' }, { role: 'agent' }),
      ]),
    ).toBeUndefined()
  })
})
