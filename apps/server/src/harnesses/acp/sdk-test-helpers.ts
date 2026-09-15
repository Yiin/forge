import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import type { HarnessEvent, HarnessHandle } from '../types.js'
import { expectStopped } from '../transport-test-helpers.js'
import type { AcpRuntimeDependencies } from './runtime.js'
import {
  committedPrefix,
  emptyPrefix,
  type PrefixTransaction,
} from './ingestion.js'
import { AcpResourceHost } from './limits.js'

const command = fileURLToPath(
  new URL('./__fixtures__/sdk-agent.mjs', import.meta.url),
)
export async function sdkFixture(
  scenario: string,
  beforeCommit?: (transaction: PrefixTransaction) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-sdk-runtime-'))
  const report = join(directory, 'wire.jsonl')
  const events: HarnessEvent[] = [],
    transactions: PrefixTransaction[] = [],
    failures: unknown[] = []
  let artifact = 0
  const deps: AcpRuntimeDependencies = {
    profile: 'custom-acp',
    launch: {
      providerInstanceId: 'instance',
      account: { kind: 'native-default', configurationId: 'config' },
      command,
      args: [],
      env: { FORGE_ACP_TEST_SCENARIO: scenario, FORGE_ACP_TEST_REPORT: report },
    },
    host: new AcpResourceHost(),
    ingestion: {
      async open() {
        return {
          journalId: 'journal',
          writerEpoch: 'epoch',
          committedThrough: 0,
          prefixHash: emptyPrefix('journal'),
          async commit(transaction) {
            transactions.push(transaction)
            await beforeCommit?.(transaction)
            return {
              transactionId: transaction.transactionId,
              throughOrdinal: transaction.throughOrdinal,
              prefixHash: committedPrefix(transaction),
            }
          },
          async close() {},
        }
      },
    },
    contentStore: {
      async put(input) {
        return {
          artifactId: `artifact-${++artifact}`,
          mime: input.mime,
          bytes: input.bytes.byteLength,
          sha256: createHash('sha256').update(input.bytes).digest('hex'),
        }
      },
      async discard() {},
    },
    authorizedAttachment: async () => {
      throw Error('Unexpected attachment')
    },
    broker: {
      admit() {
        return { retire() {} }
      },
    },
    async services() {
      const inactive = {
        async receive() {
          return false
        },
        async close() {},
      }
      return { filesystem: inactive, terminals: inactive }
    },
    failure(error) {
      failures.push(error)
    },
  }
  return {
    deps,
    events,
    transactions,
    failures,
    session: { id: 'session', provider: 'instance', cwd: directory },
    async frames() {
      return (await readFile(report, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((row) => row.event === 'received')
        .map((row) => row.frame)
    },
    async cleanup(handle?: HarnessHandle) {
      await handle?.kill()
      for (const line of (await readFile(report, 'utf8').catch(() => ''))
        .trim()
        .split('\n')
        .filter(Boolean)) {
        const row = JSON.parse(line)
        if (row.event === 'spawned') await expectStopped(row.pid)
      }
      await rm(directory, { recursive: true, force: true })
    },
  }
}
