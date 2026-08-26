import { describe, expect, it } from 'vitest'
import {
  detectComposerTrigger,
  replaceComposerTrigger,
} from './composer-triggers'

describe('composer triggers', () => {
  it('finds a slash command at the line start, including a mid-token cursor', () => {
    expect(detectComposerTrigger('hello\n/pla now', 10)).toEqual({
      kind: 'slash-command',
      query: 'pla',
      rangeStart: 6,
      rangeEnd: 10,
    })
  })
  it('ignores slash commands away from the line start and skills inside words', () => {
    expect(detectComposerTrigger('say /help', 9)).toBeNull()
    expect(detectComposerTrigger('word$skill', 10)).toBeNull()
  })
  it('detects paths and replaces only the trigger range', () => {
    const trigger = detectComposerTrigger('open @src/app.ts please', 16)
    expect(trigger).toEqual({
      kind: 'path',
      query: 'src/app.ts',
      rangeStart: 5,
      rangeEnd: 16,
    })
    expect(
      replaceComposerTrigger(
        'open @src/app.ts please',
        trigger!,
        'src/main.ts',
      ),
    ).toEqual({ text: 'open src/main.ts please', cursor: 16 })
  })
})
