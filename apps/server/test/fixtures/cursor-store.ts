import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LocalAgentStore } from '@cursor/sdk'
const names = {
  agents: 'agents.ndjson',
  runs: 'runs.ndjson',
  checkpoints: 'checkpoints.ndjson',
  runEvents: 'run_events.ndjson',
} as const
type Row = Record<string, any>
/** Source-shaped disposable JSONL peer. It never imports or executes the SDK. */
export class CursorFixtureStore implements LocalAgentStore {
  agents: LocalAgentStore['agents']
  runs: LocalAgentStore['runs']
  checkpoints: LocalAgentStore['checkpoints']
  runEvents: LocalAgentStore['runEvents']
  beforeWrite?: (surface: string) => Promise<void>
  writes: string[] = []
  constructor(readonly directory: string) {
    const surface = (name: keyof typeof names) => {
      const read = async (): Promise<Row[]> => {
        const text = await readFile(join(directory, names[name]), 'utf8').catch(
          (error) => {
            if (error.code === 'ENOENT') return ''
            throw error
          },
        )
        return text.trim()
          ? text
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line))
          : []
      }
      const write = async (rows: Row[]) => {
        await this.beforeWrite?.(name)
        this.writes.push(name)
        await writeFile(
          join(directory, names[name]),
          rows.map((row) => JSON.stringify(row) + '\n').join(''),
        )
      }
      const key = (row: Row) =>
        name === 'agents'
          ? row.agentId
          : name === 'runs'
            ? `${row.agentId}:${row.runId}`
            : `${row.agentId}:${row.blobId}`
      const matches = (row: Row, filter: Row = {}) =>
        (!filter.agentIds?.length || filter.agentIds.includes(row.agentId)) &&
        (!filter.runIds?.length || filter.runIds.includes(row.runId)) &&
        (!filter.blobIds?.length || filter.blobIds.includes(row.blobId)) &&
        (filter.cwd === undefined || row.cwd === filter.cwd)
      const api = {
        get: async (input: Row) => {
          const row = (await read()).find((row) => key(row) === key(input))
          return row
            ? name === 'checkpoints'
              ? Buffer.from(row.dataBase64, 'base64')
              : structuredClone(row)
            : null
        },
        list: async (input?: Row) => {
          let rows = (await read()).filter((row) => matches(row, input?.filter))
          if (name === 'runEvents')
            rows = rows.filter(
              (row) =>
                row.runId === input?.runId &&
                row.seq > Number(input?.afterOffset ?? 0),
            )
          return {
            items: rows.map((row) =>
              name === 'checkpoints' ? row.blobId : structuredClone(row),
            ),
          }
        },
        create: async (input: Row) => {
          const row =
            name === 'checkpoints'
              ? {
                  agentId: input.agentId,
                  blobId: input.blobId,
                  dataBase64: Buffer.from(input.data).toString('base64'),
                }
              : structuredClone(input.agent ?? input.run)
          const rows = await read()
          if (rows.some((value) => key(value) === key(row)))
            throw new Error('duplicate')
          rows.push(row)
          await write(rows)
          return name === 'checkpoints' ? undefined : structuredClone(row)
        },
        update: async (input: Row) => {
          const row =
            name === 'checkpoints'
              ? {
                  agentId: input.agentId,
                  blobId: input.blobId,
                  dataBase64: Buffer.from(input.data).toString('base64'),
                }
              : structuredClone(input.agent ?? input.run)
          const rows = await read(),
            index = rows.findIndex((value) => key(value) === key(row))
          if (index < 0) throw new Error('missing')
          rows[index] = row
          await write(rows)
          return name === 'checkpoints' ? undefined : structuredClone(row)
        },
        delete: async (input: Row) => {
          const rows = await read(),
            deleted = rows.filter((row) => matches(row, input.filter))
          await write(rows.filter((row) => !matches(row, input.filter)))
          if (name === 'runs')
            for (const row of deleted)
              await this.runEvents.delete({ filter: { runIds: [row.runId] } })
        },
        append: async (input: Row) => {
          const rows = await read(),
            old =
              input.idempotencyKey &&
              rows.find(
                (row) =>
                  row.runId === input.runId &&
                  row.idempotencyKey === input.idempotencyKey,
              )
          if (old) return old
          const seq =
            rows
              .filter((row) => row.runId === input.runId)
              .reduce((max, row) => Math.max(max, row.seq), 0) + 1
          const row = {
            runId: input.runId,
            seq,
            offset: String(seq),
            eventType: input.eventType,
            payload: input.payload ?? null,
            payloadRef: input.payloadRef ?? null,
            idempotencyKey: input.idempotencyKey ?? null,
            createdAt: new Date().toISOString(),
          }
          rows.push(row)
          await write(rows)
          return { ...row, createdAt: Date.parse(row.createdAt) }
        },
      }
      return api
    }
    this.agents = surface('agents') as unknown as LocalAgentStore['agents']
    this.runs = surface('runs') as unknown as LocalAgentStore['runs']
    this.checkpoints = surface(
      'checkpoints',
    ) as unknown as LocalAgentStore['checkpoints']
    this.runEvents = surface(
      'runEvents',
    ) as unknown as LocalAgentStore['runEvents']
  }
}
