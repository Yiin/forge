// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '@forge/protocol/message'
import { AskUserQuestionPanel } from './AskUserQuestionPanel'
import { useMessagesStore } from '../../stores/messages'
import { api } from '../../lib/api'

function seed(content: Message['content']) {
  useMessagesStore.setState({
    bySession: {
      'session-1': [
        {
          seq: 1,
          sessionId: 'session-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          role: 'agent',
          createdAt: 1,
          content,
        },
      ] as never,
    },
  })
}

const options = [
  { kind: 'allow_once', name: 'Allow once', optionId: 'allow-once' },
  { kind: 'reject_once', name: 'Reject once', optionId: 'reject-once' },
]

describe('AskUserQuestionPanel', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useMessagesStore.setState({ bySession: {}, snapshotStateBySession: {} })
  })

  it('never submits a tool permission from the choice alone', () => {
    vi.useFakeTimers()
    const answer = vi.spyOn(api, 'answerQuestion').mockResolvedValue(undefined)
    seed({
      type: 'ask_user_question',
      questionId: 'request-1',
      question: 'Run command',
      questions: [
        {
          question: 'Run command',
          options: options.map((option) => ({
            id: option.optionId,
            label: option.name,
          })),
        },
      ],
      source: 'permission',
      toolName: 'Run command',
      permissionScope: 'once',
    })
    render(<AskUserQuestionPanel sessionId="session-1" />)
    expect(
      screen.getByRole('region', { name: 'Tool permission request' }),
    ).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Allow once/ }))
    vi.advanceTimersByTime(2000)
    expect(answer).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Submit/ }))
    expect(answer).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('treats a question that arrived on the permission method as a question', () => {
    seed({
      type: 'ask_user_question',
      questionId: 'request-2',
      question: 'Pick one',
      questions: [
        {
          question: 'Pick one',
          options: [{ label: 'First' }, { label: 'Second' }],
        },
      ],
      source: 'permission',
    })
    render(<AskUserQuestionPanel sessionId="session-1" />)
    expect(
      screen.getByRole('region', { name: 'Question from Forge' }),
    ).toBeTruthy()
    expect(screen.queryByText(/needs your approval/)).toBeNull()
  })

  it('shows a restart-expired request as settled and disables replies', () => {
    seed({
      type: 'ask_user_question',
      questionId: 'request-expired',
      question: 'Continue?',
      questions: [{ question: 'Continue?', options: [] }],
    })
    useMessagesStore.setState({
      snapshotStateBySession: {
        'session-1': {
          requests: [
            {
              questionId: 'request-expired',
              sessionId: 'session-1',
              questions: [{ question: 'Continue?', options: [] }],
              source: 'ext',
              status: 'expired',
              createdAt: 1,
              updatedAt: 2,
              expiresAt: 3,
            },
          ],
        },
      },
    })
    render(<AskUserQuestionPanel sessionId="session-1" />)
    expect(
      screen.getByText('This request expired after the session ended.'),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Submit/ })).toBeNull()
  })

  // Snapshot rows carry the native-interaction status, whose 'cancelled' member
  // the stored message enum lacks. Every settled status must render its own
  // text, so the panel never shows an empty card with no reply controls.
  it('shows a cancelled request as settled and disables replies', () => {
    seed({
      type: 'ask_user_question',
      questionId: 'request-cancelled',
      question: 'Continue?',
      questions: [{ question: 'Continue?', options: [] }],
    })
    useMessagesStore.setState({
      snapshotStateBySession: {
        'session-1': {
          requests: [
            {
              questionId: 'request-cancelled',
              sessionId: 'session-1',
              questions: [{ question: 'Continue?', options: [] }],
              source: 'ext',
              status: 'cancelled',
              createdAt: 1,
              updatedAt: 2,
              expiresAt: 3,
            },
          ],
        },
      },
    })
    render(<AskUserQuestionPanel sessionId="session-1" />)
    expect(screen.getByText('This request was cancelled.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Submit/ })).toBeNull()
  })
})
