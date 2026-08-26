import { Hono } from 'hono'
import { uploadInitSchema } from '@forge/protocol/commands'
import { UploadStore } from '../uploads/store.js'

export function uploadRoutes(store: UploadStore) {
  const app = new Hono()
  app.post('/api/drafts/:id/uploads', async (c) => {
    const input = uploadInitSchema.parse(await c.req.json())
    try {
      const projectId = c.req.header('X-Project-Id')
      if (!projectId) return c.json({ error: 'X-Project-Id is required' }, 400)
      return c.json(store.initDraft(c.req.param('id'), projectId, input), 201)
    } catch (error) {
      if (error instanceof RangeError) return c.json({ error: error.message }, 413)
      if (error instanceof Error && error.message === 'Project not found')
        return c.json({ error: error.message }, 404)
      throw error
    }
  })
  app.post('/api/sessions/:id/uploads', async (c) => {
    const input = uploadInitSchema.parse(await c.req.json())
    try {
      return c.json(store.init(c.req.param('id'), input), 201)
    } catch (error) {
      if (error instanceof RangeError)
        return c.json({ error: error.message }, 413)
      if (error instanceof Error && error.message === 'Session not found')
        return c.json({ error: error.message }, 404)
      throw error
    }
  })
  app.put('/api/uploads/:id', async (c) => {
    try {
      const result = await store.put(c.req.param('id'), c.req.raw.body)
      return c.json(result)
    } catch (error) {
      if (error instanceof RangeError)
        return c.json({ error: error.message }, 413)
      if (error instanceof Error && /not found|required/.test(error.message))
        return c.json({ error: error.message }, 404)
      throw error
    }
  })
  return app
}
