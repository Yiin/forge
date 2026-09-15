import { z } from 'zod'
import {
  questionAnswerSchema,
  type QuestionRequest,
} from '@forge/protocol/harness'
import type { QuestionAnswer } from '../types.js'
import { immutableData } from './data.js'
const text = z.string().max(65536)
const nativeQuestionSchema = z
  .object({
    id: z.string().min(1).max(512).optional(),
    question: text,
    header: text.optional(),
    multiSelect: z.boolean().optional(),
    multi_select: z.boolean().optional(),
    options: z
      .array(
        z.object({
          id: z.string().min(1).max(512).optional(),
          label: text,
          description: text.optional(),
          preview: text.optional(),
        }),
      )
      .max(64),
  })
  .refine(
    (value) =>
      value.multiSelect === undefined ||
      value.multi_select === undefined ||
      value.multiSelect === value.multi_select,
  )
const nativeQuestionsSchema = z.object({
  sessionId: z.string().min(1).max(512),
  toolCallId: z.string().min(1).max(512),
  mode: z.enum(['default', 'plan']),
  questions: z.array(nativeQuestionSchema).min(1).max(16),
})
export function prepareGrokQuestions(requestId: string, input: unknown) {
  const native = nativeQuestionsSchema.parse(immutableData(input, 256 * 1024))
  const request: QuestionRequest = immutableData(
    {
      requestId,
      isBlocking: true,
      questions: native.questions.map((question, index) => ({
        id: question.id ?? `question-${index}`,
        question: question.question,
        ...(question.header === undefined ? {} : { header: question.header }),
        multiSelect: question.multiSelect ?? question.multi_select ?? false,
        allowFreeInput: true,
        options: question.options.map((option, ordinal) => ({
          ...option,
          id: option.id ?? `option-${ordinal}`,
        })),
      })),
    },
    256 * 1024,
  )
  if (
    new Set(request.questions.map((question) => question.id)).size !==
      request.questions.length ||
    new Set(request.questions.map((question) => question.question)).size !==
      request.questions.length
  )
    throw Error('ACP question identities are ambiguous')
  for (const question of request.questions)
    if (
      new Set(question.options.map((option) => option.id)).size !==
        question.options.length ||
      new Set(question.options.map((option) => option.label)).size !==
        question.options.length
    )
      throw Error('ACP option identities are ambiguous')
  return {
    sessionId: native.sessionId,
    toolCallId: native.toolCallId,
    request,
    answer(input: Record<string, QuestionAnswer>) {
      const replies = z
        .record(z.string(), questionAnswerSchema)
        .parse(immutableData(input, 256 * 1024))
      if (
        Object.keys(replies).length !== request.questions.length ||
        Object.keys(replies).some(
          (id) => !request.questions.some((question) => question.id === id),
        )
      )
        throw Error('ACP answers must name every original question')
      const skipped = request.questions.filter(
        (question) => replies[question.id]?.type === 'skipped',
      ).length
      if (skipped === request.questions.length)
        return { outcome: 'cancelled' as const }
      if (skipped) throw Error('ACP partial skipped answers are unsupported')
      const answers: Record<string, string[]> = Object.create(null)
      const annotations: Record<string, { preview?: string; notes?: string }> =
        Object.create(null)
      for (const question of request.questions) {
        const reply = replies[question.id]!
        if (reply.type === 'skipped')
          throw Error('ACP skipped answer is unsupported')
        const ids = reply.type === 'free_text' ? [] : reply.optionIds
        if (
          new Set(ids).size !== ids.length ||
          (!question.multiSelect && ids.length > 1) ||
          ids.some((id) => !question.options.some((option) => option.id === id))
        )
          throw Error('ACP selected options are invalid')
        if (reply.type === 'selected' && !ids.length)
          throw Error('ACP selection is empty')
        const selected = question.options.filter((option) =>
          ids.includes(option.id),
        )
        answers[question.question] =
          reply.type === 'free_text'
            ? ['Other']
            : selected.map((option) => option.label)
        const notes =
          reply.type === 'free_text' || reply.type === 'selected_with_text'
            ? reply.text
            : undefined
        const preview =
          !question.multiSelect && selected.length === 1
            ? selected[0]!.preview
            : undefined
        if (notes !== undefined || preview !== undefined)
          annotations[question.question] = {
            ...(notes === undefined ? {} : { notes }),
            ...(preview === undefined ? {} : { preview }),
          }
      }
      return immutableData(
        {
          outcome: 'accepted' as const,
          answers,
          ...(Object.keys(annotations).length ? { annotations } : {}),
        },
        256 * 1024,
      )
    },
  }
}
