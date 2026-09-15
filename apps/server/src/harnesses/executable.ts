import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

export async function resolveExecutable(launch: {
  command: string
  env: Readonly<Record<string, string | undefined>>
}): Promise<string | null> {
  const candidates =
    isAbsolute(launch.command) || launch.command.includes('/')
      ? [launch.command]
      : (launch.env.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .slice(0, 128)
          .map((path) => join(path, launch.command))
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK)
      if ((await stat(path)).isFile()) return await realpath(path)
    } catch (error) {
      if (
        !['ENOENT', 'ENOTDIR', 'EACCES'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error
    }
  }
  return null
}
