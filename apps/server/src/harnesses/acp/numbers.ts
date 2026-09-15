export type NumericToken = Readonly<{
  path: string
  text: string
  offset: number
}>
export type NumericCapture = Readonly<{ numbers: readonly NumericToken[] }>

/** Captures number spellings before JSON.parse can round them. */
export function captureNumbers(
  source: string,
  captureString?: (path: string, value: string) => void,
): NumericCapture {
  let position = 0,
    nodes = 0,
    metadataBytes = 14
  const tokens: Array<{ path: string; text: string; start: number }> = []
  const fail = (): never => {
    throw Error('Invalid ACP numeric source')
  }
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(source[position] ?? '\0')) position++
  }
  const string = (): string => {
    if (source[position++] !== '"') fail()
    const start = position - 1
    while (position < source.length) {
      const char = source[position++]!
      if (char === '"') {
        try {
          return JSON.parse(source.slice(start, position)) as string
        } catch {
          fail()
        }
      }
      if (char === '\\') {
        const escape = source[position++]
        if (escape === 'u') {
          if (!/^[a-fA-F0-9]{4}$/.test(source.slice(position, position + 4)))
            fail()
          position += 4
        } else if (!escape || !'"\\/bfnrt'.includes(escape)) fail()
      } else if (char.charCodeAt(0) < 32) fail()
    }
    return fail()
  }
  const value = (path: string, depth: number): void => {
    if (++nodes > 65536 || depth > 64) fail()
    whitespace()
    const char = source[position]
    if (char === '"') {
      const scalar = string()
      captureString?.(path, scalar)
      return
    }
    if (char === '{' || char === '[') {
      const object = char === '{',
        end = object ? '}' : ']'
      position++
      whitespace()
      if (source[position] === end) {
        position++
        return
      }
      const keys = new Set<string>()
      let index = 0
      while (true) {
        let key = String(index++)
        if (object) {
          key = string()
          if (keys.has(key)) fail()
          keys.add(key)
          whitespace()
          if (source[position++] !== ':') fail()
        }
        value(
          path + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1'),
          depth + 1,
        )
        whitespace()
        const separator = source[position++]
        if (separator === end) break
        if (separator !== ',') fail()
        whitespace()
      }
      return
    }
    for (const literal of ['true', 'false', 'null']) {
      if (source.startsWith(literal, position)) {
        position += literal.length
        return
      }
    }
    const start = position
    if (source[position] === '-') position++
    if (source[position] === '0') position++
    else {
      if (!/[1-9]/.test(source[position] ?? '')) fail()
      while (/[0-9]/.test(source[position] ?? '')) position++
    }
    if (source[position] === '.') {
      position++
      if (!/[0-9]/.test(source[position] ?? '')) fail()
      while (/[0-9]/.test(source[position] ?? '')) position++
    }
    if (source[position] === 'e' || source[position] === 'E') {
      position++
      if (source[position] === '+' || source[position] === '-') position++
      if (!/[0-9]/.test(source[position] ?? '')) fail()
      while (/[0-9]/.test(source[position] ?? '')) position++
    }
    const text = source.slice(start, position)
    metadataBytes +=
      Buffer.byteLength(JSON.stringify(path)) +
      Buffer.byteLength(JSON.stringify(text)) +
      64
    if (tokens.length >= 16384 || metadataBytes > 1024 * 1024) fail()
    tokens.push({ path, text, start })
  }
  value('', 0)
  whitespace()
  if (position !== source.length) fail()
  let previous = 0,
    offset = 0
  const numbers = tokens.map((token) => {
    offset += Buffer.byteLength(source.slice(previous, token.start))
    previous = token.start
    return Object.freeze({ path: token.path, text: token.text, offset })
  })
  return Object.freeze({ numbers: Object.freeze(numbers) })
}

export function declaredInteger(token: NumericToken, type: 'i64' | 'u64') {
  if (!/^-?(0|[1-9][0-9]*)$/.test(token.text))
    throw Error('ACP integer syntax is unsupported')
  const integer = BigInt(token.text)
  const minimum = type === 'u64' ? 0n : -(1n << 63n)
  const maximum = type === 'u64' ? (1n << 64n) - 1n : (1n << 63n) - 1n
  if (
    integer < minimum ||
    integer > maximum ||
    (type === 'u64' && token.text.startsWith('-'))
  )
    throw Error('ACP integer exceeds declared range')
  return Object.freeze({
    decimal: token.text,
    ...(integer >= 0n && integer <= BigInt(Number.MAX_SAFE_INTEGER)
      ? { safeCount: Number(integer) }
      : {}),
  })
}
