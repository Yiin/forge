import { createHash } from 'node:crypto'
import { appendMessage } from '../db/queries.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export type FailureClassification = 'code' | 'infra' | 'unknown'
export type FailureEntry = {
  attempt: number
  signature: string
  excerpt: string
}
export type GateResult = { code: number; output: string }
export type TriageCard = {
  kind: 'epic_triage'
  runId: string
  beadId: string
  attempts: number
  classification: FailureClassification
  failureChain: FailureEntry[]
}
const dependencyPattern =
  /(cannot find module|module not found|node_modules|native binding|\.node\b|bun install|npm install)/i
const exec = promisify(execFile)

export function normalizeFailure(value: string, root = '') {
  return value
    .replace(/\b\d{4}-\d\d-\d\d[T ][^\s]+/g, '<timestamp>')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/gi, '<duration>')
    .replaceAll(root, '<worktree>')
    .replace(/\/[^\s:'"]+/g, '<path>')
    .trim()
}
export function failureSignature(value: string, root = '') {
  return createHash('sha256')
    .update(normalizeFailure(value, root))
    .digest('hex')
}
export function isDependencyFailure(value: string) {
  return dependencyPattern.test(value)
}
export function classifyGate(
  branch: GateResult,
  control: GateResult,
): FailureClassification {
  if (branch.code === 0 || control.code === 0)
    return branch.code === 0 ? 'code' : 'code'
  return normalizeFailure(branch.output) === normalizeFailure(control.output)
    ? 'infra'
    : 'unknown'
}
export function readSignatures(
  config: unknown,
  beadId: string,
): FailureEntry[] {
  const value = config as {
    failureSignatures?: Record<string, FailureEntry[]>
  } | null
  return value?.failureSignatures?.[beadId] ?? []
}
export function rememberSignature(
  config: unknown,
  beadId: string,
  entry: FailureEntry,
) {
  const value = (
    config && typeof config === 'object' ? { ...(config as object) } : {}
  ) as { failureSignatures?: Record<string, FailureEntry[]> }
  value.failureSignatures = { ...(value.failureSignatures ?? {}) }
  value.failureSignatures[beadId] = [
    ...(value.failureSignatures[beadId] ?? []),
    entry,
  ]
  return value
}
export function triageCard(input: Omit<TriageCard, 'kind'>): TriageCard {
  return { kind: 'epic_triage', ...input }
}

export async function retryFlakyGate(
  branch: GateResult,
  control: GateResult,
  retry: () => Promise<GateResult>,
) {
  if (branch.code === 0 || control.code !== 0) return undefined
  return retry()
}

export function appendTriageCard(db: any, sessionId: string, card: TriageCard) {
  return appendMessage(db, {
    sessionId,
    turnId: `triage_${card.runId}`,
    itemId: `triage_${card.runId}_${card.beadId}_${Date.now()}`,
    role: 'system',
    type: 'epic_triage',
    content: card,
  })
}
export async function runGate(
  cwd: string,
  command: string | string[],
): Promise<GateResult> {
  const args = Array.isArray(command) ? command : command.trim().split(/\s+/)
  if (!args.length || !args[0]) return { code: 0, output: '' }
  try {
    const result = await exec(args[0], args.slice(1), {
      cwd,
      maxBuffer: 512 * 1024,
    })
    return { code: 0, output: `${result.stdout}${result.stderr}` }
  } catch (error) {
    const value = error as {
      code?: number | string
      stdout?: string
      stderr?: string
      message?: string
    }
    return {
      code: Number(value.code) || 1,
      output: `${value.stdout ?? ''}${value.stderr ?? value.message ?? ''}`,
    }
  }
}
