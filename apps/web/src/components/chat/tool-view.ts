import type { ToolGroupEntry, ToolItem } from './render-model'
import { diffTexts, parseUnifiedDiff, type FileDiff } from './tool-diff'

/**
 * Reads a harness tool call the way zeron shows it: one kind, a short label
 * and detail for the row, the full call for the expanded block, and the
 * result as text or diffs. Harnesses name and shape tools differently
 * (Claude `Bash`, Codex `commandExecution` items, ACP titles with a `kind`
 * hint, Cursor `shell`, OpenCode `bash`), so each reader tries the known
 * shapes in turn and falls back to the raw JSON.
 */

export type ToolKind =
  | 'exec'
  | 'read'
  | 'write'
  | 'edit'
  | 'patch'
  | 'search'
  | 'glob'
  | 'fetch'
  | 'websearch'
  | 'todo'
  | 'mcp'
  | 'agent'
  | 'other'

export type ToolView = {
  kind: ToolKind
  label: string
  /** Single-lined detail after the label; empty when a file badge shows. */
  detail: string
  /** The file the tool touched, shown as a badge and offered to open. */
  path?: string
  /** Invocation block lines: wrapped at 80 columns, capped at 24. */
  call: string[]
  callHidden: number
  failed: boolean
}

export type ToolResult = {
  /** Result text, uncapped; the row caps it. */
  output?: string
  diffs: FileDiff[]
}

type Fields = Record<string, unknown>

const LABELS: Record<ToolKind, string> = {
  exec: 'Run',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  patch: 'Patch',
  search: 'Search',
  glob: 'Glob',
  fetch: 'Fetch',
  websearch: 'Web',
  todo: 'Todo',
  mcp: 'MCP',
  agent: 'Agent',
  other: 'Tool',
}

export const CALL_WRAP = 80
export const DETAIL_MAX_LINES = 24

function fields(value: unknown): Fields | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Fields)
    : undefined
}

