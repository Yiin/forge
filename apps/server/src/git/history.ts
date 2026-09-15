import { createHash } from 'node:crypto'
import { runGit } from './exec.js'
import type { GitHistoryPage } from '@forge/protocol/git'

const LIMIT = 100
export async function gitHistory(input: {
  cwd: string
  cursor?: string
  limit?: number
}): Promise<GitHistoryPage> {
  const limit = Math.min(LIMIT, Math.max(1, input.limit ?? 50))
  const revision =
    (
      await runGit(input.cwd, ['rev-parse', '--verify', 'HEAD'], false, {
        readOnly: true,
        maxOutputBytes: 64 * 1024,
      })
    ).stdout.trim() || 'unborn'
  const offset = input.cursor ? Number.parseInt(input.cursor, 10) : 0
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error('Invalid history cursor')
  const result = await runGit(
    input.cwd,
    [
      'log',
      '--all',
      '--date=iso-strict',
      `--format=%H%x00%P%x00%D%x00%an%x00%aI%x00%s%x00`,
      `--skip=${offset}`,
      `--max-count=${limit + 1}`,
      '--',
    ],
    false,
    { readOnly: true, maxOutputBytes: 2 * 1024 * 1024 },
  )
  const fields = result.stdout.split('\0')
  const commits = []
  for (let index = 0; index + 5 < fields.length; index += 6) {
    if (!fields[index]) continue
    commits.push({
      sha: fields[index]!,
      parents: fields[index + 1]!.trim()
        ? fields[index + 1]!.trim().split(/\s+/)
        : [],
      refs: fields[index + 2]!.split(',')
        .map((ref) => ref.trim())
        .filter(Boolean),
      author: fields[index + 3]!,
      date: fields[index + 4]!,
      subject: fields[index + 5]!,
    })
  }
  const hasNext = commits.length > limit
  if (hasNext) commits.length = limit
  return {
    commits,
    nextCursor: hasNext ? String(offset + limit) : null,
    revision: createHash('sha256')
      .update(`${revision}:${offset}:${limit}`)
      .digest('hex'),
  }
}
