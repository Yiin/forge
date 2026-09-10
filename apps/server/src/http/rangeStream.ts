import { createReadStream } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'

export type RangeFile = {
  path: string
  size: number
  mime: string
  filename: string
  etag?: string
  handle?: FileHandle
  cleanup?: () => Promise<void>
  signal?: AbortSignal
  forceDownload?: boolean
}

function disposition(mime: string, filename: string) {
  const inline =
    mime.startsWith('image/') ||
    mime === 'application/pdf' ||
    mime.startsWith('text/')
  const safe = Buffer.from(filename.replace(/[\r\n"]/g, '_')).toString('utf8')
  const ascii = safe.replace(/[^\u0020-\u007e]/g, '_')
  const encoded =
    safe !== ascii ? `; filename*=UTF-8''${encodeURIComponent(safe)}` : ''
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"${encoded}`
}

export function rangeResponse(request: Request, file: RangeFile): Response {
  const etag = file.etag ? `"${file.etag}"` : undefined
  if (etag && request.headers.get('If-None-Match') === etag)
    return new Response(null, { status: 304, headers: { ETag: etag } })
  let start = 0
  let end = file.size - 1
  const range = request.headers.get('Range')
  if (file.size === 0 && !range) {
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Content-Length': '0',
      'Content-Type': file.mime,
      'Content-Disposition': file.forceDownload
        ? disposition('application/octet-stream', file.filename)
        : disposition(file.mime, file.filename),
    })
    if (etag) headers.set('ETag', etag)
    return new Response(null, { status: 200, headers })
  }
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match || file.size === 0)
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${file.size}` },
      })
    if (match[1] === '') {
      const suffix = Number(match[2])
      if (!Number.isSafeInteger(suffix) || suffix <= 0)
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${file.size}` },
        })
      start = Math.max(file.size - suffix, 0)
    } else {
      start = Number(match[1])
      end = match[2] === '' ? file.size - 1 : Number(match[2])
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= file.size
    )
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${file.size}` },
      })
    end = Math.min(end, file.size - 1)
  }
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Content-Length': String(end - start + 1),
    'Content-Type': file.mime,
    'Content-Disposition': file.forceDownload
      ? disposition('application/octet-stream', file.filename)
      : disposition(file.mime, file.filename),
  })
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${file.size}`)
  if (etag) headers.set('ETag', etag)
  if (request.method === 'HEAD')
    return new Response(null, { status: range ? 206 : 200, headers })
  return new Response(
    file.handle
      ? handleStream(file, start, end)
      : (Readable.toWeb(
          createReadStream(file.path, { start, end }),
        ) as ReadableStream),
    {
      status: range ? 206 : 200,
      headers,
    },
  )
}

export async function fileResponse(
  request: Request,
  file: Omit<RangeFile, 'size'> & { size?: number },
) {
  return rangeResponse(request, {
    ...file,
    size: file.size ?? (await stat(file.path)).size,
  })
}

function handleStream(file: RangeFile, start: number, end: number) {
  let position = start
  let closed = false
  let controller: ReadableStreamDefaultController<Uint8Array>
  const close = async () => {
    if (closed) return
    closed = true
    file.signal?.removeEventListener('abort', abort)
    await file.cleanup?.()
  }
  const abort = () => {
    if (!closed) {
      controller.error(new Error('Media stream interrupted'))
      void close()
    }
  }
  return new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
      file.signal?.addEventListener('abort', abort, { once: true })
      if (file.signal?.aborted) abort()
    },
    async pull(value) {
      if (closed) return
      try {
        const buffer = Buffer.alloc(Math.min(64 * 1024, end - position + 1))
        const { bytesRead } = await file.handle!.read(
          buffer,
          0,
          buffer.length,
          position,
        )
        if (closed) return
        if (!bytesRead) {
          await close()
          value.close()
          return
        }
        position += bytesRead
        value.enqueue(buffer.subarray(0, bytesRead))
        if (position > end) {
          await close()
          value.close()
        }
      } catch (error) {
        if (!closed) value.error(error)
        await close()
      }
    },
    cancel: close,
  })
}