function text(source: Fields | undefined, keys: string[]) {
  for (const key of keys) {
    const value = source?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

export function singleLine(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function cleanName(name: string) {
  return name.trim().replace(/^`+|`+$/g, '') || 'Tool'
}

const AGENT_NAMES = new Set(['agent', 'task', 'child', 'spawnagent'])

/** Subagent spawns render as standalone cards, never inside a tool group. */
export function isAgentTool(tool: {
  name: string
  input?: unknown
  nativeChildId?: string
}): boolean {
  if (tool.nativeChildId) return true
  if (text(fields(tool.input), ['subagent_type'])) return true
  const name = cleanName(tool.name)
  return AGENT_NAMES.has(name.toLowerCase()) || name.startsWith('Agent: ')
}

const NAME_KINDS: Array<[RegExp, ToolKind]> = [
  [
    /^(bash|shell|sh|exec|exec_command|run_command|run_shell_command|terminal|command|commandexecution)$/,
    'exec',
  ],
  [
    /^(todowrite|todo_write|updatetodos|todo|todos|update_todos|todoread|readtodos)$/,
    'todo',
  ],
  [/^(read|read_file|readfile|view|cat|open_file|read_many_files)$/, 'read'],
  [/^(write|write_file|writefile|create|create_file)$/, 'write'],
  [
    /^(edit|multiedit|multi_edit|edit_file|str_replace|str_replace_editor|str_replace_based_edit_tool|replace|notebookedit)$/,
    'edit',
  ],
  [/^(apply_patch|applypatch|patch|filechange|delete)$/, 'patch'],
  [
    /^(grep|search|rg|ripgrep|semsearch|codebase_search|search_file_content|grep_search)$/,
    'search',
  ],
  [/^(glob|ls|list|list_dir|list_directory|find|find_files)$/, 'glob'],
  [/^(webfetch|web_fetch|fetch|fetch_url)$/, 'fetch'],
  [/^(websearch|web_search|google_web_search)$/, 'websearch'],
]

const HINT_KINDS: Record<string, ToolKind> = {
  execute: 'exec',
  read: 'read',
  edit: 'edit',
  delete: 'patch',
  move: 'patch',
  search: 'search',
  fetch: 'fetch',
}

export function toolKind(
  tool: Pick<ToolItem, 'name' | 'input' | 'output' | 'nativeChildId'>,
): ToolKind {
  if (isAgentTool(tool)) return 'agent'
  const name = cleanName(tool.name)
  const input = fields(tool.input)
  const itemType = text(input, ['type'])
  if (itemType === 'commandExecution') return 'exec'
  if (itemType === 'fileChange') return 'patch'
  if (itemType === 'mcpToolCall') return 'mcp'
  if (itemType === 'webSearch') return 'websearch'
  if (/^mcp(__|$)/i.test(name)) return 'mcp'
  const lower = name.toLowerCase()
  for (const [pattern, kind] of NAME_KINDS) if (pattern.test(lower)) return kind
  // claude-code-acp names tools by title: "Read /path", "grep foo src",
  // "Find `*.ts`". The first word is the tool.
  const verb = lower.split(/[\s`]/)[0] ?? ''
  for (const [pattern, kind] of NAME_KINDS) if (pattern.test(verb)) return kind
  const hint = text(fields(tool.output), ['kind'])
  if (hint && HINT_KINDS[hint]) return HINT_KINDS[hint]
  if (text(input, ['command', 'cmd'])) return 'exec'
  if (input && ('old_string' in input || 'oldString' in input)) return 'edit'
  return 'other'
}

function filePath(input: Fields | undefined, output: Fields | undefined) {
  const direct = text(input, [
    'file_path',
    'filePath',
    'path',
    'notebook_path',
    'target_file',
    'absolute_path',
  ])
  if (direct) return direct
  const locations = output?.locations
  if (Array.isArray(locations)) return text(fields(locations[0]), ['path'])
  return undefined
}

function commandText(input: Fields | undefined) {
  const value = input?.command ?? input?.cmd
  if (Array.isArray(value)) return value.map(String).join(' ')
  return typeof value === 'string' ? value : undefined
}

function mcpTarget(name: string, input: Fields | undefined) {
  const parts = /^mcp__(.+?)__(.+)$/.exec(name)
  if (parts) return `${parts[1]} · ${parts[2]}`
  const server = text(input, ['server', 'providerIdentifier'])
  const tool = text(input, ['tool', 'toolName'])
  return [server, tool ?? name].filter(Boolean).join(' · ')
}

type Todo = { text: string; done: boolean }

function todos(input: Fields | undefined): Todo[] {
  const list = input?.todos ?? input?.items
  if (!Array.isArray(list)) return []
  return list.flatMap((entry) => {
    const item = fields(entry)
    const label = text(item, ['content', 'text', 'title', 'step'])
    if (!label) return []
    const status = text(item, ['status'])
    return [
      {
        text: label,
        done: status === 'completed' || item?.completed === true,
      },
    ]
  })
}

function pretty(value: unknown) {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

/** Hard-wraps at a column, trims trailing blank lines, and caps the count. */
export function capLines(value: string, max = DETAIL_MAX_LINES, wrap?: number) {
  const lines: string[] = []
  for (const line of value.replace(/\r\n?/g, '\n').split('\n')) {
    if (!wrap || line.length <= wrap) lines.push(line)
    else
      for (let start = 0; start < line.length; start += wrap)
        lines.push(line.slice(start, start + wrap))
  }
  while (lines.length && !lines.at(-1)!.trim()) lines.pop()
  if (lines.length <= max) return { lines, hidden: 0 }
  return { lines: lines.slice(0, max), hidden: lines.length - max }
}

function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  const parts = value.flatMap((entry) => {
    if (typeof entry === 'string') return [entry]
    const item = fields(entry)
    if (!item) return []
    if (typeof item.text === 'string') return [item.text]
    const nested = fields(item.content)
    if (typeof nested?.text === 'string') return [nested.text]
    return []
  })
  return parts.length ? parts.join('\n') : undefined
}

function outputText(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined
  if (typeof output === 'string') return output
  const content = contentText(output)
  if (content !== undefined) return content
  const record = fields(output)
  if (!record) return pretty(output)
  // Codex items carry the whole command transcript.
  if (typeof record.aggregatedOutput === 'string')
    return record.aggregatedOutput
  // ACP: text content first, then the raw output.
  const acp = contentText(record.content)
  if (acp) return acp
  if ('rawOutput' in record) {
    const raw = record.rawOutput
    if (raw === undefined || raw === null) return undefined
    const rawFields = fields(raw)
    return (
      text(rawFields, ['output', 'stdout', 'text', 'content']) ??
      contentText(raw) ??
      pretty(raw)
    )
  }
  // Cursor: {status, value | error}.
  const value = fields(record.value)
  if (record.status === 'error' && record.error !== undefined)
    return pretty(record.error)
  if (value) {
    const stdout = [text(value, ['stdout']), text(value, ['stderr'])]
      .filter(Boolean)
      .join('\n')
    if (stdout) return stdout
    const cursorText = text(value, ['content', 'output'])
    if (cursorText) return cursorText
  }
  // OpenCode: {output, error, metadata}.
  const plain = text(record, ['output', 'error', 'stdout', 'result', 'message'])
  if (plain) return plain
  return pretty(output)
}

function codexDiffs(changes: unknown): FileDiff[] {
  if (!Array.isArray(changes)) return []
  return changes.flatMap((entry) => {
    const change = fields(entry)
    const path = text(change, ['path'])
    const diff = typeof change?.diff === 'string' ? change.diff : ''
    const type = text(fields(change?.kind), ['type']) ?? text(change, ['kind'])
    if (type === 'delete')
      return [{ path, notices: ['Deleted file'], rows: [], numbered: false }]
    if (type === 'add' && !diff.includes('@@'))
      return [diffTexts(undefined, diff, path)]
    return parseUnifiedDiff(diff, path)
  })
}

function toolDiffs(
  kind: ToolKind,
  input: Fields | undefined,
  output: unknown,
  path: string | undefined,
): FileDiff[] {
  const out = fields(output)
  if (text(input, ['type']) === 'fileChange')
    return codexDiffs(out?.changes ?? input?.changes)
  const acp = Array.isArray(out?.content)
    ? out.content.flatMap((entry) => {
        const item = fields(entry)
        if (item?.type !== 'diff' || typeof item.newText !== 'string') return []
        return [
          diffTexts(
            typeof item.oldText === 'string' ? item.oldText : undefined,
            item.newText,
            text(item, ['path']),
          ),
        ]
      })
    : []
  if (acp.length) return acp
  const cursorDiff = text(fields(out?.value), ['diffString'])
  if (cursorDiff) return parseUnifiedDiff(cursorDiff, path)
  if (kind === 'patch') {
    const patch = text(input, ['patch', 'input', 'diff'])
    if (patch?.includes('@@')) return parseUnifiedDiff(patch, path)
  }
  if (kind !== 'edit' || !input) return []
  const edits = Array.isArray(input.edits) ? input.edits : [input]
  return edits.flatMap((entry) => {
    const edit = fields(entry)
    const before = edit?.old_string ?? edit?.oldString ?? edit?.old_str
    const after = edit?.new_string ?? edit?.newString ?? edit?.new_str
    if (typeof after !== 'string') return []
    return [
      diffTexts(typeof before === 'string' ? before : undefined, after, path),
    ]
  })
}

function patchPaths(input: Fields | undefined, output: unknown) {
  const changes = fields(output)?.changes ?? input?.changes
  if (!Array.isArray(changes)) return []
  return changes.flatMap((entry) => {
    const path = text(fields(entry), ['path'])
    return path ? [path] : []
  })
}

export function describeTool(tool: ToolItem): ToolView {
  const kind = toolKind(tool)
  const name = cleanName(tool.name)
  const input = fields(tool.input)
  const output = fields(tool.output)
  const patchFiles = kind === 'patch' ? patchPaths(input, tool.output) : []
  const path =
    filePath(input, output) ??
    (patchFiles.length === 1 ? patchFiles[0] : undefined)
  let detail = ''
  let call = ''
  switch (kind) {
    case 'exec': {
      const command = commandText(input) ?? name
      detail = command
      call = command
      break
    }
    case 'read':
    case 'edit':
      call = path ?? name
      break
    case 'write': {
      const content = text(input, ['content', 'fileText', 'file_text'])
      call = [path ?? name, content].filter(Boolean).join('\n')
      break
    }
    case 'patch':
      detail = path
        ? ''
        : patchFiles.length > 1
          ? `${patchFiles.length} files`
          : 'workspace'
      call =
        patchFiles.length > 1 ? patchFiles.join('\n') : (path ?? 'workspace')
      break
    case 'search': {
      const pattern = text(input, ['pattern', 'query', 'regex', 'search'])
      const where = text(input, [
        'path',
        'directory',
        'dir_path',
        'targetDirectory',
      ])
      detail = pattern ? (where ? `${pattern} in ${where}` : pattern) : name
      call = detail
      break
    }
    case 'glob':
      detail =
        text(input, [
          'pattern',
          'globPattern',
          'glob_pattern',
          'glob',
          'path',
        ]) ?? name
      call = detail
      break
    case 'fetch': {
      const url = text(input, ['url', 'uri']) ?? name
      detail = url
      call = [url, text(input, ['prompt'])].filter(Boolean).join('\n')
      break
    }
    case 'websearch':
      detail = text(input, ['query', 'search_query']) ?? name
      call = detail
      break
    case 'todo': {
      const list = todos(input)
      detail = list.length
        ? `${list.filter((todo) => todo.done).length}/${list.length} done`
        : ''
      call = list
        .map((todo) => `${todo.done ? '[x]' : '[ ]'} ${todo.text}`)
        .join('\n')
      break
    }
    case 'mcp': {
      const target = mcpTarget(name, input)
      detail = target
      call = [
        target,
        pretty(input?.arguments ?? input?.args ?? tool.input),
      ].join('\n')
      break
    }
    case 'agent':
      detail = name.startsWith('Agent: ')
        ? name.slice(7)
        : (text(input, ['description', 'prompt']) ?? '')
      call = [name, pretty(tool.input)].join('\n')
      break
    case 'other':
      detail = name
      call =
        tool.input === undefined ? name : [name, pretty(tool.input)].join('\n')
      break
  }
  // A known kind with a path shows the badge; one without keeps the title.
  if (['read', 'write', 'edit'].includes(kind) && !path) detail = name
  const capped = capLines(call, DETAIL_MAX_LINES, CALL_WRAP)
  return {
    kind,
    label: LABELS[kind],
    detail: singleLine(detail),
    path:
      path && ['read', 'write', 'edit', 'patch'].includes(kind)
        ? path
        : undefined,
    call: capped.lines,
    callHidden: capped.hidden,
    failed: tool.state === 'error',
  }
}

/**
 * What the tool produced. Diffs win over text, as in zeron; they are built
 * only when a row opens, since a large edit costs a line diff.
 */
export function toolResult(tool: ToolItem, view: ToolView): ToolResult {
  const diffs = toolDiffs(view.kind, fields(tool.input), tool.output, view.path)
  return {
    output: diffs.length ? undefined : outputText(tool.output),
    diffs,
  }
}

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`

/**
 * The group header: past tense in a fixed order, thoughts first, failures
 * last. Only the first letter of the whole line is uppercase.
 */
export function summarizeToolGroup(entries: ToolGroupEntry[]): string {
  let thoughts = 0
  let commands = 0
  let reads = 0
  let searches = 0
  let fetches = 0
  let todo = false
  let other = 0
  let failed = 0
  let tools = 0
  const edited = new Set<string>()
  for (const entry of entries) {
    if (entry.kind === 'message') {
      thoughts++
      continue
    }
    tools++
    if (entry.state === 'error') failed++
    const view = describeTool(entry)
    switch (view.kind) {
      case 'exec':
        commands++
        break
      case 'write':
      case 'edit':
      case 'patch':
        edited.add(view.path ?? 'patch')
        break
      case 'read':
        reads++
        break
      case 'search':
      case 'glob':
      case 'websearch':
        searches++
        break
      case 'fetch':
        fetches++
        break
      case 'todo':
        todo = true
        break
      default:
        other++
    }
  }
  const segments = [
    thoughts === 1 ? 'thought process' : '',
    thoughts > 1 ? `thought ${thoughts} times` : '',
    commands ? `ran ${plural(commands, 'command', 'commands')}` : '',
    edited.size ? `edited ${plural(edited.size, 'file', 'files')}` : '',
    reads ? `read ${plural(reads, 'file', 'files')}` : '',
    searches ? `searched ${plural(searches, 'time', 'times')}` : '',
    fetches ? `fetched ${plural(fetches, 'page', 'pages')}` : '',
    todo ? 'updated todos' : '',
    other ? `called ${plural(other, 'tool', 'tools')}` : '',
  ].filter(Boolean)
  if (tools && segments.length === (thoughts ? 1 : 0))
    segments.push(plural(tools, 'tool', 'tools'))
  if (failed) segments.push(`${failed} failed`)
  const summary = segments.join(' · ')
  return summary.charAt(0).toUpperCase() + summary.slice(1)
}
