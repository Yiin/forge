import type { DatabaseSync } from 'node:sqlite'
import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { WorkspacePath, identity, fileRevision } from '../workspace/paths.js'
import { MAX_INLINE_IMAGE_BYTES } from './store.js'

type Row = {
  id: string
  filename: string
  mime: string
  size_bytes: number
  sha256: string
  rel_path: string
}

/** Resolves completed uploads through their original session and descriptor path. */
export function createNativeAttachmentLoader(
  db: DatabaseSync,
  dataDir: string,
) {
  const query = db.prepare(`
    SELECT a.id,a.filename,a.mime,a.size_bytes,a.sha256,a.rel_path
    FROM attachments a JOIN sessions s ON s.id=a.session_id
    LEFT JOIN projects p ON p.id=s.project_id
    WHERE a.id=? AND a.session_id=? AND a.status='complete'
      AND s.deleted_at IS NULL
      AND (s.project_id IS NULL OR (p.id IS NOT NULL AND p.deleted_at IS NULL))
  `)
  return async (
    sessionId: string,
    attachmentId: string,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted()
    const row = query.get(attachmentId, sessionId) as Row | undefined
    if (
      !row ||
      !row.rel_path ||
      !row.filename ||
      !row.mime ||
      !Number.isSafeInteger(row.size_bytes) ||
      row.size_bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(row.sha256 ?? '')
    )
      throw Error('Native attachment is unavailable for this session')
    const snapshot = JSON.stringify(row)
    const root = await realpath(dataDir)
    const rootIdentity = identity(await lstat(root, { bigint: true }))
    const verifyRow = () => {
      signal.throwIfAborted()
      if (JSON.stringify(query.get(attachmentId, sessionId)) !== snapshot)
        throw Error('Native attachment ownership changed')
    }
    const inspect = async (read: boolean, revision?: string) => {
      verifyRow()
      const chain = await WorkspacePath.open(
        root,
        rootIdentity,
        row.rel_path,
        false,
        signal,
      )
      try {
        const { handle, info } = await chain.openFile()
        try {
          verifyRow()
          const current = fileRevision(info)
          if (
            info.size !== BigInt(row.size_bytes) ||
            (revision && current !== revision)
          )
            throw Error('Native attachment file changed')
          if (!read) return { revision: current, bytes: undefined }
          if (row.size_bytes > MAX_INLINE_IMAGE_BYTES)
            throw Error('Native attachment read exceeds inline limit')
          const bytes = Buffer.alloc(row.size_bytes + 1)
          let offset = 0
          while (offset < bytes.length) {
            signal.throwIfAborted()
            const result = await handle.read(
              bytes,
              offset,
              bytes.length - offset,
              offset,
            )
            if (!result.bytesRead) break
            offset += result.bytesRead
          }
          await chain.verify()
          verifyRow()
          if (
            offset !== row.size_bytes ||
            fileRevision(await handle.stat({ bigint: true })) !== current ||
            createHash('sha256')
              .update(bytes.subarray(0, offset))
              .digest('hex') !== row.sha256
          )
            throw Error('Native attachment contents changed')
          return { revision: current, bytes: bytes.subarray(0, offset) }
        } finally {
          await handle.close()
        }
      } finally {
        await chain.close()
      }
    }
    const captured = await inspect(false)
    return {
      mime: row.mime,
      name: row.filename,
      path: join(root, row.rel_path),
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
      readBytes: async () => (await inspect(true, captured.revision)).bytes!,
    }
  }
}
