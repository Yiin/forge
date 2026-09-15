import { describe, expect, it } from 'vitest'
import { prepareGrokQuestions } from './questions.js'
const input = {
  sessionId: 'native',
  toolCallId: 'tool',
  mode: 'default',
  questions: [
    {
      question: 'Which cache?',
      options: [
        { label: 'Redis', description: 'Shared', preview: '<config>' },
        { id: 'local', label: 'Local' },
      ],
    },
  ],
}
describe('Grok original question schema', () => {
  it('keeps labels, previews and stable ordinal IDs within the original request', () => {
    const prepared = prepareGrokQuestions('request', input)
    expect(prepared.request.questions[0]!.id).toBe('question-0')
    expect(
      prepared.answer({
        'question-0': { type: 'selected', optionIds: ['option-0'] },
      }),
    ).toEqual({
      outcome: 'accepted',
      answers: { 'Which cache?': ['Redis'] },
      annotations: { 'Which cache?': { preview: '<config>' } },
    })
    expect(
      prepared.answer({ 'question-0': { type: 'free_text', text: 'Custom' } }),
    ).toEqual({
      outcome: 'accepted',
      answers: { 'Which cache?': ['Other'] },
      annotations: { 'Which cache?': { notes: 'Custom' } },
    })
    expect(
      prepared.answer({
        'question-0': {
          type: 'selected_with_text',
          optionIds: ['local'],
          text: 'For tests',
        },
      }),
    ).toEqual({
      outcome: 'accepted',
      answers: { 'Which cache?': ['Local'] },
      annotations: { 'Which cache?': { notes: 'For tests' } },
    })
    expect(prepared.answer({ 'question-0': { type: 'skipped' } })).toEqual({
      outcome: 'cancelled',
    })
  })
  it('validates aliases and preserves offered order for multi-select labels', () => {
    const question = { ...input.questions[0]!, multi_select: true }
    const prepared = prepareGrokQuestions('request', {
      ...input,
      questions: [question],
    })
    expect(
      prepared.answer({
        'question-0': { type: 'selected', optionIds: ['local', 'option-0'] },
      }),
    ).toEqual({
      outcome: 'accepted',
      answers: { 'Which cache?': ['Redis', 'Local'] },
    })
    expect(() =>
      prepareGrokQuestions('request', {
        ...input,
        questions: [{ ...question, multiSelect: false }],
      }),
    ).toThrow()
  })
  it('rejects ambiguous questions and invalid replies without changing the original mapping', () => {
    expect(() =>
      prepareGrokQuestions('request', {
        ...input,
        questions: [input.questions[0], input.questions[0]],
      }),
    ).toThrow('ambiguous')
    const prepared = prepareGrokQuestions('request', input)
    for (const optionIds of [
      ['missing'],
      ['local', 'local'],
      ['local', 'option-0'],
      [],
    ])
      expect(() =>
        prepared.answer({ 'question-0': { type: 'selected', optionIds } }),
      ).toThrow()
    expect(() => prepared.answer({ foreign: { type: 'skipped' } })).toThrow()
    expect(
      prepared.answer({
        'question-0': { type: 'selected', optionIds: ['local'] },
      }),
    ).toEqual({ outcome: 'accepted', answers: { 'Which cache?': ['Local'] } })
  })
  it('rejects partial skipped groups and does not run accessors during capture', () => {
    const prepared = prepareGrokQuestions('request', {
      ...input,
      questions: [...input.questions, { question: 'Proceed?', options: [] }],
    })
    expect(() =>
      prepared.answer({
        'question-0': { type: 'skipped' },
        'question-1': { type: 'free_text', text: 'Yes' },
      }),
    ).toThrow('partial')
    let reads = 0
    const reply = Object.defineProperty({}, 'question-0', {
      get() {
        reads++
        return { type: 'skipped' }
      },
    })
    expect(() => prepared.answer(reply)).toThrow('accessors')
    expect(reads).toBe(0)
  })
})
