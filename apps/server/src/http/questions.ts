import {
  NativeInteractionError,
  type NativeInteractions,
} from '../sessions/native-interactions.js'
import { Hono } from 'hono'
import { answerQuestion, cancelQuestion } from '@forge/protocol/commands'
import { QuestionError, QuestionManager } from '../acp/questions.js'
export function questionRoutes(
  manager: QuestionManager,
  native?: NativeInteractions,
) {
  const app = new Hono()
  app.get('/api/sessions/:id/questions', (c) =>
    c.json({ questions: manager.listPending(c.req.param('id')) }),
  )
  app.post('/api/sessions/:id/questions/:questionId/answer', async (c) => {
    try {
      const input = await c.req.json()
      const body = answerQuestion.parse({
        ...input,
        sessionId: c.req.param('id'),
        questionId: c.req.param('questionId'),
      })
      return c.json(
        await (native?.owns(body.sessionId, body.questionId)
          ? native.answerQuestion(body.sessionId, body.questionId, body)
          : manager.answerQuestion(body.sessionId, body.questionId, body)),
      )
    } catch (error) {
      if (error instanceof NativeInteractionError)
        return c.json({ error: error.message }, error.status)
      if (error instanceof QuestionError)
        return c.json(
          { error: error.message, answer: error.original },
          error.status,
        )
      return c.json({ error: 'Invalid question answer' }, 400)
    }
  })
  app.post('/api/sessions/:id/questions/:questionId/cancel', async (c) => {
    try {
      const body = cancelQuestion.parse({
        sessionId: c.req.param('id'),
        questionId: c.req.param('questionId'),
      })
      return c.json(
        await (native?.owns(body.sessionId, body.questionId)
          ? native.cancelQuestion(body.sessionId, body.questionId)
          : manager.cancelQuestion(body.sessionId, body.questionId)),
      )
    } catch (error) {
      if (error instanceof NativeInteractionError)
        return c.json({ error: error.message }, error.status)
      if (error instanceof QuestionError)
        return c.json(
          { error: error.message, answer: error.original },
          error.status,
        )
      return c.json({ error: 'Invalid question cancellation' }, 400)
    }
  })
  return app
}
