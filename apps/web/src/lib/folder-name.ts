export function folderName(path: string) {
  const trimmed = path.replace(/\/+$/, '')
  if (!trimmed) return '/'
  return trimmed.split('/').pop() ?? '/'
}
