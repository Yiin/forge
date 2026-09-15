import type { HarnessConfig } from '@forge/protocol/config'
import type { HarnessAccount } from '@forge/protocol/accounts'
import type { DatabaseSync } from 'node:sqlite'
import type { EventBus } from '../events/bus.js'
import { realpath } from 'node:fs/promises'
import { deriveAccountHarness } from '../accounts/store.js'
import type { HarnessAdapter, HarnessSession } from '../harnesses/types.js'
import { NativeCleanupError } from '../harnesses/native-cleanup.js'
import { createTypedAcpAdapter } from '../harnesses/acp/runtime.js'
import { captureLaunch, type AcpProfile } from '../harnesses/acp/profiles.js'
import type { AcpResourceHost } from '../harnesses/acp/limits.js'
import { immutableData } from '../harnesses/acp/data.js'
import type { createNativeResources } from './native-factory.js'
import type { createNativeAttachmentLoader } from '../uploads/native.js'
import {
  createProductionAcpServices,
  createAcpAttachmentResolver,
} from './acp-services.js'
import { createAcpStorage } from './acp-storage.js'
import type { AcpChildHistory } from '../harnesses/acp/children.js'

const profiles: Record<string, AcpProfile> = {
  grok: 'grok',
  gemini: 'gemini',
  devin: 'devin',
  hermes: 'hermes',
}
export function productionAcpProfile(
  key: string,
  entry: HarnessConfig,
): AcpProfile {
  return entry.adapterKind === 'custom'
    ? 'custom-acp'
    : (profiles[key] ?? 'custom-acp')
}
export function createProductionAcpAdapter(
  key: string,
  options: {
    entry: HarnessConfig
    account?: HarnessAccount
    db: DatabaseSync
    bus?: EventBus
    host: AcpResourceHost
    resources: ReturnType<typeof createNativeResources>
    loadAttachment: ReturnType<typeof createNativeAttachmentLoader>
  },
): HarnessAdapter {
  const entry = immutableData(options.entry)
  const account = options.account ? immutableData(options.account) : undefined
  const profile = productionAcpProfile(key, entry)
  if (
    !entry.enabled ||
    entry.protocol !== 'acp' ||
    entry.adapterKind === 'native'
  )
    throw Error('ACP provider is not enabled')
  if (
    account &&
    (account.harnessKey !== key ||
      account.disabledAt !== null ||
      (account.adapterKind !== undefined &&
        account.adapterKind !== 'acp' &&
        account.adapterKind !== 'custom') ||
      account.kind !== profile)
  )
    throw Error('ACP selected account does not match provider')
  const configured = account ? deriveAccountHarness(entry, account) : entry
  const launch = captureLaunch(profile, {
    providerInstanceId: key,
    account: account
      ? {
          kind: 'selected-account',
          accountId: account.id,
          home: account.homePath,
        }
      : { kind: 'native-default', configurationId: key },
    command: configured.command,
    args: configured.args,
    env: configured.env,
  })
  const open = async (
    input: HarnessSession,
    emit: Parameters<HarnessAdapter['spawn']>[1],
    load: boolean,
  ) => {
    const session = immutableData(input)
    if (session.provider !== key || session.accountId !== (account?.id ?? null))
      throw Error('ACP session account mismatch')
    const startup = options.resources.reserveStartup()
    try {
      if ((await realpath(session.cwd)) !== session.cwd)
        throw Error('ACP workspace must be canonical')
      startup.assertOpen()
      const storage = createAcpStorage(options.db, session, options.bus)
      const adapter = createTypedAcpAdapter({
        profile,
        launch,
        host: options.host,
        ingestion: storage.ingestion,
        contentStore: storage.contentStore,
        childHistory: load
          ? storage.authority.get<AcpChildHistory>('acp-child-history')
          : undefined,
        async saveChildHistory(owner, history) {
          if (
            owner.id !== session.id ||
            owner.provider !== session.provider ||
            owner.accountId !== session.accountId
          )
            throw Error('ACP child history owner changed')
          storage.authority.put('acp-child-history', history)
        },
        authorizedAttachment: createAcpAttachmentResolver(
          options.loadAttachment,
        ),
        grokRail: profile === 'grok' ? 'public' : undefined,
        services: createProductionAcpServices({
          host: options.host,
          instanceId: key,
          // Tool subprocesses receive the server environment, without provider account overrides.
          approvedEnv: approvedToolEnvironment(),
        }),
        broker: {
          admit(input) {
            const captured = immutableData(input)
            storage.authority.record(
              `acp-request:${captured.owner.runtimeGeneration}:${captured.request.requestId}`,
              captured,
            )
            let retired = false
            return {
              retire() {
                if (retired) return
                storage.authority.put(
                  `acp-request-retired:${captured.owner.runtimeGeneration}:${captured.request.requestId}`,
                  true,
                )
                retired = true
              },
            }
          },
        },
        failure() {
          // Full native error objects can contain credentials. Journal records retain causal evidence.
          console.warn('ACP provider reported a runtime failure')
        },
      })
      startup.assertOpen()
      const handle = await (load ? adapter.load! : adapter.spawn)(session, emit)
      try {
        startup.assertOpen()
        return handle
      } catch (error) {
        try {
          await handle.kill()
        } catch {
          startup.retain(handle)
          throw new NativeCleanupError(async () => {
            await handle.kill()
          })
        }
        throw error
      }
    } catch (error) {
      if (error instanceof NativeCleanupError)
        startup.retain({ kill: () => error.retryCleanup() })
      throw error
    } finally {
      startup.release()
    }
  }
  return {
    kind: 'native',
    capabilities: {
      loadSession: profile !== 'gemini',
      cancel: true,
      models: true,
      steer: false,
      queue: true,
      questions: profile === 'grok',
      permissions: true,
    },
    spawn: (session, emit) => open(session, emit, false),
    ...(profile === 'gemini'
      ? {}
      : {
          load: (
            session: HarnessSession,
            emit: Parameters<HarnessAdapter['spawn']>[1],
          ) => open(session, emit, true),
        }),
  }
}

function approvedToolEnvironment(): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {}
  for (const key of [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'TERM',
    'TMPDIR',
  ])
    if (process.env[key] !== undefined) result[key] = process.env[key]
  return result
}
