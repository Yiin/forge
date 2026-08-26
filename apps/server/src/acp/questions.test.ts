import { describe, expect, it } from 'vitest'
import * as acp from '@zed-industries/agent-client-protocol'
import { classifyQuestion, isUserQuestion } from './questions.js'

const permission = (rawInput: unknown, title?: string) =>
  ({
    sessionId: 'session-1',
    toolCall: { toolCallId: 'tool-1', title, rawInput },
    options: [{ kind: 'allow_once', name: 'Allow', optionId: 'allow' }],
  }) as acp.RequestPermissionRequest

describe('ACP user question classification', () => {
  it('classifies AskUserQuestion permission payloads', () => {
    expect(
      isUserQuestion(
        permission({
          questions: [{ question: 'Pick', options: [{ label: 'One' }] }],
        }),
      ),
    ).toBe(true)
    expect(
      isUserQuestion(permission({ command: 'echo hi' }, 'Run command')),
    ).toBe(false)
    expect(isUserQuestion(permission({}, 'AskUserQuestion'))).toBe(true)
  })

  it('normalizes Cursor and x.ai extension variants', () => {
    const cursor = classifyQuestion('cursor/ask_question', {
      sessionId: 'session-1',
      toolCallId: 'cursor-tool',
      questions: [
        {
          prompt: 'Scope?',
          options: [{ id: 'workspace', label: 'Workspace' }],
        },
      ],
    })
    expect(cursor?.questions[0]).toEqual({
      question: 'Scope?',
      options: [{ label: 'Workspace', id: 'workspace' }],
    })
    const xai = classifyQuestion('_x.ai/ask_user_question', {
      params: {
        sessionId: 'session-1',
        toolCallId: 'xai-tool',
        questions: [
          {
            question: 'Scope?',
            options: [{ label: 'Workspace', description: 'Current workspace' }],
          },
        ],
      },
    })
    expect(xai?.questionId).toBe('xai-tool')
    expect(xai?.questions[0].options[0].description).toBe('Current workspace')
  })
})
