import { Hono } from 'hono'
import { answerQuestion, cancelQuestion } from '@forge/protocol/commands'
import { QuestionError, QuestionManager } from '../acp/questions.js'
export function questionRoutes(manager: QuestionManager) {
  const app = new Hono()
  app.post('/api/sessions/:id/questions/:questionId/answer', async (c) => {
    try {
      const input = await c.req.json()
      const body = answerQuestion.parse({
        sessionId: c.req.param('id'),
        questionId: c.req.param('questionId'),
        ...input,
      })
      return c.json(
        manager.answerQuestion(body.sessionId, body.questionId, body),
      )
    } catch (error) {
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
      return c.json(manager.cancelQuestion(body.sessionId, body.questionId))
    } catch (error) {
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
