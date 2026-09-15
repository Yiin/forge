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
    const inspect = async (
      mode: 'metadata' | 'read' | 'verify',
      revision?: string,
    ) => {
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
          if (mode === 'metadata')
            return { revision: current, bytes: undefined }
          if (mode === 'read' && row.size_bytes > MAX_INLINE_IMAGE_BYTES)
            throw Error('Native attachment read exceeds inline limit')
          const bytes = Buffer.alloc(
            mode === 'read'
              ? row.size_bytes + 1
              : Math.min(row.size_bytes + 1, 65536),
          )
          const hash = createHash('sha256')
          let offset = 0
          while (offset <= row.size_bytes) {
            signal.throwIfAborted()
            const result = await handle.read(
              bytes,
              mode === 'read' ? offset : 0,
              Math.min(
                mode === 'read' ? bytes.length - offset : bytes.length,
                row.size_bytes + 1 - offset,
              ),
              offset,
            )
            if (!result.bytesRead) break
            hash.update(
              bytes.subarray(
                mode === 'read' ? offset : 0,
                (mode === 'read' ? offset : 0) + result.bytesRead,
              ),
            )
            offset += result.bytesRead
          }
          await chain.verify()
          verifyRow()
          if (
            offset !== row.size_bytes ||
            fileRevision(await handle.stat({ bigint: true })) !== current ||
            hash.digest('hex') !== row.sha256
          )
            throw Error('Native attachment contents changed')
          return {
            revision: current,
            bytes: mode === 'read' ? bytes.subarray(0, offset) : undefined,
          }
        } finally {
          await handle.close()
        }
      } finally {
        await chain.close()
      }
    }
    const captured = await inspect('metadata')
    return {
      mime: row.mime,
      name: row.filename,
      path: join(root, row.rel_path),
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
      readBytes: async () => (await inspect('read', captured.revision)).bytes!,
      verifyBytes: async () => {
        await inspect('verify', captured.revision)
      },
    }
  }
}
