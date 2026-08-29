import type { HarnessConfig } from '@forge/protocol/config'
import { getHarnessCapabilities } from '../config.js'
import { createAcpServices } from './services.js'
import { spawnAcpClient, type AcpClient } from './client.js'
import { AcpNormalizer } from './normalize.js'
import type { QuestionManager } from './questions.js'
import type {
  HarnessHandle,
  HarnessItem,
  HarnessModel,
  HarnessProcess,
  HarnessSession,
} from '../sessions/harness.js'
import type { EventBus } from '../events/bus.js'
import { readClaudeContextUsage } from '../accounts/context/claudeTranscript.js'
import { readCodexRollout } from '../accounts/context/codexRollout.js'
import { recordUsageSnapshot } from '../accounts/usage.js'
import { writeAccountModels } from '../accounts/models.js'

type Db = {
  exec(sql: string): unknown
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    run(...params: unknown[]): unknown
  }
}

export type AcpHarnessDeps = {
  db: Db
  bus: EventBus
  questions: QuestionManager
  accountId?: string | null
}

const providerId = (response: { sessionId?: unknown }) =>
  typeof response.sessionId === 'string' && response.sessionId.length > 0
    ? response.sessionId
    : undefined

export function acpHarness(
  entry: HarnessConfig,
  deps: AcpHarnessDeps,
): HarnessProcess {
  const rememberCatalog = (models: HarnessModel[]) => {
    if (!deps.accountId || !models.length) return
    writeAccountModels(deps.db, {
      accountId: deps.accountId,
      harnessKey: entry.name,
      models,
      source: 'acp',
      updatedAt: Date.now(),
    })
  }
  const stored = getHarnessCapabilities(deps.db as never, entry.name)
  const capabilities = stored?.capabilities as
    Record<string, unknown> | undefined
  const process: HarnessProcess = {
    capabilities: {
      loadSession: capabilities?.loadSession === true,
      sessionFork: capabilities?.sessionFork === true,
    },
    async spawn(session, onItem, onExit) {
      const { client, normalizer } = await createClient(session, onItem, onExit)
      const response = await client.newSession(session.cwd)
      const id = providerId(response)
      if (!id) throw new Error('ACP newSession did not return a session id')
      saveProviderSession(deps.db, session.id, id)
      const available = models(response)
      rememberCatalog(available)
      return handle(client, normalizer, id, available, session)
    },
    async newSession(session, onItem, onExit) {
      const { client, normalizer } = await createClient(session, onItem, onExit)
      const response = await client.newSession(session.cwd)
      const id = providerId(response)
      if (!id) throw new Error('ACP newSession did not return a session id')
      saveProviderSession(deps.db, session.id, id)
      const available = models(response)
      rememberCatalog(available)
      return {
        handle: handle(client, normalizer, id, available, session),
        proven: true,
        availableModels: available,
      }
    },
    async loadSession(session, onItem, onExit) {
      if (!session.providerSessionId)
        return { handle: emptyHandle(), proven: false }
      const { client, normalizer } = await createClient(session, onItem, onExit)
      const response = await client.loadSession(
        session.providerSessionId,
        session.cwd,
      )
      const id = session.providerSessionId
      if (!id)
        return {
          handle: handle(
            client,
            normalizer,
            session.providerSessionId,
            models(response),
            session,
          ),
          proven: false,
        }
      saveProviderSession(deps.db, session.id, id)
      const available = models(response)
      rememberCatalog(available)
      return {
        handle: handle(client, normalizer, id, available, session),
        proven: true,
        availableModels: available,
      }
    },
    async fork(session, onItem, onExit) {
      if (!session.providerSessionId)
        return { handle: emptyHandle(), proven: false }
      const { client, normalizer } = await createClient(session, onItem, onExit)
      const response = await client.fork(session.providerSessionId, session.cwd)
      const id = providerId(response)
      if (!id)
        return {
          handle: handle(
            client,
            normalizer,
            session.providerSessionId,
            models(response),
            session,
          ),
          proven: false,
        }
      saveProviderSession(deps.db, session.id, id)
      const available = models(response)
      rememberCatalog(available)
      return {
        handle: handle(client, normalizer, id, available, session),
        proven: true,
        providerSessionId: id,
        availableModels: available,
      }
    },
  }

  async function createClient(
    session: HarnessSession,
    onItem: (item: HarnessItem) => void,
    onExit: (error?: Error) => void,
  ) {
    const normalizer = new AcpNormalizer({
      db: deps.db,
      bus: deps.bus,
      sink: (input) =>
        onItem({
          ...(input.content as HarnessItem),
          itemId: input.itemId,
          turnId: input.turnId,
        }),
    })
    const services = createAcpServices({
      cwd: session.cwd,
      projectRoot: session.cwd,
      questionManager: deps.questions,
    })
    const client = await spawnAcpClient(entry, {
      ...services,
      cwd: session.cwd,
      onSessionUpdate: (notification) => normalizer.handle(notification),
      capabilityStore: {
        db: deps.db,
        harnessKey: entry.name,
        accountId: deps.accountId,
      },
      onExit: (error) => {
        normalizer.processDied(session.id, error)
        onExit(error)
      },
    })
    return { client, normalizer }
  }

  function handle(
    client: AcpClient,
    normalizer: AcpNormalizer,
    sessionId: string | null | undefined,
    availableModels: HarnessModel[] = [],
    session: HarnessSession,
  ): HarnessHandle {
    const publishContextWindow = () => {
      if (
        !deps.accountId ||
        (entry.name !== 'claude' && entry.name !== 'codex')
      )
        return
      const account = deps.db
        .prepare('SELECT home_path FROM harness_accounts WHERE id = ?')
        .get(deps.accountId) as { home_path?: unknown } | undefined
      if (typeof account?.home_path !== 'string' || !session.cwd) return
      const row = deps.db
        .prepare('SELECT model FROM sessions WHERE id = ?')
        .get(session.id) as { model?: unknown } | undefined
      const result =
        entry.name === 'claude'
          ? {
              usage: readClaudeContextUsage({
                homePath: account.home_path,
                cwd: session.cwd,
                providerSessionId: sessionId ?? '',
                model: typeof row?.model === 'string' ? row.model : null,
              }),
            }
          : readCodexRollout({
              homePath: account.home_path,
              cwd: session.cwd,
              providerSessionId: sessionId ?? null,
            })
      if (result?.rateLimits) {
        const windows = [result.rateLimits.primary, result.rateLimits.secondary]
          .filter(
            (
              window,
            ): window is {
              used_percent: number
              window_minutes: number
              resets_at?: unknown
            } =>
              window != null &&
              typeof window.used_percent === 'number' &&
              typeof window.window_minutes === 'number',
          )
          .map((window) => {
            const minutes = window.window_minutes as number
            const weekly = minutes === 10080
            const hours = minutes / 60
            return {
              windowKey: weekly
                ? 'weekly-7d'
                : Number.isInteger(hours)
                  ? `${hours}h`
                  : `${minutes}m`,
              label: weekly
                ? 'Weekly (7-day)'
                : Number.isInteger(hours)
                  ? `${hours}h window`
                  : `${minutes}m window`,
              percent:
                Math.max(0, Math.min(100, window.used_percent as number)) / 100,
              resetsAt:
                typeof window.resets_at === 'number'
                  ? window.resets_at * 1000
                  : null,
              source: 'codex.rollout',
            }
          })
        if (windows.length)
          recordUsageSnapshot(deps.db, deps.accountId, windows)
      }
      if (result?.usage)
        deps.bus.publishEphemeral({
          type: 'contextWindow',
          seq: null,
          sessionId: session.id,
          usage: result.usage,
        })
    }
    return {
      availableModels,
      prompt: async (content) => {
        await normalizer.promptTurn(client, sessionId ?? '', [
          { type: 'text', text: content },
        ])
        publishContextWindow()
      },
      cancel: () => client.cancel(sessionId ?? ''),
      setModel: async (modelId) => {
        await client.setModel(sessionId ?? '', modelId)
      },
      configOptions: () => client.configOptions(sessionId ?? ''),
      setConfigOption: async (configId, value) => {
        await client.setConfigOption(sessionId ?? '', configId, value)
      },
      kill: () => client.kill(),
    }
  }

  return process
}

function models(response: {
  models?: { availableModels?: Array<{ modelId: string; name: string }> } | null
}): HarnessModel[] {
  return (response.models?.availableModels ?? []).map((model) => ({
    id: model.modelId,
    displayName: model.name,
  }))
}

function saveProviderSession(
  db: Db,
  sessionId: string,
  providerSessionId: string,
) {
  db.prepare('UPDATE sessions SET provider_session_id = ? WHERE id = ?').run(
    providerSessionId,
    sessionId,
  )
}

function emptyHandle(): HarnessHandle {
  return {
    prompt: () => undefined,
    cancel: () => undefined,
    kill: () => undefined,
  }
}
