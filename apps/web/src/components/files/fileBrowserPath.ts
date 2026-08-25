export function cleanSplat(splat: string | undefined) {
  return (splat ?? '').replace(/^\/+|\/+$/g, '')
}

export function pathToSplat(path: string | undefined) {
  return cleanSplat(path)
}

export function filePathUrl(projectId: string, path = '') {
  const splat = pathToSplat(path)
  return `/files/${encodeURIComponent(projectId)}${splat ? `/${splat}` : ''}`
}

export function ancestorPaths(path: string) {
  const parts = cleanSplat(path).split('/').filter(Boolean)
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}

export function pathsToExpand(path: string) {
  return ancestorPaths(path).slice(0, -1)
}

export function parentPath(path: string) {
  const parts = cleanSplat(path).split('/').filter(Boolean)
  return parts.slice(0, -1).join('/')
}
