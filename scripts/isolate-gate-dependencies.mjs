import {
  globSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const inside = (root, path) => {
  const part = relative(root, path)
  return (
    part === '' ||
    (!isAbsolute(part) && part !== '..' && !part.startsWith('../'))
  )
}

function borrowed(root, path, visited) {
  const stat = lstatSync(path)
  let target = path
  if (stat.isSymbolicLink()) {
    try {
      target = realpathSync(path)
      if (!inside(root, target)) return true
    } catch (error) {
      if (error.code === 'ENOENT') return true
      throw error
    }
  }
  if (!(stat.isSymbolicLink() ? statSync(target) : stat).isDirectory())
    return false
  const canonical = realpathSync(target)
  if (visited.has(canonical)) return false
  visited.add(canonical)
  return readdirSync(target, { withFileTypes: true }).some(
    (entry) =>
      (entry.isDirectory() || entry.isSymbolicLink()) &&
      borrowed(root, join(target, entry.name), visited),
  )
}

export function isolateGateDependencies(checkout) {
  const root = realpathSync(checkout)
  const scratch = join(root, '.native-build')
  mkdirSync(scratch, { recursive: true })
  if (!inside(root, realpathSync(scratch)))
    throw Error('Gate scratch resolves outside the checkout')
  const cache = join(scratch, 'bun-cache')
  mkdirSync(cache, { recursive: true })
  if (!inside(root, realpathSync(cache)))
    throw Error('Gate cache resolves outside the checkout')
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const workspaces = globSync(manifest.workspaces, { cwd: root })
  const directories = [...new Set(['.', ...workspaces])]
    .map((workspace) => {
      const directory = realpathSync(resolve(root, workspace))
      if (!inside(root, directory))
        throw Error('Gate workspace resolves outside the checkout')
      return join(directory, 'node_modules')
    })
    .filter((path) => {
      try {
        lstatSync(path)
        return true
      } catch (error) {
        if (error.code === 'ENOENT') return false
        throw error
      }
    })
  const visited = new Set()
  if (!directories.some((path) => borrowed(root, path, visited))) return null
  const backup = mkdtempSync(join(scratch, 'dependencies-'))
  for (const directory of directories) {
    const target = join(backup, relative(root, directory))
    mkdirSync(dirname(target), { recursive: true })
    renameSync(directory, target)
  }
  return backup
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const backup = isolateGateDependencies(
    resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  )
  if (backup) console.log(`Preserved borrowed gate dependencies at ${backup}`)
}
