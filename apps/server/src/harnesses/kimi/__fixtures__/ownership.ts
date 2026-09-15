import { appendFile, readFile, open } from 'node:fs/promises'
import { readProcNames } from '../../proc-names.js'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { processStartTicks } from '../lock.js'
import {
  groupHasRunningMember,
  signalProcessGroup,
  waitForProcessGroupExit,
} from '../../process-group.js'

// These receipts contain owned synthetic identities, never native arguments or tokens.
export const ownershipLog = `/var/tmp/forge-comet-kimi-review-correction-v2-ownership-${process.pid}-${randomUUID()}.jsonl`
export async function fixtureEvidence(phase: string, detail: object = {}) {
  await appendFile(ownershipLog, JSON.stringify({ phase, ...detail }) + '\n', {
    mode: 0o600,
  })
}
export async function fixtureEnvironment(home: string) {
  const testId = expect.getState().currentTestName ?? 'fixture startup'
  await fixtureEvidence('runner.owns_home', {
    home,
    checkout: fileURLToPath(new URL('../../../../../../', import.meta.url)),
    testId,
    pid: process.pid,
    startTicks: await processStartTicks(process.pid),
    boot: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
  })
  return {
    ...process.env,
    FORGE_KIMI_FIXTURE_OWNERSHIP_LOG: ownershipLog,
    FORGE_KIMI_FIXTURE_TEST_ID: testId,
  }
}
export async function finishFixtureHomes(homes: string[]) {
  let bytes = ''
  try {
    bytes = await readFile(ownershipLog, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const rows = bytes
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const peers = rows.filter(
    (row) => row.phase === 'peer.started' && homes.includes(row.home),
  )
  // One completed scan covers every original group after all guardians close.
  const groups = new Set(peers.map((peer) => peer.pid as number)),
    running = new Set<number>(),
    buffer = Buffer.alloc(4096),
    end = performance.now() + 5000
  const names = await readProcNames('/proc', {
    maximum: 65536,
    check() {
      if (performance.now() >= end)
        throw new Error('Fixture group inspection deadline')
    },
    limitError: () => new Error('Fixture process inspection limit'),
  })
  let inspected = 0
  for (const name of names) {
    if (performance.now() >= end)
      throw new Error('Fixture group inspection deadline')
    inspected++
    try {
      const file = await open(`/proc/${name}/stat`, 'r')
      try {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        if (bytesRead === buffer.length)
          throw new Error('Fixture process stat limit')
        const value = buffer.toString('utf8', 0, bytesRead)
        const fields = value.slice(value.lastIndexOf(')') + 2).split(' ')
        const group = Number(fields[2])
        if (groups.has(group) && fields[0] !== 'Z' && fields[0] !== 'X')
          running.add(group)
      } finally {
        await file.close()
      }
    } catch (error) {
      if (
        !['ENOENT', 'ESRCH'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error
    }
  }
  await fixtureEvidence('runner.group_scan', {
    inspected,
    groups: groups.size,
    running: [...running],
  })
  let forced = 0
  for (const peer of peers) {
    if (peer.pgid !== peer.pid)
      throw new Error('Fixture group identity changed')
    const boot = (
      await readFile('/proc/sys/kernel/random/boot_id', 'utf8')
    ).trim()
    if (boot !== peer.boot) throw new Error('Fixture boot identity changed')
    const ticks = await processStartTicks(peer.pid)
    if (ticks !== undefined && ticks !== peer.startTicks)
      throw new Error('Fixture process identity changed')
    if (running.has(peer.pid)) {
      await fixtureEvidence('runner.forced_cleanup', { original: peer })
      signalProcessGroup(peer.pid, 'SIGKILL')
      await waitForProcessGroupExit(peer.pid, performance.now() + 5000)
      forced++
    }
    await fixtureEvidence('runner.physical_settlement', {
      original: peer,
      groupAbsent:
        !running.has(peer.pid) ||
        !(await groupHasRunningMember(peer.pid, performance.now() + 5000)),
    })
  }
  await fixtureEvidence('runner.finalizer', {
    homes,
    peers: peers.length,
    forced,
  })
  expect(
    forced,
    'The normal finalizer must close every owned native group',
  ).toBe(0)
}
