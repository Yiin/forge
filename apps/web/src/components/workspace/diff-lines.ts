import type { GitDiffFile } from '@forge/protocol/git'
type Line = GitDiffFile['hunks'][number]['lines'][number]
/** Match each contiguous deletion/addition block; never pair across context. */
export function splitDiffLines(
  lines: Line[],
): Array<[Line | undefined, Line | undefined]> {
  const rows: Array<[Line | undefined, Line | undefined]> = []
  let old: Line[] = [],
    next: Line[] = []
  const flush = () => {
    for (let i = 0; i < Math.max(old.length, next.length); i++)
      rows.push([old[i], next[i]])
    old = []
    next = []
  }
  for (const line of lines) {
    if (line.type === 'context') {
      flush()
      rows.push([line, line])
    } else if (line.type === 'deletion') {
      if (next.length) flush()
      old.push(line)
    } else if (line.type === 'addition') next.push(line)
    else {
      flush()
      rows.push([line, undefined])
    }
  }
  flush()
  return rows
}
