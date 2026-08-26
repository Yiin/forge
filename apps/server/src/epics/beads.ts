import { watch, type FSWatcher } from 'node:fs'
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Bead, type Bead as BeadType } from '@forge/protocol/beads'
import { EventBus } from '../events/bus.js'

export class BdNotInstalledError extends Error {
  constructor() {
    super('bd is not installed or could not be started')
    this.name = 'BdNotInstalledError'
  }
}

export class BdCommandError extends Error {
  constructor(
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`bd exited with code ${exitCode}: ${stderr.trim()}`)
    this.name = 'BdCommandError'
  }
}

export class BdParseError extends Error {
  constructor(readonly rawStdout: string) {
    super(`bd returned invalid JSON: ${rawStdout}`)
    this.name = 'BdParseError'
  }
}

async function runBd(repoPath: string, args: string[]): Promise<string> {
  type BunProcess = {
    stdout: ReadableStream<Uint8Array>
    stderr: ReadableStream<Uint8Array>
    exited: Promise<number>
  }
  const bun = (
    globalThis as typeof globalThis & {
      Bun: {
        spawn(
          command: string[],
          options: { cwd: string; stdout: 'pipe'; stderr: 'pipe' },
        ): BunProcess
      }
    }
  ).Bun
  if (!bun) {
    return new Promise((resolve, reject) => {
      const child = nodeSpawn('bd', args, {
        cwd: repoPath,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', () => reject(new BdNotInstalledError()))
      child.on('close', (exitCode) => {
        if (exitCode !== 0) reject(new BdCommandError(exitCode ?? 1, stderr))
        else resolve(stdout)
      })
    })
  }
  let process: BunProcess
  try {
    process = bun.spawn(['bd', ...args], {
      cwd: repoPath,
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    throw new BdNotInstalledError()
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) throw new BdCommandError(exitCode, stderr)
  return stdout
}

function parseJson<T>(stdout: string, schema: { parse(value: unknown): T }): T {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new BdParseError(stdout)
  }
  try {
    return schema.parse(value)
  } catch {
    throw new BdParseError(stdout)
  }
}

function beadSchema() {
  return Bead
}

function normalizeBead(value: unknown): BeadType {
  if (typeof value !== 'object' || value === null)
    throw new BdParseError(JSON.stringify(value))
  const raw = value as Record<string, unknown>
  const dependencies = Array.isArray(raw.dependencies)
    ? raw.dependencies.flatMap((dependency) => {
        if (typeof dependency !== 'object' || dependency === null) return []
        const item = dependency as Record<string, unknown>
        const id = typeof item.id === 'string' ? item.id : ''
        const dependsOnId =
          typeof item.depends_on_id === 'string' ? item.depends_on_id : ''
        const type = typeof item.type === 'string' ? item.type : ''
        return id && dependsOnId && type ? [{ id, dependsOnId, type }] : []
      })
    : []
  return beadSchema().parse({
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    status: typeof raw.status === 'string' ? raw.status : '',
    priority: raw.priority,
    labels: Array.isArray(raw.labels)
      ? raw.labels.filter((label): label is string => typeof label === 'string')
      : [],
    dependencies,
  })
}

function parseBeads(stdout: string): BeadType[] {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new BdParseError(stdout)
  }
  if (!Array.isArray(value)) throw new BdParseError(stdout)
  try {
    return value.map(normalizeBead)
  } catch {
    throw new BdParseError(stdout)
  }
}

export async function readyChildren(
  repoPath: string,
  epicId: string,
): Promise<BeadType[]> {
  return parseBeads(
    await runBd(repoPath, ['ready', '--parent', epicId, '--json']),
  )
}

export async function show(repoPath: string, id: string): Promise<BeadType> {
  return parseJson(await runBd(repoPath, ['show', id, '--json']), {
    parse: (v) => {
      if (!Array.isArray(v) || v.length !== 1)
        throw new Error('expected one bead')
      return normalizeBead(v[0])
    },
  })
}

export async function openChildren(
  repoPath: string,
  epicId: string,
): Promise<BeadType[]> {
  return parseBeads(
    await runBd(repoPath, [
      'list',
      '--parent',
      epicId,
      '--status',
      'open',
      '--json',
    ]),
  )
}

export async function claim(repoPath: string, id: string): Promise<void> {
  await runBd(repoPath, ['update', id, '--claim'])
}

export async function releaseClaim(
  repoPath: string,
  id: string,
): Promise<void> {
  await runBd(repoPath, ['update', id, '--status', 'open'])
}

export async function close(
  repoPath: string,
  id: string,
  note?: string,
): Promise<void> {
  const args = ['close', id]
  if (note) args.push('--reason', note)
  await runBd(repoPath, args)
}

export async function comment(
  repoPath: string,
  id: string,
  text: string,
): Promise<void> {
  await runBd(repoPath, ['comment', id, text])
}

export async function hasCommentSince(
  repoPath: string,
  id: string,
  isoTs: string,
): Promise<boolean> {
  const comments = parseJson(
    await runBd(repoPath, ['comments', id, '--json']),
    {
      parse: (value) => {
        if (!Array.isArray(value)) throw new Error('expected comments')
        return value
      },
    },
  )
  const since = Date.parse(isoTs)
  return comments.some((entry) => {
    if (typeof entry !== 'object' || entry === null) return false
    const record = entry as Record<string, unknown>
    const created = record.created_at ?? record.createdAt
    return typeof created === 'string' && Date.parse(created) >= since
  })
}

export function watchBeads(
  repoPath: string,
  onChange: () => void,
  bus = new EventBus(),
): () => void {
  const target = join(repoPath, '.beads', 'last-touched')
  let watcher: FSWatcher | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let rearmTimer: ReturnType<typeof setTimeout> | undefined

  const emit = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (stopped) return
      onChange()
      bus.publish({ type: 'beadsChanged', seq: null, repoPath })
    }, 500)
  }
  const arm = () => {
    if (stopped) return
    try {
      watcher = watch(target, (eventType) => {
        if (eventType === 'rename') {
          watcher?.close()
          watcher = undefined
          if (!rearmTimer)
            rearmTimer = setTimeout(() => {
              rearmTimer = undefined
              arm()
            }, 50)
        }
        emit()
      })
    } catch {
      rearmTimer = setTimeout(() => {
        rearmTimer = undefined
        arm()
      }, 100)
    }
  }
  void mkdir(join(repoPath, '.beads'), { recursive: true })
    .then(() => stat(target).catch(() => undefined))
    .then(arm)
  return () => {
    stopped = true
    watcher?.close()
    if (timer) clearTimeout(timer)
    if (rearmTimer) clearTimeout(rearmTimer)
  }
}
