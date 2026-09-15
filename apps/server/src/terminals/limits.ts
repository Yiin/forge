// Bounds include complete JSON envelopes. NUL requires six bytes when encoded;
// quotes require two and remain valid in a terminal title.
const maxSequence = Number.MAX_SAFE_INTEGER
const maxEpoch = 'ffffffff-ffff-4fff-bfff-ffffffffffff'
const maxId = `${maxEpoch}.${maxEpoch}`
const maxIdentifier = '\u0000'.repeat(256)
const maxPath = '\u0000'.repeat(4096)
const maxTimestamp = '9999-12-31T23:59:59.999Z'
export const MAX_FINAL_EVENT_BYTES = Buffer.byteLength(
  JSON.stringify({
    type: 'exit',
    terminalId: maxId,
    seq: maxSequence,
    exitCode: maxSequence,
    signal: maxSequence,
    outputComplete: false,
    cleanup: 'complete',
    reason: 'a'.repeat(128),
  }),
)
export const MAX_SNAPSHOT_EVENT_BYTES = Buffer.byteLength(
  JSON.stringify({
    type: 'snapshot',
    descriptor: {
      id: maxId,
      serverEpoch: maxEpoch,
      sessionId: maxIdentifier,
      projectId: maxIdentifier,
      workspace: {
        target: { kind: 'session', sessionId: maxIdentifier },
        projectId: maxIdentifier,
        cwd: maxPath,
        worktreePath: maxPath,
        workspaceId: '\u0000'.repeat(128),
        workspaceRevision: maxSequence,
      },
      title: '"'.repeat(256),
      shell: maxIdentifier,
      cols: 500,
      rows: 300,
      state: 'unavailable',
      createdAt: maxTimestamp,
      lastActivityAt: maxTimestamp,
      exitedAt: maxTimestamp,
      expiresAt: maxTimestamp,
      firstRetainedSeq: maxSequence,
      lastSeq: maxSequence,
      exitCode: maxSequence,
      signal: maxSequence,
      outputComplete: false,
      cleanup: 'complete',
    },
    requestedAfterSeq: maxSequence,
    firstRetainedSeq: maxSequence,
    lastSeq: maxSequence,
    replayGap: { fromSeq: maxSequence, toSeq: maxSequence, reason: 'evicted' },
  }),
)
export function maximumDataEventBytes(rawBytes: number) {
  return (
    Buffer.byteLength(
      JSON.stringify({
        type: 'data',
        terminalId: maxId,
        seq: maxSequence,
        data: '',
      }),
    ) +
    Math.ceil(rawBytes / 3) * 4
  )
}
export const terminalLimits = Object.freeze({
  terminals: 32,
  startups: 4,
  removals: 4,
  inspections: 4,
  http: 32,
  inputBytes: 65536,
  inputBodyBytes: 98304,
  bodyBytes: 8192,
  inputItems: 4,
  inputQueueBytes: 262144,
  hostInputBytes: 4194304,
  syscallBytes: 8192,
  terminalTickBytes: 65536,
  hostTickBytes: 262144,
  inputDeadlineMs: 5000,
  inputRetryMs: 5,
  batchBytes: 65536,
  batchMs: 12,
  replayBytes: 1048576,
  replayEvents: 4096,
  subscriptions: 4,
  hostSubscriptions: 64,
  subscriptionBytes: 262144,
  subscriptionEvents: 8,
  hostSubscriptionBytes: 16777216,
  writeDeadlineMs: 5000,
  socketCloseMs: 1000,
  requestDeadlineMs: 6000,
  startupDeadlineMs: 6000,
  cleanupDeadlineMs: 5000,
  termGraceMs: 1000,
  scanRounds: 8,
  scanEntries: 65536,
  scanBytes: 268435456,
  statBytes: 4096,
  members: 256,
  exitedTtlMs: 1800000,
  shutdownCallbacks: 32,
})
export type TerminalLimits = typeof terminalLimits
export type TerminalLimitValues = { [K in keyof TerminalLimits]: number }
export function resolveTerminalLimits(
  overrides: Partial<TerminalLimitValues> = {},
): Readonly<TerminalLimitValues> {
  const value = { ...terminalLimits, ...overrides }
  for (const [key, limit] of Object.entries(value)) {
    if (
      !(key in terminalLimits) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > terminalLimits[key as keyof TerminalLimits]
    )
      throw new RangeError(`Invalid terminal limit: ${key}`)
  }
  const eventBytes = maximumDataEventBytes(value.batchBytes)
  if (
    value.replayEvents < 2 ||
    value.replayBytes < eventBytes + MAX_FINAL_EVENT_BYTES ||
    value.subscriptionBytes <
      Math.max(eventBytes, MAX_FINAL_EVENT_BYTES, MAX_SNAPSHOT_EVENT_BYTES) ||
    value.hostSubscriptionBytes < value.subscriptionBytes ||
    value.inputQueueBytes < value.inputBytes ||
    value.hostInputBytes < value.inputQueueBytes ||
    value.terminalTickBytes < value.syscallBytes ||
    value.hostTickBytes < value.terminalTickBytes ||
    value.inputBodyBytes < Math.ceil(value.inputBytes / 3) * 4 + 32 ||
    value.termGraceMs > value.cleanupDeadlineMs
  )
    throw new RangeError('Terminal limits do not fit their payloads')
  return Object.freeze(value)
}
