import { expect, it } from 'vitest'
import { MessageContent, messageContentTypes } from '../src/message.js'
it('preserves durable snapshot content and exact child metadata', () => {
  const snapshot = {
    type: 'content_snapshot',
    contentType: 'thought',
    text: 'corrected',
    childId: 'child',
    itemId: 'item',
    turnId: 'turn',
  }
  expect(MessageContent.parse(snapshot)).toEqual(snapshot)
  expect(messageContentTypes).toContain('content_snapshot')
  expect(
    MessageContent.safeParse({
      ...snapshot,
      text: 'x'.repeat(4 * 1024 * 1024 + 1),
    }).success,
  ).toBe(false)
  expect(
    MessageContent.parse({
      type: 'tool_update',
      toolCallId: 'call',
      status: 'running',
      childId: 'child',
      nativeChildId: 'subject',
    }),
  ).toMatchObject({ childId: 'child', nativeChildId: 'subject' })
})
