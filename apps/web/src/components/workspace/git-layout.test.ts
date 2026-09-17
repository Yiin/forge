import { expect, it } from 'vitest'
import { historyGraph } from './history-graph'
import { splitDiffLines } from './diff-lines'
it('keeps explicit merge parents in separate lanes until their real join', () => {
  const graph = historyGraph(
    [
      { sha: 'merge', parents: ['left', 'right'] },
      { sha: 'left', parents: ['base'] },
      { sha: 'right', parents: ['base'] },
      { sha: 'base', parents: [] },
    ].map((item) => ({ ...item, refs: [], author: '', date: '', subject: '' })),
  )
  expect(graph[0]!.edges.filter((edge) => edge.node)).toHaveLength(2)
  expect(graph[0]!.width).toBe(2)
  expect(graph.map((row) => row.incoming)).toEqual([false, true, true, true])
  expect(graph[2]!.edges.find((edge) => edge.node)?.to).toBe(0)
  expect(graph[3]!.edges).toHaveLength(0)
})
it('pairs contiguous changes without moving context or later edits', () => {
  const line = (type: 'deletion' | 'addition' | 'context', text: string) => ({
    type,
    text,
    oldLine: type === 'addition' ? null : 1,
    newLine: type === 'deletion' ? null : 1,
  })
  const rows = splitDiffLines([
    line('deletion', 'old1'),
    line('deletion', 'old2'),
    line('addition', 'new1'),
    line('context', 'same'),
    line('deletion', 'old3'),
    line('addition', 'new3'),
  ])
  expect(rows.map((pair) => pair.map((line) => line?.text))).toEqual([
    ['old1', 'new1'],
    ['old2', undefined],
    ['same', 'same'],
    ['old3', 'new3'],
  ])
})
