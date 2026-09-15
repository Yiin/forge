import { Hono } from 'hono'
import type { DatabaseSync } from 'node:sqlite'

export function acpArtifactRoutes(db: DatabaseSync) {
  const app = new Hono()
  app.get('/api/sessions/:id/acp-artifacts/:artifactId', (c) => {
    const row = db
      .prepare(
        `SELECT a.mime,a.sha256,a.bytes FROM acp_artifacts a
      JOIN sessions s ON s.id=a.session_id LEFT JOIN projects p ON p.id=s.project_id
      WHERE a.artifact_id=? AND a.session_id=? AND s.deleted_at IS NULL
      AND (s.project_id IS NULL OR (p.id IS NOT NULL AND p.deleted_at IS NULL))
      AND length(a.bytes)<=10485760`,
      )
      .get(c.req.param('artifactId'), c.req.param('id')) as
      { mime: string; sha256: string; bytes: Uint8Array } | undefined
    if (!row) return c.json({ error: 'Artifact not found' }, 404)
    const inline =
      /^(image\/(png|jpeg|gif|webp)|audio\/(mpeg|wav|ogg|webm))$/i.test(
        row.mime,
      )
    return new Response(row.bytes as Uint8Array<ArrayBuffer>, {
      headers: {
        'Content-Type': row.mime,
        'Content-Length': String(row.bytes.byteLength),
        'Content-Disposition': inline ? 'inline' : 'attachment',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, no-store',
      },
    })
  })
  return app
}
