import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { EventBus } from '../events/bus.js'
import {
  BdCommandError,
  BdParseError,
  hasCommentSince,
  readyChildren,
  show,
  watchBeads,
} from './beads.js'

const fixture = join(
  import.meta.dirname,
  '../../../../apps/server/test/fixtures/fake-bd',
)
const repo = join(
  import.meta.dirname,
  '../../../../apps/server/test/.beads-fixture',
)

describe('bd adapter', () => {
  beforeAll(async () => {
    process.env.PATH = `${fixture}:${process.env.PATH}`
    await mkdir(repo, { recursive: true })
  })

  it('parses ready children and show output', async () => {
    const children = await readyChildren(repo, 'epic-test')
    expect(children[0]).toMatchObject({ id: 'forge-test', labels: ['test'] })
    expect(await show(repo, 'forge-test')).toMatchObject({ id: 'forge-test' })
  })

  it('raises typed errors for malformed output and command failures', async () => {
    const old = process.env.FAKE_BD_MODE
    process.env.FAKE_BD_MODE = 'malformed'
    await expect(readyChildren(repo, 'epic-test')).rejects.toSatisfy(
      (error) =>
        error instanceof BdParseError && error.rawStdout.includes('not json'),
    )
    process.env.FAKE_BD_MODE = 'error'
    await expect(readyChildren(repo, 'epic-test')).rejects.toSatisfy(
      (error) =>
        error instanceof BdCommandError &&
        error.exitCode === 17 &&
        error.stderr.includes('fake bd'),
    )
    if (old === undefined) delete process.env.FAKE_BD_MODE
    else process.env.FAKE_BD_MODE = old
  })

  it('checks comment timestamps', async () => {
    expect(
      await hasCommentSince(repo, 'forge-test', '2098-01-01T00:00:00Z'),
    ).toBe(true)
  })
})

describe('beads watcher', () => {
  it('coalesces a burst and publishes on the bus', async () => {
    await mkdir(join(repo, '.beads'), { recursive: true })
    const signal = join(repo, '.beads', 'last-touched')
    await writeFile(signal, 'one')
    const bus = new EventBus()
    let changes = 0
    let events = 0
    const unsubscribe = bus.subscribe((event) => {
      if (event.type === 'beadsChanged') events++
    })
    const stop = watchBeads(
      repo,
      () => {
        changes++
      },
      bus,
    )
    await writeFile(signal, 'two')
    await new Promise((resolve) => setTimeout(resolve, 80))
    await writeFile(signal, 'three')
    await new Promise((resolve) => setTimeout(resolve, 650))
    stop()
    unsubscribe()
    await rm(repo, { recursive: true, force: true })
    expect(changes).toBe(1)
    expect(events).toBe(1)
  })
})
