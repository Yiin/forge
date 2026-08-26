import { afterEach, describe, expect, it } from 'vitest'
import { cleanPtyText, createPtyHarness } from './harness.js'

const handles: Array<{ kill(): void | Promise<void> }> = []

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.kill()
})

async function fixture(quietPeriodMs = 300) {
  const items: Array<{ type: string; text?: string; reason?: string }> = []
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

  it('scrubs OSC and cursor-control sequences', () => {
    expect(cleanPtyText('\u001b]0;title\u0007\u001b[2Khello\u001b[1G')).toBe(
      'hello',
    )
  })
})
