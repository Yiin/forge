import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'

export type RangeFile = {
  path: string
  size: number
  mime: string
  filename: string
  etag?: string
}

function disposition(mime: string, filename: string) {
  const inline =
    mime.startsWith('image/') ||
    mime === 'application/pdf' ||
    mime.startsWith('text/')
  return `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/[\r\n"]/g, '_')}"`
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
      'Content-Disposition': disposition(file.mime, file.filename),
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
    'Content-Disposition': disposition(file.mime, file.filename),
  })
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${file.size}`)
  if (etag) headers.set('ETag', etag)
  if (request.method === 'HEAD')
    return new Response(null, { status: range ? 206 : 200, headers })
  return new Response(
    Readable.toWeb(
      createReadStream(file.path, { start, end }),
    ) as ReadableStream,
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
