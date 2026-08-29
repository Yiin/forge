import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanPtyText, createPtyHarness } from './harness.js'

const handles: Array<{ kill(): void | Promise<void> }> = []

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.kill()
})

async function fixture(quietPeriodMs = 300) {
  const items: Array<{
    type: string
    text?: string
    reason?: string
    itemId?: string
  }> = []
  let exited: Error | undefined
  const harness = createPtyHarness({
    command: 'bash',
    args: ['-i'],
    env: { PS1: '' },
    quietPeriodMs,
    maxTurnMs: 5_000,
  })
  const handle = await harness.spawn(
    { id: 'session', cwd: globalThis.process.cwd(), harness: 'bash' },
    (item) => items.push(item as (typeof items)[number]),
    (error) => {
      exited = error
    },
  )
  handles.push(handle)
  return {
    handle,
    items,
    get exited() {
      return exited
    },
  }
}

async function processFixture(command: string, args: string[]) {
  const items: Array<{ type: string; text?: string; reason?: string }> = []
  let exited: Error | undefined
  const harness = createPtyHarness({
    command,
    args,
    env: { TERM: 'xterm-256color' },
    quietPeriodMs: 200,
    maxTurnMs: 5_000,
  })
  const handle = await harness.spawn(
    { id: 'session', cwd: globalThis.process.cwd(), harness: command },
    (item) => items.push(item as (typeof items)[number]),
    (error) => {
      exited = error
    },
  )
  handles.push(handle)
  return {
    handle,
    items,
    get exited() {
      return exited
    },
  }
}

async function waitFor(items: Array<{ type: string }>, type: string) {
  const started = Date.now()
  while (!items.some((item) => item.type === type)) {
    if (Date.now() - started > 3_000)
      throw new Error(`Timed out waiting for ${type}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function waitForCount(
  items: Array<{ type: string }>,
  type: string,
  count: number,
) {
  const started = Date.now()
  while (items.filter((item) => item.type === type).length < count) {
    if (Date.now() - started > 3_000)
      throw new Error(`Timed out waiting for ${type}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('PTY harness', () => {
  it('frames sequential shell prompts and removes echoed input', async () => {
    const { handle, items } = await fixture()
    handle.prompt('echo hello')
    await waitFor(items, 'turn_end')
    handle.prompt('echo done')
    await waitForCount(items, 'turn_end', 2)

    const text = items
      .filter((item) => item.type === 'text_delta')
      .map((item) => item.text)
      .join('')
    expect(text).toContain('hello')
    expect(text).toContain('done')
    expect(text).not.toContain('echo hello')
    expect(text).not.toContain('echo done')
    expect(items.filter((item) => item.type === 'turn_start')).toHaveLength(2)
    expect(items.filter((item) => item.type === 'turn_end')).toHaveLength(2)
    const firstEnd = items.findIndex((item) => item.type === 'turn_end')
    const firstDeltaIds = items
      .slice(0, firstEnd)
      .filter((item) => item.type === 'text_delta')
      .map((item) => item.itemId)
    const secondDeltaIds = items
      .slice(firstEnd + 1)
      .filter((item) => item.type === 'text_delta')
      .map((item) => item.itemId)
    expect(firstDeltaIds[0]).toBeDefined()
    expect(new Set(firstDeltaIds).size).toBe(1)
    expect(secondDeltaIds[0]).toBeDefined()
    expect(new Set(secondDeltaIds).size).toBe(1)
    expect(firstDeltaIds[0]).not.toBe(secondDeltaIds[0])
  })

  it('waits through a silent command before ending the turn', async () => {
    const { handle, items } = await fixture(300)
    handle.prompt('sleep 1 && echo done')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(items.some((item) => item.type === 'turn_end')).toBe(false)
    await waitFor(items, 'turn_end')
    expect(
      items
        .filter((item) => item.type === 'text_delta')
        .map((item) => item.text)
        .join(''),
    ).toContain('done')
  })

  it('keeps one item id across large output chunks', async () => {
    const { handle, items } = await fixture()
    handle.prompt("printf 'x%.0s' {1..5000}; echo")
    await waitFor(items, 'turn_end')

    const deltas = items.filter((item) => item.type === 'text_delta')
    expect(deltas.length).toBeGreaterThan(2)
    expect(new Set(deltas.map((item) => item.itemId)).size).toBe(1)
  })

  it('cancels a running command and strips ANSI output', async () => {
    const { handle, items } = await fixture(500)
    handle.prompt("printf '\\033[31mred\\033[0m\\n'; sleep 30")
    await new Promise((resolve) => setTimeout(resolve, 400))
    handle.cancel()
    await waitFor(items, 'turn_interrupted')
    const text = items
      .filter((item) => item.type === 'text_delta')
      .map((item) => item.text)
      .join('')
    expect(text).toContain('red')
    expect(text).not.toMatch(/\u001b\[/)
    expect(items.at(-1)?.reason).toBe('cancelled')
  })

  it('keeps the PTY alive after manually ending a turn', async () => {
    const { handle, items } = await fixture(500)
    handle.prompt('sleep 30')
    await new Promise((resolve) => setTimeout(resolve, 250))
    handle.cancel()
    await waitFor(items, 'turn_interrupted')

    handle.prompt('echo alive')
    await waitForCount(items, 'turn_end', 1)
    expect(
      items
        .filter((item) => item.type === 'text_delta')
        .map((item) => item.text)
        .join(''),
    ).toContain('alive')
  })

  it('supports a real Python REPL prompt', async () => {
    try {
      execFileSync('python3', ['--version'], { stdio: 'ignore' })
    } catch {
      return
    }
    const { handle, items } = await processFixture('python3', ['-i', '-q'])
    handle.prompt("print('python hello')")
    await waitFor(items, 'turn_end')
    const text = items
      .filter((item) => item.type === 'text_delta')
      .map((item) => item.text)
      .join('')
    expect(text).toContain('python hello')
    expect(text).not.toContain("print('python hello')")
  })

  it('does not duplicate output when the PTY exits during a turn', async () => {
    const { handle, items } = await processFixture('bash', [
      '-c',
      'read command; printf "child output\\n"; exit 1',
    ])
    handle.prompt('anything')
    await waitFor(items, 'turn_interrupted')
    const text = items
      .filter((item) => item.type === 'text_delta')
      .map((item) => item.text)
      .join('')
    expect(text.match(/child output/g)).toHaveLength(1)
    expect(items.filter((item) => item.type === 'error')).toHaveLength(1)
  })

  it('scrubs OSC and cursor-control sequences', () => {
    expect(cleanPtyText('\u001b]0;title\u0007\u001b[2Khello\u001b[1G')).toBe(
      'hello',
    )
  })
})
