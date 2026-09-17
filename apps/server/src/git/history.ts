import { runGit } from './exec.js'
import type { GitHistoryPage } from '@forge/protocol/git'

export async function gitHistory(input: {
  cwd: string
  cursor?: string
  limit?: number
  ref?: string
  query?: string
}): Promise<GitHistoryPage> {
  const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 50)))
  if (!Number.isSafeInteger(limit)) throw Error('Invalid history page size')
  const ref = input.ref?.trim() || 'HEAD',
    query = input.query?.trim() || ''
  if (ref.length > 256 || query.length > 256 || ref.startsWith('-'))
    throw Error('Invalid history filter')
  let tip: string,
    offset = 0
  if (input.cursor) {
    if (input.cursor.length > 2048) throw Error('Invalid history cursor')
    let cursor
    try {
      cursor = JSON.parse(
        Buffer.from(input.cursor, 'base64url').toString('utf8'),
      )
    } catch {
      throw Error('Invalid history cursor')
    }
    if (
      cursor?.version !== 1 ||
      !/^[a-f0-9]{40,64}$/.test(cursor.tip) ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0 ||
      cursor.offset > 100000 ||
      cursor.ref !== ref ||
      cursor.query !== query
    )
      throw Error('History filters changed; refresh history')
    tip = cursor.tip
    offset = cursor.offset
  } else {
    const resolved = await runGit(
      input.cwd,
      ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      false,
      { readOnly: true, maxOutputBytes: 64 * 1024 },
    )
    tip = resolved.stdout.trim()
    if (!tip && ref === 'HEAD')
      return { commits: [], nextCursor: null, revision: 'unborn' }
    if (!/^[a-f0-9]{40,64}$/.test(tip))
      throw Error('History ref is unavailable')
  }
  const result = await runGit(
    input.cwd,
    [
      'log',
      '--topo-order',
      '--date=iso-strict',
      '--decorate=full',
      '--format=%H%x00%P%x00%D%x00%an%x00%aI%x00%s%x00',
      `--skip=${offset}`,
      `--max-count=${limit + 1}`,
      ...(query
        ? ['--fixed-strings', '--regexp-ignore-case', `--grep=${query}`]
        : []),
      tip,
      '--',
    ],
    true,
    { readOnly: true, maxOutputBytes: 2 * 1024 * 1024 },
  )
  const fields = result.stdout.split('\0'),
    commits = []
  for (let index = 0; index + 5 < fields.length; index += 6) {
    const sha = fields[index]!.trim()
    if (!sha) continue
    commits.push({
      sha,
      parents: fields[index + 1]!.trim().split(/\s+/).filter(Boolean),
      refs: fields[index + 2]!.split(',')
        .map((ref) => ref.trim())
        .filter(Boolean),
      author: fields[index + 3]!,
      date: fields[index + 4]!,
      subject: fields[index + 5]!,
    })
  }
  const more = commits.length > limit
  if (more) commits.length = limit
  return {
    commits,
    revision: tip,
    nextCursor: more
      ? Buffer.from(
          JSON.stringify({
            version: 1,
            tip,
            offset: offset + limit,
            ref,
            query,
          }),
        ).toString('base64url')
      : null,
  }
}
