import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { expectStopped } from '../transport-test-helpers.js'
import { AcpConnection, type AcpConnectionOptions } from './connection.js'
import { AcpResourceHost } from './limits.js'
import {
  committedPrefix,
  emptyPrefix,
  type PrefixTransaction,
} from './ingestion.js'

const command = fileURLToPath(
  new URL('./__fixtures__/sdk-agent.mjs', import.meta.url),
)

describe('installed SDK through the ACP connection', () => {
  test.each(['permission', 'resume-replay'] as const)(
    'commits %s through the production transport and journal',
    async (scenario) => {
      const directory = await mkdtemp(join(tmpdir(), 'forge-acp-sdk-'))
      const report = join(directory, 'wire.jsonl')
      const transactions: PrefixTransaction[] = []
      const updates: { phase: string; params: unknown }[] = []
      const requestIds: (string | number)[] = []
      const failures: unknown[] = []
      let writerClosed = false
      const options: AcpConnectionOptions = {
        profile: 'custom-acp',
        launch: {
          providerInstanceId: 'instance',
          account: { kind: 'native-default', configurationId: 'config' },
          command,
          args: [],
          env: {
            FORGE_ACP_TEST_REPORT: report,
            FORGE_ACP_TEST_SCENARIO: scenario,
          },
        },
        host: new AcpResourceHost(),
        ingestion: {
          async open() {
            return {
              journalId: 'sdk-journal',
              writerEpoch: 'sdk-epoch',
              committedThrough: 0,
              prefixHash: emptyPrefix('sdk-journal'),
              async commit(transaction) {
                transactions.push(transaction)
                return {
                  transactionId: transaction.transactionId,
                  throughOrdinal: transaction.throughOrdinal,
                  prefixHash: committedPrefix(transaction),
                }
              },
              async close() {
                writerClosed = true
              },
            }
          },
        },
        route: (_strings, fallback) => fallback,
        async incoming(message, frame, connection) {
          if (message.method === 'session/update')
            updates.push({ phase: frame.owner.phase, params: message.params })
          frame.ticket.finish([
            {
              value: {
                kind: 'disposition',
                status:
                  frame.owner.phase === 'load_replay'
                    ? 'replay_staged'
                    : 'ignored',
              },
            },
          ])
          await frame.ticket.committed
          if (message.type === 'request') {
            expect(message.method).toBe('session/request_permission')
            requestIds.push(message.id)
            const submission = connection.rpc.respondWithSubmission(message, {
              outcome: { outcome: 'selected', optionId: 'allow-once' },
            })
            await submission.logical
            expect((await submission.submission).status).toBe('written')
          }
        },
        failure(error) {
          failures.push(error)
        },
      }
      const session = {
        id: 'forge-session',
        provider: 'instance',
        cwd: directory,
        ...(scenario === 'resume-replay'
          ? {
              binding: {
                provider: 'instance',
                accountId: null,
                cwd: directory,
                providerSessionId: 'sdk-loaded-session',
              },
            }
          : {}),
      }
      let connection: AcpConnection | undefined
      try {
        connection = await AcpConnection.open(
          options,
          session,
          scenario === 'resume-replay',
        )
        const records = transactions.flatMap(
          (transaction) => transaction.records,
        )
        expect(records.some((record) => record.value.kind === 'binding')).toBe(
          true,
        )
        if (scenario === 'resume-replay') {
          expect(updates).toHaveLength(70)
          expect(
            updates.every((update) => update.phase === 'load_replay'),
          ).toBe(true)
          expect(
            updates.map(
              (value) =>
                (value.params as { update: { content: { text: string } } })
                  .update.content.text,
            ),
          ).toEqual(Array.from({ length: 70 }, (_, i) => `History ${i}.`))
          expect(
            records.filter(
              (record) =>
                record.value.kind === 'disposition' &&
                record.value.status === 'replay_staged',
            ),
          ).toHaveLength(70)
          expect(
            records.some(
              (record) =>
                record.value.kind === 'disposition' &&
                record.value.status === 'replay_visible',
            ),
          ).toBe(true)
        }
        const call = connection.call(
          'session/prompt',
          {
            sessionId: connection.binding!.providerSessionId,
            prompt: [{ type: 'text', text: 'SDK acceptance' }],
          },
          connection.control,
        )
        await call.submission
        const response = await call.response
        expect(response.value).toEqual({ stopReason: 'end_turn' })
        response.frame.ticket.finish([
          { value: { kind: 'disposition', status: 'ignored' } },
        ])
        await response.frame.ticket.committed
        const pid = connection.process.child.pid!
        await connection.close()
        expect(writerClosed).toBe(true)
        await expectStopped(pid)
        const rows = (await readFile(report, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        const received = rows
          .filter((row) => row.event === 'received')
          .map((row) => row.frame)
        if (scenario === 'permission') {
          expect(requestIds).toHaveLength(1)
          expect(typeof requestIds[0]).toBe('number')
          expect(received).toContainEqual({
            jsonrpc: '2.0',
            id: requestIds[0],
            result: {
              outcome: { outcome: 'selected', optionId: 'allow-once' },
            },
          })
        } else {
          expect(received.some((frame) => frame.method === 'session/new')).toBe(
            false,
          )
        }
        const allRecords = transactions.flatMap(
          (transaction) => transaction.records,
        )
        const ordinals = [
          ...new Set(allRecords.map((record) => record.admissionOrdinal)),
        ]
        expect(ordinals).toEqual(
          Array.from({ length: ordinals.length }, (_, i) => i + 1),
        )
        expect(failures).toEqual([])
      } finally {
        await connection?.close()
        await rm(directory, { recursive: true, force: true })
      }
    },
    15000,
  )
})
