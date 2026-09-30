import { describe, expect, it } from 'vitest'
import { settingsSchema } from '@forge/protocol/config'
import { titleModelFor } from './titles.js'

const settings = settingsSchema.parse({
  titleModel: { harness: 'codex-acp', model: 'small' },
  epicDefaults: {
    rolePolicy: {
      roles: { 'iteration-worker': 'big', 'title-generation': 'fast' },
      tiers: {
        big: [{ harness: 'claude-code-acp', model: 'opus' }],
        fast: [
          { harness: 'kimi' },
          { harness: 'claude-code-acp', model: 'haiku' },
        ],
      },
    },
  },
})

describe('titleModelFor', () => {
  it('uses the forge title model for chat sessions', () => {
    expect(titleModelFor('chat', settings)).toEqual({
      harness: 'codex-acp',
      model: 'small',
    })
  })

  it('falls back to Claude when no title model is set', () => {
    expect(titleModelFor('chat', settingsSchema.parse({}))).toEqual({
      harness: 'claude-code-acp',
    })
  })

  it('uses the first usable epic title-generation hop for epic sessions', () => {
    expect(titleModelFor('epic_worker', settings)).toEqual({
      harness: 'claude-code-acp',
      model: 'haiku',
    })
  })
})
