type ToolInput = Record<string, unknown>

export type ToolSummary = {
  title: string
  detail?: string
}

const FILE_TOOL_PATTERN = /^(?:read|write|edit)(?:[_ -].*)?$/i

function cleanTitle(name: string): string {
  return name.trim().replace(/^`+|`+$/g, '') || 'Tool'
}

function stringValue(input: ToolInput, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

export function summarizeToolCall(
  name: string,
  input: unknown,
): ToolSummary {
  const title = cleanTitle(name)
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { title }

  const values = input as ToolInput
  const command = stringValue(values, ['command', 'cmd'])
  if (command) {
    const description = stringValue(values, ['description'])
    const timeout = values.timeout
    const timeoutNote =
      typeof timeout === 'number' || typeof timeout === 'string'
        ? `timeout ${timeout}ms`
        : undefined
    const notes = [description && `— ${description}`, timeoutNote].filter(Boolean)
    return { title: `$ ${command}`, detail: notes.join(' · ') || undefined }
  }

  if (FILE_TOOL_PATTERN.test(title)) {
    const path = stringValue(values, ['path', 'file_path', 'filePath'])
    if (path) return { title: `${title} ${path}` }
  }

  return { title }
}
