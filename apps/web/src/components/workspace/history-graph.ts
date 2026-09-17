import type { GitHistoryPage } from '@forge/protocol/git'

/** Each edge follows an explicit Git parent ID. Unloaded parents remain open lanes. */
export function historyGraph(commits: GitHistoryPage['commits']) {
  let lanes: string[] = []
  return commits.map((commit) => {
    let column = lanes.indexOf(commit.sha)
    const incoming = column >= 0
    if (column < 0) {
      column = lanes.length
      lanes.push(commit.sha)
    }
    const before = [...lanes]
    lanes.splice(column, 1)
    for (const parent of [...commit.parents].reverse())
      if (!lanes.includes(parent))
        lanes.splice(Math.min(column, lanes.length), 0, parent)
    const edges = before.flatMap((sha, from) => {
      if (sha === commit.sha) return []
      const to = lanes.indexOf(sha)
      return to < 0 ? [] : [{ from, to, node: false }]
    })
    for (const parent of commit.parents)
      edges.push({ from: column, to: lanes.indexOf(parent), node: true })
    return {
      column,
      incoming,
      width: Math.max(before.length, lanes.length, 1),
      edges,
    }
  })
}
