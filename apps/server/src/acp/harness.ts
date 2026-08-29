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
      return handle(client, normalizer, id, models(response), session)
    },
    async newSession(session, onItem, onExit) {
      const { client, normalizer } = await createClient(session, onItem, onExit)
      const response = await client.newSession(session.cwd)
      const id = providerId(response)
      if (!id) throw new Error('ACP newSession did not return a session id')
      saveProviderSession(deps.db, session.id, id)
      return {
        handle: handle(client, normalizer, id, models(response), session),
        proven: true,
        availableModels: models(response),
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
      return {
        handle: handle(client, normalizer, id, models(response), session),
        proven: true,
        availableModels: models(response),
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
      return {
        handle: handle(client, normalizer, id, models(response), session),
        proven: true,
        providerSessionId: id,
        availableModels: models(response),
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
      if (entry.name !== 'claude' || !deps.accountId) return
      const account = deps.db
        .prepare('SELECT home_path FROM harness_accounts WHERE id = ?')
        .get(deps.accountId) as { home_path?: unknown } | undefined
      if (typeof account?.home_path !== 'string' || !session.cwd) return
      const row = deps.db
        .prepare('SELECT model FROM sessions WHERE id = ?')
        .get(session.id) as { model?: unknown } | undefined
      const usage = readClaudeContextUsage({
        homePath: account.home_path,
        cwd: session.cwd,
        providerSessionId: sessionId ?? '',
        model: typeof row?.model === 'string' ? row.model : null,
      })
      if (usage)
        deps.bus.publishEphemeral({
          type: 'contextWindow',
          seq: null,
          sessionId: session.id,
          usage,
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
