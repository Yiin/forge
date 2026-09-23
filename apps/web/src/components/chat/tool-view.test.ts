import { describe, expect, it } from 'vitest'
import type { MessageItem, ToolItem } from './render-model'
import { diffTexts, parseUnifiedDiff } from './tool-diff'
import {
  capLines,
  describeTool,
  summarizeToolGroup,
  toolKind,
  toolResult,
} from './tool-view'

let next = 0
const tool = (
  name: string,
  input: unknown,
  extra: Partial<ToolItem> = {},
): ToolItem => ({
  kind: 'tool',
  id: `tool-${next++}`,
  name,
  state: 'done',
  input,
  ...extra,
})
const thought: MessageItem = {
  kind: 'message',
  id: 'thought',
  seq: 1,
  role: 'agent',
  text: 'hmm',
  thought: true,
}

describe('tool summary', () => {
  it('counts each kind in past tense with singular and plural forms', () => {
    expect(
      summarizeToolGroup([
        tool('Bash', { command: 'pwd' }),
        tool('Bash', { command: 'ls' }),
        tool('Bash', { command: 'git status' }),
        tool('Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }),
        tool('Write', { file_path: 'b.ts', content: 'x' }),
      ]),
    ).toBe('Ran 3 commands · edited 2 files')
    expect(
      summarizeToolGroup([
        tool('Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }),
        tool('Edit', { file_path: 'a.ts', old_string: 'b', new_string: 'c' }),
      ]),
    ).toBe('Edited 1 file')
    expect(
      summarizeToolGroup([
        tool('Read', { file_path: 'a.ts' }),
        tool('Grep', { pattern: 'x' }),
        tool('Glob', { pattern: '*.ts' }),
      ]),
    ).toBe('Read 1 file · searched 2 times')
  })

  it('appends failures last and keeps the header wording otherwise', () => {
    expect(
      summarizeToolGroup([
        tool('Bash', { command: 'false' }, { state: 'error' }),
      ]),
    ).toBe('Ran 1 command · 1 failed')
  })

  it('leads with thinking and lowercases the rest', () => {
    expect(
      summarizeToolGroup([
        thought,
        tool('Bash', { command: 'a' }),
        tool('Bash', { command: 'b' }),
      ]),
    ).toBe('Thought process · ran 2 commands')
    expect(summarizeToolGroup([thought, { ...thought, id: 'two' }])).toBe(
      'Thought 2 times',
    )
    expect(summarizeToolGroup([thought])).toBe('Thought process')
  })

  it('names the remaining kinds in their fixed order', () => {
    expect(
      summarizeToolGroup([
        tool('mcp__github__search', {}),
        tool('TodoWrite', { todos: [] }),
        tool('WebFetch', { url: 'https://a.test' }),
        tool('WebSearch', { query: 'forge' }),
      ]),
    ).toBe('Searched 1 time · fetched 1 page · updated todos · called 1 tool')
  })
})

describe('tool kinds', () => {
  it('reads each harness shape', () => {
    expect(toolKind(tool('Bash', { command: 'pwd' }))).toBe('exec')
    expect(toolKind(tool('bash', { command: 'pwd' }))).toBe('exec')
    expect(
      toolKind(tool('commandExecution', { type: 'commandExecution' })),
    ).toBe('exec')
    expect(toolKind(tool('fileChange', { type: 'fileChange' }))).toBe('patch')
    expect(toolKind(tool('search', { type: 'mcpToolCall' }))).toBe('mcp')
    expect(toolKind(tool('shell', { command: 'pwd' }))).toBe('exec')
    expect(
      toolKind(
        tool('Fixture tool', { path: 'a' }, { output: { kind: 'read' } }),
      ),
    ).toBe('read')
    expect(toolKind(tool('Agent', { description: 'x' }))).toBe('agent')
    expect(
      toolKind(tool('child', { description: 'x' }, { nativeChildId: 'c' })),
    ).toBe('agent')
    expect(toolKind(tool('mystery', {}))).toBe('other')
  })

  it('reads claude-code-acp title names by their first word', () => {
    expect(toolKind(tool('Read /repo/a.ts', { file_path: '/repo/a.ts' }))).toBe(
      'read',
    )
    expect(toolKind(tool('grep "paste" apps/web', { pattern: 'paste' }))).toBe(
      'search',
    )
    expect(toolKind(tool('Find `**/*.ts`', { pattern: '**/*.ts' }))).toBe(
      'glob',
    )
    expect(
      toolKind(tool('`find . -name apps`', { command: 'find . -name apps' })),
    ).toBe('exec')
    expect(
      toolKind(
        tool('Explore paste handling', {
          description: 'Explore paste handling',
          subagent_type: 'Explore',
        }),
      ),
    ).toBe('agent')
    expect(
      summarizeToolGroup([
        tool('Read /repo/a.ts', { file_path: '/repo/a.ts' }),
        tool('grep "x" src', { pattern: 'x' }),
        tool('Find `*.ts`', { pattern: '*.ts' }),
      ]),
    ).toBe('Read 1 file · searched 2 times')
  })

  it('builds the row label, detail, and file badge', () => {
    expect(
      describeTool(tool('Bash', { command: 'git\n status' })),
    ).toMatchObject({
      label: 'Run',
      detail: 'git status',
      call: ['git', ' status'],
    })
    expect(
      describeTool(tool('Read', { file_path: 'src/main.ts' })),
    ).toMatchObject({ label: 'Read', path: 'src/main.ts', detail: '' })
    expect(
      describeTool(tool('Grep', { pattern: 'foo', path: 'src' })),
    ).toMatchObject({ label: 'Search', detail: 'foo in src' })
    expect(
      describeTool(
        tool('TodoWrite', {
          todos: [
            { content: 'One', status: 'completed' },
            { content: 'Two', status: 'pending' },
          ],
        }),
      ),
    ).toMatchObject({
      label: 'Todo',
      detail: '1/2 done',
      call: ['[x] One', '[ ] Two'],
    })
    expect(describeTool(tool('mcp__github__search', {}))).toMatchObject({
      label: 'MCP',
      detail: 'github · search',
    })
    expect(
      describeTool(tool('Bash', { command: 'x' }, { state: 'error' })).failed,
    ).toBe(true)
  })

  it('finds output text in each harness shape', () => {
    const result = (output: unknown) => {
      const item = tool('Bash', { command: 'pwd' }, { output })
      return toolResult(item, describeTool(item)).output
    }
    expect(result('/tmp')).toBe('/tmp')
    expect(result([{ type: 'text', text: 'claude' }])).toBe('claude')
    expect(
      result({ type: 'commandExecution', aggregatedOutput: 'codex' }),
    ).toBe('codex')
    expect(
      result({
        content: [{ type: 'content', content: { type: 'text', text: 'acp' } }],
      }),
    ).toBe('acp')
    expect(result({ status: 'success', value: { stdout: 'cursor' } })).toBe(
      'cursor',
    )
    expect(result({ output: 'opencode' })).toBe('opencode')
  })

  it('shows an edit as a diff instead of text', () => {
    const item = tool('Edit', {
      file_path: 'a.ts',
      old_string: 'one\ntwo\n',
      new_string: 'one\nthree\n',
    })
    const result = toolResult(item, describeTool(item))
    expect(result.output).toBeUndefined()
    expect(result.diffs[0].rows.map((row) => [row.type, row.text])).toEqual([
      ['ctx', 'one'],
      ['del', 'two'],
      ['add', 'three'],
    ])
  })
})

describe('diffs', () => {
  it('keeps three context lines around a change', () => {
    const before = Array.from({ length: 20 }, (_, index) => `l${index}`)
    const after = [...before]
    after[10] = 'changed'
    const rows = diffTexts(before.join('\n'), after.join('\n')).rows
    expect(rows.map((row) => row.text)).toEqual([
      'l7',
      'l8',
      'l9',
      'l10',
      'changed',
      'l11',
      'l12',
      'l13',
    ])
  })

  it('marks a file with no old text as new', () => {
    expect(diffTexts(undefined, 'a\nb').notices).toEqual(['New file'])
  })

  it('parses unified diffs with line numbers', () => {
    const [file] = parseUnifiedDiff(
      [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -4,2 +4,2 @@',
        ' keep',
        '-old',
        '+new',
      ].join('\n'),
    )
    expect(file.path).toBe('src/a.ts')
    expect(file.numbered).toBe(true)
    expect(file.rows).toEqual([
      { type: 'hunk', text: '@@ -4,2 +4,2 @@' },
      { type: 'ctx', text: 'keep', oldLine: 4, newLine: 4 },
      { type: 'del', text: 'old', oldLine: 5 },
      { type: 'add', text: 'new', newLine: 5 },
    ])
  })
})

describe('capLines', () => {
  it('trims trailing blank lines and counts the rest', () => {
    const text = Array.from({ length: 30 }, (_, index) => `${index}`).join('\n')
    expect(capLines(`${text}\n\n`)).toMatchObject({ hidden: 6 })
    expect(capLines('a'.repeat(170), 24, 80).lines).toHaveLength(3)
  })
})
