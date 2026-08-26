import { createHash } from 'node:crypto'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { EventBus } from '../events/bus.js'

export const MAX_UPLOAD_BYTES = 1024 ** 3
const SAFE_FILENAME_LIMIT = 120

type UploadRow = {
  id: string
  session_id: string | null
  draft_id?: string | null
  project_id?: string | null
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
  const base = filename
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
  return base.replace(/^-+|-+$/g, '').slice(0, SAFE_FILENAME_LIMIT) || 'file'
}

function newId() {
  const time = Date.now().toString(36).padStart(9, '0')
  const random = crypto.getRandomValues(new Uint8Array(10))
  return `att_${time}${Array.from(random, (byte) =>
    byte.toString(36).padStart(2, '0'),
  )
    .join('')
    .slice(0, 16)}`
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
        id TEXT PRIMARY KEY, session_id TEXT, filename TEXT NOT NULL,
        mime TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT,
        rel_path TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL, item_id TEXT NOT NULL, role TEXT NOT NULL,
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

  get dataDir() {
    return this.options.dataDir
  }

  get database() {
    return this.db
  }

  init(
    sessionId: string,
    input: { filename: string; mime: string; sizeBytes: number },
  ) {
    if (input.sizeBytes > MAX_UPLOAD_BYTES)
      throw new RangeError('Upload exceeds 1 GiB')
    const session = this.db
      .prepare('SELECT project_id FROM sessions WHERE id = ?')
      .get(sessionId) as { project_id: string } | undefined
    if (!session) throw new Error('Session not found')
    const id = newId()
    this.db
      .prepare(
        'INSERT INTO attachments (id, session_id, filename, mime, size_bytes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        sessionId,
        input.filename,
        input.mime,
        input.sizeBytes,
        'pending',
        this.now(),
      )
    return { attachmentId: id, putUrl: `/api/uploads/${id}` }
  }

  initDraft(draftId: string, projectId: string, input: { filename: string; mime: string; sizeBytes: number }) {
    if (input.sizeBytes > MAX_UPLOAD_BYTES) throw new RangeError('Upload exceeds 1 GiB')
    const project = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)
    if (!project) throw new Error('Project not found')
    const id = newId()
    this.db.prepare(
      'INSERT INTO attachments (id, session_id, draft_id, project_id, filename, mime, size_bytes, status, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, draftId, projectId, input.filename, input.mime, input.sizeBytes, 'pending', this.now())
    return { attachmentId: id, putUrl: `/api/uploads/${id}` }
  }

  async put(attachmentId: string, body: ReadableStream<Uint8Array> | null) {
    if (!body) throw new Error('Upload body is required')
    const row = this.db
      .prepare('SELECT * FROM attachments WHERE id = ?')
      .get(attachmentId) as UploadRow | undefined
    if (!row) throw new Error('Attachment not found')
    const session = this.db
      .prepare('SELECT project_id FROM sessions WHERE id = ?')
      .get(row.session_id) as { project_id: string } | undefined
    const projectId = session?.project_id ?? row.project_id
    if (!projectId) throw new Error('Session not found')
    const ownerId = row.session_id ?? row.draft_id
    if (!ownerId) throw new Error('Attachment owner not found')
    const safeName = `${attachmentId}-${toSafeFilename(row.filename)}`
    const relPath = join(
      'projects',
      projectId,
      'sessions',
      ownerId,
      'files',
      safeName,
    )
    const absolutePath = join(this.options.dataDir, relPath)
    await mkdir(join(absolutePath, '..'), { recursive: true })
    const output = createWriteStream(absolutePath, { flags: 'wx' })
    const hash = createHash('sha256')
    let received = 0
    let lastProgress = 0
    try {
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        received += chunk.byteLength
        if (received > MAX_UPLOAD_BYTES)
          throw new RangeError('Upload exceeds 1 GiB')
        hash.update(chunk)
        if (!output.write(chunk))
          await new Promise<void>((resolve, reject) => {
            output.once('drain', resolve)
            output.once('error', reject)
          })
        const now = this.now()
        if (now - lastProgress >= 500) {
          lastProgress = now
          this.bus.publish({
            seq: null,
            type: 'uploadProgress',
            attachmentId,
            sessionId: row.session_id ?? row.draft_id!,
            bytesReceived: received,
            sizeBytes: row.size_bytes,
          })
        }
      }
      await new Promise<void>((resolve, reject) => {
        output.end(() => resolve())
        output.once('error', reject)
      })
      const sha256 = hash.digest('hex')
      const message = this.db.prepare(
        `INSERT INTO messages
          (session_id, turn_id, item_id, role, type, content, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      this.db.exec('BEGIN')
      let result: { lastInsertRowid: number | bigint }
      try {
        result = row.session_id
          ? message.run(row.session_id, attachmentId, attachmentId, 'user', 'attachment_ref', JSON.stringify({ attachmentId, relPath, filename: row.filename, mime: row.mime, sizeBytes: received, sha256 }), this.now())
          : { lastInsertRowid: 0 }
        this.db
          .prepare(
            'UPDATE attachments SET status = ?, sha256 = ?, rel_path = ?, size_bytes = ? WHERE id = ?',
          )
          .run('complete', sha256, relPath, received, attachmentId)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
      return {
        seq: Number(result.lastInsertRowid),
        relPath,
        sha256,
        sizeBytes: received,
      }
    } catch (error) {
      output.destroy()
      await rm(absolutePath, { force: true })
      this.db
        .prepare('UPDATE attachments SET status = ? WHERE id = ?')
        .run('failed', attachmentId)
      throw error
    }
  }

  async sweep() {
    const cutoff = this.now() - 24 * 60 * 60 * 1000
    const rows = this.db
      .prepare('SELECT * FROM attachments WHERE status = ? AND created_at < ?')
      .all('pending', cutoff) as UploadRow[]
    for (const row of rows) {
      const session = this.db
        .prepare('SELECT project_id FROM sessions WHERE id = ?')
        .get(row.session_id) as { project_id: string } | undefined
      if (session) {
        const file = `${row.id}-${toSafeFilename(row.filename)}`
        await rm(
          join(
            this.options.dataDir,
            'projects',
            session.project_id,
            'sessions',
            row.session_id ?? row.draft_id ?? '',
            'files',
            file,
          ),
          { force: true },
        )
      }
      this.db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id)
    }
    const complete = this.db
      .prepare("SELECT * FROM attachments WHERE status = 'complete'")
      .all() as UploadRow[]
    for (const row of complete) {
      if (!row.rel_path || !(await this.exists(row))) {
        this.db
          .prepare("UPDATE attachments SET status = 'failed' WHERE id = ?")
          .run(row.id)
        console.warn(`Attachment file missing: ${row.id}`)
      }
    }
    await this.removeOrphans()
    return rows.length
  }

  private async exists(row: UploadRow) {
    try {
      await stat(join(this.options.dataDir, this.resolvePath(row)))
      return true
    } catch {
      return false
    }
  }

  private async removeOrphans() {
    const known = new Set(
      (
        this.db
          .prepare('SELECT * FROM attachments WHERE rel_path IS NOT NULL')
          .all() as UploadRow[]
      ).map((row) => this.resolvePath(row)),
    )
    const projectsRoot = join(this.options.dataDir, 'projects')
    let projects: string[]
    try {
      projects = await readdir(projectsRoot)
    } catch {
      return
    }
    for (const project of projects) {
      const sessionsRoot = join(projectsRoot, project, 'sessions')
      let sessions: string[]
      try {
        sessions = await readdir(sessionsRoot)
      } catch {
        continue
      }
      for (const session of sessions) {
        const filesRoot = join(sessionsRoot, session, 'files')
        let files: string[]
        try {
          files = await readdir(filesRoot)
        } catch {
          continue
        }
        for (const file of files) {
          const relPath = join(
            'projects',
            project,
            'sessions',
            session,
            'files',
            file,
          )
          if (!known.has(relPath))
            await rm(join(this.options.dataDir, relPath), { force: true })
        }
      }
    }
  }

  private resolvePath(row: UploadRow) {
    if (row.rel_path!.startsWith('projects/')) return row.rel_path!
    const session = row.session_id
      ? (this.db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(row.session_id) as { project_id: string } | undefined)
      : undefined
    return join(
      'projects',
      session?.project_id ?? row.project_id ?? '',
      'sessions',
      row.session_id ?? row.draft_id ?? '',
      'files',
      row.rel_path!,
    )
  }

  async promoteDraft(draftId: string, sessionId: string, projectId: string) {
    const rows = this.db.prepare("SELECT * FROM attachments WHERE draft_id = ? AND status = 'complete'").all(draftId) as UploadRow[]
    for (const row of rows) {
      const oldPath = row.rel_path ? join(this.options.dataDir, row.rel_path) : null
      const filename = `${row.id}-${toSafeFilename(row.filename)}`
      const relPath = join('projects', projectId, 'sessions', sessionId, 'files', filename)
      if (oldPath) {
        await mkdir(join(this.options.dataDir, relPath, '..'), { recursive: true })
        await (await import('node:fs/promises')).rename(oldPath, join(this.options.dataDir, relPath))
      }
      this.db.prepare('UPDATE attachments SET session_id = ?, draft_id = NULL, project_id = ?, rel_path = ? WHERE id = ?').run(sessionId, projectId, relPath, row.id)
    }
    return rows.map((row) => row.id)
  }

  async rollbackPromotion(draftId: string, sessionId: string, projectId: string) {
    const rows = this.db.prepare('SELECT * FROM attachments WHERE session_id = ?').all(sessionId) as UploadRow[]
    for (const row of rows) {
      const oldPath = row.rel_path ? join(this.options.dataDir, row.rel_path) : null
      const relPath = join('projects', projectId, 'sessions', draftId, 'files', `${row.id}-${toSafeFilename(row.filename)}`)
      if (oldPath) {
        await mkdir(join(this.options.dataDir, relPath, '..'), { recursive: true })
        await (await import('node:fs/promises')).rename(oldPath, join(this.options.dataDir, relPath))
      }
      this.db.prepare('UPDATE attachments SET session_id = NULL, draft_id = ?, rel_path = ?, project_id = ? WHERE id = ?').run(draftId, relPath, projectId, row.id)
    }
  }

  async deleteSession(id: string) {
    const session = this.db
      .prepare('SELECT project_id FROM sessions WHERE id = ?')
      .get(id) as { project_id: string } | undefined
    if (!session) return false
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM attachments WHERE session_id = ?').run(id)
      this.db
        .prepare('UPDATE sessions SET deleted_at = ?, status = ? WHERE id = ?')
        .run(this.now(), 'archived', id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    await rm(
      join(
        this.options.dataDir,
        'projects',
        session.project_id,
        'sessions',
        id,
      ),
      {
        recursive: true,
        force: true,
      },
    )
    return true
  }

  async deleteProject(id: string) {
    const project = this.db
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get(id) as { id: string } | undefined
    if (!project) return false
    const sessions = this.db
      .prepare('SELECT id FROM sessions WHERE project_id = ?')
      .all(id) as Array<{ id: string }>
    for (const session of sessions) await this.deleteSession(session.id)
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    await rm(join(this.options.dataDir, 'projects', id), {
      recursive: true,
      force: true,
    })
    return true
  }

  usage(projectId: string) {
    return this.db
      .prepare(
        `
      SELECT COALESCE(SUM(a.size_bytes), 0) AS attachmentBytes,
             COUNT(a.id) AS attachmentCount
      FROM attachments a JOIN sessions s ON s.id = a.session_id
      WHERE s.project_id = ? AND a.status = 'complete'
    `,
      )
      .get(projectId) as { attachmentBytes: number; attachmentCount: number }
  }

  attachment(id: string) {
    return this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as
      UploadRow | undefined
  }

  async fileSize(path: string) {
    return (await stat(join(this.options.dataDir, path))).size
  }
}
