const imageExtensions = new Set([
  'avif',
  'gif',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'webp',
])
const videoExtensions = new Set(['m4v', 'mov', 'mp4', 'webm', 'ogv'])
const audioExtensions = new Set([
  'aac',
  'flac',
  'm4a',
  'mp3',
  'ogg',
  'wav',
  'webm',
])

export type FileViewerKind =
  'image' | 'pdf' | 'text' | 'video' | 'audio' | 'download'

function extension(filename: string) {
  return filename.toLowerCase().split('.').pop() ?? ''
}

export function fileViewerKind(filename: string, mime: string): FileViewerKind {
  const normalizedMime = mime.toLowerCase().split(';', 1)[0]
  const ext = extension(filename)

  if (normalizedMime === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (normalizedMime.startsWith('image/') || imageExtensions.has(ext))
    return 'image'
  if (normalizedMime.startsWith('video/') || videoExtensions.has(ext))
    return 'video'
  if (normalizedMime.startsWith('audio/') || audioExtensions.has(ext))
    return 'audio'
  if (
    normalizedMime.startsWith('text/') ||
    normalizedMime.includes('json') ||
    normalizedMime.includes('javascript') ||
    normalizedMime.includes('typescript') ||
    /\.(c|cpp|css|go|h|java|js|jsx|md|py|rb|rs|sh|sql|tsx|ts|vue|xml|yaml|yml)$/.test(
      filename.toLowerCase(),
    )
  )
    return 'text'
  return 'download'
}

export function languageForFilename(filename: string) {
  const ext = extension(filename)
  const aliases: Record<string, string> = {
    c: 'c',
    cpp: 'cpp',
    css: 'css',
    go: 'go',
    html: 'html',
    java: 'java',
    js: 'javascript',
    json: 'json',
    md: 'markdown',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    sh: 'shellscript',
    sql: 'sql',
    ts: 'typescript',
    tsx: 'tsx',
    vue: 'vue',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
  }
  return aliases[ext] ?? 'text'
}
