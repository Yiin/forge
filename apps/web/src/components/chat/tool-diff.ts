/**
 * Inline diffs for file-edit tools. A tool either hands over a unified diff
 * (Codex, some ACP agents) or the old and new text (Claude Edit, ACP diff
 * content); both become the same rows. Old/new snippets carry no file line
 * numbers, so their rows leave the number gutters out instead of guessing.
 */

export type DiffRow =
  | { type: 'hunk'; text: string }
  | {
      type: 'add' | 'del' | 'ctx'
      text: string
      oldLine?: number
      newLine?: number
    }

export type FileDiff = {
  path?: string
  notices: string[]
  rows: DiffRow[]
  numbered: boolean
  /** Total row count before the cap, when rows were cut. */
  truncatedFrom?: number
}

export const DIFF_MAX_LINES = 600
const CONTEXT = 3
/** Above this many cells the LCS table costs too much; show a plain swap. */
const LCS_CELL_LIMIT = 4_000_000

function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

type Op = {
  type: 'add' | 'del' | 'ctx'
  text: string
  old: number
  new: number
}

function lineOps(before: string[], after: string[]): Op[] {
  const ops: Op[] = []
  if (before.length * after.length > LCS_CELL_LIMIT) {
    before.forEach((text, index) =>
      ops.push({ type: 'del', text, old: index + 1, new: 0 }),
    )
    after.forEach((text, index) =>
      ops.push({ type: 'add', text, old: 0, new: index + 1 }),
    )
    return ops
  }
  const rows = before.length
  const cols = after.length
  const table = new Uint32Array((rows + 1) * (cols + 1))
  for (let i = rows - 1; i >= 0; i--)
    for (let j = cols - 1; j >= 0; j--)
      table[i * (cols + 1) + j] =
        before[i] === after[j]
          ? table[(i + 1) * (cols + 1) + j + 1] + 1
          : Math.max(
              table[(i + 1) * (cols + 1) + j],
              table[i * (cols + 1) + j + 1],
            )
  let i = 0
  let j = 0
  while (i < rows || j < cols) {
    if (i < rows && j < cols && before[i] === after[j]) {
      ops.push({ type: 'ctx', text: before[i], old: i + 1, new: j + 1 })
      i++
      j++
    } else if (
      i < rows &&
      (j >= cols ||
        table[(i + 1) * (cols + 1) + j] >= table[i * (cols + 1) + j + 1])
    ) {
      ops.push({ type: 'del', text: before[i], old: i + 1, new: j })
      i++
    } else {
      ops.push({ type: 'add', text: after[j], old: i, new: j + 1 })
      j++
    }
  }
  return ops
}

/** Unified rows with three context lines around each change. */
export function diffTexts(
  before: string | undefined,
  after: string,
  path?: string,
): FileDiff {
  const notices = before === undefined ? ['New file'] : []
  const ops = lineOps(splitLines(before ?? ''), splitLines(after))
  const keep = ops.map(() => false)
  ops.forEach((op, index) => {
    if (op.type === 'ctx') return
    for (
      let near = Math.max(0, index - CONTEXT);
      near <= Math.min(ops.length - 1, index + CONTEXT);
      near++
    )
      keep[near] = true
  })
  const rows: DiffRow[] = []
  ops.forEach((op, index) => {
    if (!keep[index]) return
    if (index > 0 && !keep[index - 1] && rows.length)
      rows.push({ type: 'hunk', text: '⋯' })
    rows.push({ type: op.type, text: op.text })
  })
  return cap({ path, notices, rows, numbered: false })
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** Parses one or more files of `diff --git` or bare `@@` unified diff text. */
export function parseUnifiedDiff(text: string, path?: string): FileDiff[] {
  const files: FileDiff[] = []
  let file: FileDiff | undefined
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  const start = (next?: string) => {
    file = { path: next, notices: [], rows: [], numbered: true }
    files.push(file)
    inHunk = false
  }
  for (const line of splitLines(text)) {
    const git = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (git) {
      start(git[2])
      continue
    }
    if (!file) start(path)
    const current = file!
    if (!inHunk || !/^[ +\-\\]/.test(line) || line.startsWith('@@')) {
      const hunk = HUNK.exec(line)
      if (hunk) {
        oldLine = Number(hunk[1])
        newLine = Number(hunk[2])
        inHunk = true
        current.rows.push({ type: 'hunk', text: line })
        continue
      }
      if (line.startsWith('new file')) current.notices.push('New file')
      else if (line.startsWith('deleted file'))
        current.notices.push('Deleted file')
      else if (line.startsWith('rename from '))
        current.notices.push(`Renamed from ${line.slice(12)}`)
      else if (line.startsWith('Binary files'))
        current.notices.push('Binary file, contents not shown')
      else if (line.startsWith('+++ ') && !current.path) {
        const target = line.slice(4).replace(/^b\//, '')
        if (target !== '/dev/null') current.path = target
      }
      continue
    }
    if (line.startsWith('\\')) continue
    if (line.startsWith('+'))
      current.rows.push({
        type: 'add',
        text: line.slice(1),
        newLine: newLine++,
      })
    else if (line.startsWith('-'))
      current.rows.push({
        type: 'del',
        text: line.slice(1),
        oldLine: oldLine++,
      })
    else
      current.rows.push({
        type: 'ctx',
        text: line.slice(1),
        oldLine: oldLine++,
        newLine: newLine++,
      })
  }
  return files
    .filter((entry) => entry.rows.length || entry.notices.length)
    .map(cap)
}

function cap(diff: FileDiff): FileDiff {
  if (diff.rows.length <= DIFF_MAX_LINES) return diff
  return {
    ...diff,
    rows: diff.rows.slice(0, DIFF_MAX_LINES),
    truncatedFrom: diff.rows.length,
  }
}
