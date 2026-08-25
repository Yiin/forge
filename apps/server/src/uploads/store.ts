import { createHash } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { EventBus } from '../events/bus.js'

export const MAX_UPLOAD_BYTES = 1024 ** 3
const SAFE_FILENAME_LIMIT = 120

type UploadRow = {
  id: string
  session_id: string
  filename: string
  mime: string
  size_bytes: number
  sha256: string | null
  rel_path: string | null
  status: 'pending' | 'complete' | 'failed'
  created_at: number
}

export type UploadStoreOptions = {
  dataDir: string
  bus?: EventBus
  now?: () => number
}

export function toSafeFilename(filename: string) {
  const base = filename.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
  return (base.replace(/^-+|-+$/g, '').slice(0, SAFE_FILENAME_LIMIT) || 'file')
}

function newId() {
  const time = Date.now().toString(36).padStart(9, '0')
  const random = crypto.getRandomValues(new Uint8Array(10))
  return `att_${time}${Array.from(random, (byte) => byte.toString(36).padStart(2, '0')).join('').slice(0, 16)}`
}

export class UploadStore {
  private readonly bus: EventBus
  private readonly now: () => number
  private readonly sweeper: ReturnType<typeof setInterval>

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: UploadStoreOptions,
  ) {
    this.bus = options.bus ?? new EventBus()
    this.now = options.now ?? Date.now
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, filename TEXT NOT NULL,
        mime TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT,
        rel_path TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        type TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `)
    this.sweeper = setInterval(() => void this.sweep(), 10 * 60 * 1000)
    this.sweeper.unref()
  }

  close() {
    clearInterval(this.sweeper)
  }

  get eventBus() {
    return this.bus
  }

  init(sessionId: string, input: { filename: string; mime: string; sizeBytes: number }) {
    if (input.sizeBytes > MAX_UPLOAD_BYTES) throw new RangeError('Upload exceeds 1 GiB')
    const session = this.db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId) as
      | { project_id: string }
      | undefined
    if (!session) throw new Error('Session not found')
    const id = newId()
    this.db.prepare(
      'INSERT INTO attachments (id, session_id, filename, mime, size_bytes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, sessionId, input.filename, input.mime, input.sizeBytes, 'pending', this.now())
    return { attachmentId: id, putUrl: `/api/uploads/${id}` }
  }

  async put(attachmentId: string, body: ReadableStream<Uint8Array> | null) {
    if (!body) throw new Error('Upload body is required')
    const row = this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(attachmentId) as UploadRow | undefined
    if (!row) throw new Error('Attachment not found')
    const session = this.db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(row.session_id) as
      | { project_id: string }
      | undefined
    if (!session) throw new Error('Session not found')
    const safeName = `${attachmentId}-${toSafeFilename(row.filename)}`
    const relPath = join('projects', session.project_id, 'sessions', row.session_id, 'files', safeName)
    const absolutePath = join(this.options.dataDir, relPath)
    await mkdir(join(absolutePath, '..'), { recursive: true })
    const output = createWriteStream(absolutePath, { flags: 'wx' })
    const hash = createHash('sha256')
    let received = 0
    let lastProgress = 0
    try {
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        received += chunk.byteLength
        if (received > MAX_UPLOAD_BYTES) throw new RangeError('Upload exceeds 1 GiB')
        hash.update(chunk)
        if (!output.write(chunk)) await new Promise<void>((resolve, reject) => {
          output.once('drain', resolve)
          output.once('error', reject)
        })
        const now = this.now()
        if (now - lastProgress >= 500) {
          lastProgress = now
          this.bus.publish({ seq: null, type: 'uploadProgress', attachmentId, sessionId: row.session_id, bytesReceived: received, sizeBytes: row.size_bytes })
        }
      }
      await new Promise<void>((resolve, reject) => {
        output.end(() => resolve())
        output.once('error', reject)
      })
      const sha256 = hash.digest('hex')
      const message = this.db.prepare(
        'INSERT INTO messages (session_id, type, content, created_at) VALUES (?, ?, ?, ?)',
      )
      this.db.exec('BEGIN')
      let result: { lastInsertRowid: number | bigint }
      try {
        result = message.run(
          row.session_id,
          'attachment_ref',
          JSON.stringify({
            attachmentId,
            relPath,
            filename: row.filename,
            mime: row.mime,
            sizeBytes: received,
            sha256,
          }),
          this.now(),
        )
        this.db
          .prepare('UPDATE attachments SET status = ?, sha256 = ?, rel_path = ?, size_bytes = ? WHERE id = ?')
          .run('complete', sha256, relPath, received, attachmentId)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
      return { seq: Number(result.lastInsertRowid), relPath, sha256, sizeBytes: received }
    } catch (error) {
      output.destroy()
      await rm(absolutePath, { force: true })
      this.db.prepare('UPDATE attachments SET status = ? WHERE id = ?').run('failed', attachmentId)
      throw error
    }
  }

  async sweep() {
    const cutoff = this.now() - 24 * 60 * 60 * 1000
    const rows = this.db.prepare('SELECT * FROM attachments WHERE status = ? AND created_at < ?').all('pending', cutoff) as UploadRow[]
    for (const row of rows) {
      const session = this.db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(row.session_id) as { project_id: string } | undefined
      if (session) {
        const file = `${row.id}-${toSafeFilename(row.filename)}`
        await rm(join(this.options.dataDir, 'projects', session.project_id, 'sessions', row.session_id, 'files', file), { force: true })
      }
      this.db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id)
    }
    return rows.length
  }

  attachment(id: string) {
    return this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as UploadRow | undefined
  }

  async fileSize(path: string) {
    return (await stat(join(this.options.dataDir, path))).size
  }
}
