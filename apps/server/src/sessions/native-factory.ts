import { createHash, randomUUID } from 'node:crypto'
import { realpath, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { DatabaseSync } from 'node:sqlite'
import type { HarnessConfig } from '@forge/protocol/config'
import type { HarnessAccount } from '@forge/protocol/accounts'
import type {
  HarnessAdapter,
  HarnessSession,
  HarnessHandle,
} from '../harnesses/types.js'
import { createClaudeAdapter } from '../harnesses/claude/index.js'
import type { LoadAttachment } from '../harnesses/claude/input.js'
import { createCodexAdapter } from '../harnesses/codex/index.js'
import { createOpenCodeAdapter } from '../harnesses/opencode.js'
import {
  createPiAdapter,
  type ConfirmedPiBinding,
} from '../harnesses/pi/index.js'
import { imageMime } from '../harnesses/pi/input.js'
import { modelKey } from '../harnesses/pi/session.js'
import type { KimiAttachmentSink } from '../harnesses/kimi/types.js'
import { createKimiAdapter, createKimiHost } from '../harnesses/kimi/index.js'
import {
  createCursorAdapter,
  createCursorResources,
} from '../harnesses/cursor/index.js'
import { NativeCleanupError } from '../harnesses/native-cleanup.js'
import { resolveExecutable } from '../harnesses/executable.js'
import { accountEnv, deriveAccountHarness } from '../accounts/store.js'
import type { UploadStore } from '../uploads/store.js'
import { NativeStorage } from './native-storage.js'
import { piStorage } from './native-pi-storage.js'
import { kimiStorage } from './native-kimi-storage.js'
import { cursorStorage } from './native-cursor-storage.js'
import { storeNativeMedia } from './native-media.js'

export const nativeProviders = {
  claude: 'claude',
  'claude-code': 'claude',
  'claude-code-acp': 'claude',
  codex: 'codex',
  'codex-acp': 'codex',
  pi: 'pi',
  kimi: 'kimi',
  cursor: 'cursor',
  opencode: 'opencode',
} as const
export function hasProductionNativeAdapter(key: string): boolean {
  return Object.hasOwn(nativeProviders, key)
}
export type HarnessTransport = 'native' | 'pty' | 'acp' | 'unconfigured'
export function harnessTransport(
  _key: string,
  entry: HarnessConfig | undefined,
): HarnessTransport {
  if (!entry) return 'unconfigured'
  if (entry.adapterKind === 'native') return 'native'
  if (entry.protocol === 'pty') return 'pty'
  if (entry.protocol === 'acp') return 'acp'
  return 'unconfigured'
}
export function createNativeResources() {
  const kimi = createKimiHost(),
    cursor = createCursorResources()
  const startups = new Set<{
    done: Promise<void>
    handle?: Pick<HarnessHandle, 'kill'>
  }>()
  let closed = false,
    closing: Promise<void> | undefined
  return {
    kimi,
    cursor,
    reserveStartup() {
      if (closed || startups.size >= 32)
        throw new Error('Native startup capacity unavailable')
      let resolve!: () => void
      const ticket: {
        done: Promise<void>
        handle?: Pick<HarnessHandle, 'kill'>
      } = {
        done: new Promise((end) => {
          resolve = end
        }),
      }
      startups.add(ticket)
      let finished = false
      return {
        assertOpen() {
          if (closed) throw new Error('Native startup closed')
        },
        retain(handle: Pick<HarnessHandle, 'kill'>) {
          ticket.handle = handle
        },
        release() {
          if (finished) return
          finished = true
          if (!ticket.handle) startups.delete(ticket)
          resolve()
        },
      }
    },
    close() {
      closed = true
      if (closing) return closing
      closing = (async () => {
        await Promise.all([...startups].map((ticket) => ticket.done))
        const settled = await Promise.allSettled(
          [...startups].map(async (ticket) => {
            await ticket.handle!.kill()
            startups.delete(ticket)
          }),
        )
        const failures = settled
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason)
        if (failures.length)
          throw new AggregateError(
            failures,
            'Native startup cleanup remains unresolved',
          )
        await kimi.close()
      })()
      void closing.catch(() => {
        closing = undefined
      })
      return closing
    },
  }
}
export type ProductionNativeOptions = {
  entry: HarnessConfig
  account?: HarnessAccount
  db: DatabaseSync
  dataDir: string
  uploads: UploadStore
  resources: ReturnType<typeof createNativeResources>
  loadAttachment: (
    sessionId: string,
    attachmentId: string,
    signal: AbortSignal,
  ) => Promise<Awaited<ReturnType<LoadAttachment>> & { sha256: string }>
}

/** Resolve account and workspace authority at activation, before starting native work. */
export function createProductionNativeAdapter(
  key: string,
  options: ProductionNativeOptions,
): HarnessAdapter {
  const provider = nativeProviders[key as keyof typeof nativeProviders]
  if (!provider)
    throw new Error(`Native harness ${key} has no supported provider`)
  if (!options.entry.enabled)
    throw new Error(`Native harness ${key} is disabled`)
  const entry = structuredClone(options.entry)
  const account = options.account
    ? {
        ...structuredClone(options.account),
        adapterKind: options.account.adapterKind ?? ('native' as const),
      }
    : undefined
  if (
    account &&
    (account.harnessKey !== key ||
      account.kind !== provider ||
      account.adapterKind !== 'native' ||
      account.disabledAt !== null)
  )
    throw new Error('Native account selection is invalid')
  if (provider === 'opencode' && entry.args.length)
    throw new Error(
      'OpenCode native server does not accept configured arguments',
    )
  const open = async (
    sessionInput: HarnessSession,
    emit: Parameters<HarnessAdapter['spawn']>[1],
    resume: boolean,
  ) => {
    const session = structuredClone(sessionInput)
    if (
      session.provider !== key ||
      (session.accountId ?? null) !== (account?.id ?? null)
    )
      throw new Error('Native session account mismatch')
    const startup = options.resources.reserveStartup()
    try {
      const cwd = await realpath(session.cwd)
      startup.assertOpen()
      if (cwd !== session.cwd)
        throw new Error('Native workspace must be canonical')
      const store = new NativeStorage(options.db, session)
      const savedBinding = store.get<HarnessSession['binding']>('binding')
      if (resume && savedBinding) {
        if (
          session.binding?.providerSessionId !== savedBinding.providerSessionId
        )
          throw new Error('Native saved binding mismatch')
        session.binding = savedBinding
      }
      const activation = store.activate()
      const env = {
        ...entry.env,
        ...(account ? accountEnv(provider, account.homePath) : {}),
      }
      let adapter: HarnessAdapter
      switch (provider) {
        case 'claude': {
          const derived = account ? deriveAccountHarness(entry, account) : entry
          adapter = createClaudeAdapter({
            command: derived.command,
            args: derived.args,
            env: derived.env,
            accountId: account?.id,
            loadAttachment: options.loadAttachment,
          })
          break
        }
        case 'codex':
          adapter = createCodexAdapter({
            provider: key,
            command: entry.command,
            args: entry.args,
            loadAttachment: options.loadAttachment,
            ...(account
              ? {
                  accountId: account.id,
                  env: { ...env, CODEX_HOME: account.homePath },
                  expectedCodexHome: account.homePath,
                  nativeLaunch: {
                    credentials: 'native-configured-sources' as const,
                    provider: key,
                    canonicalCwd: cwd,
                    account,
                    harness: entry,
                  },
                }
              : { accountId: null, env }),
          })
          break
        case 'opencode':
          adapter = createOpenCodeAdapter({
            provider: key,
            accountId: account?.id ?? null,
            server: {
              mode: 'owned',
              executable: entry.command,
              env,
              ...(account
                ? {
                    accountHome: account.homePath,
                    nativeLaunch: {
                      credentials: 'native-configured-sources' as const,
                      provider: key,
                      canonicalCwd: cwd,
                      account,
                      harness: entry,
                      selectedEnvOverrides: accountEnv(
                        'opencode',
                        account.homePath,
                      ),
                      credentialEnvironment: (
                        [
                          'OPENCODE_AUTH_CONTENT',
                          'CLOUDFLARE_ACCOUNT_ID',
                          'CLOUDFLARE_API_KEY',
                        ] as const
                      ).map((name) => ({
                        name,
                        value: entry.env[name],
                        accountId:
                          entry.env[name] === undefined ? null : account.id,
                      })),
                    },
                  }
                : {}),
            },
            defaults:
              account?.config?.provider && account.config.model
                ? {
                    model: `${account.config.provider}/${account.config.model}`,
                    ...(account.config.thinking
                      ? { variant: account.config.thinking }
                      : {}),
                  }
                : undefined,
            resolveAttachment: async (input) => {
              const value = await options.loadAttachment(
                input.sessionId,
                input.attachmentId,
                input.signal,
              )
              if (value.sizeBytes > input.maxBytes || value.mime !== input.mime)
                throw new Error('OpenCode attachment exceeds scope')
              return {
                attachmentId: input.attachmentId,
                mime: value.mime,
                filename: value.name,
                sizeBytes: value.sizeBytes,
                bytes: await value.readBytes(),
              }
            },
          })
          break
        case 'pi': {
          const executable = await resolveExecutable({
            command: entry.command,
            env: { ...process.env, ...env },
          })
          if (!executable) throw new Error('Pi executable is unavailable')
          adapter = createPiAdapter({
            providerId: key,
            executable,
            args: entry.args,
            env,
            launch: {
              credentials: 'native-configured-sources',
              providerId: key,
              account: account ?? null,
              harness: entry,
              canonicalCwd: cwd,
              accountHome: account?.homePath ?? join(homedir(), '.pi', 'agent'),
              selectedEnvOverrides: account
                ? accountEnv('pi', account.homePath)
                : {},
            },
            ...(resume
              ? { resume: { binding: savedBinding as ConfirmedPiBinding } }
              : {}),
            ...piStorage(store, activation),
            loadImage: async (id, attachmentId, signal) => {
              const value = await options.loadAttachment(
                id,
                attachmentId,
                signal,
              )
              return {
                mime: imageMime.parse(value.mime),
                sizeBytes: value.sizeBytes,
                sha256: value.sha256,
                readBytes: value.readBytes,
              }
            },
            persistImage: async (owner, image, signal) => {
              if (owner.forgeSessionId !== session.id)
                throw new Error('Pi image owner mismatch')
              const sha256 = createHash('sha256')
                .update(image.bytes)
                .digest('hex')
              const attachmentId = await storeNativeMedia(
                store,
                options.uploads,
                activation,
                {
                  identity: createHash('sha256')
                    .update(
                      JSON.stringify([
                        owner,
                        image.mimeType,
                        image.bytes.byteLength,
                        sha256,
                      ]),
                    )
                    .digest('hex'),
                  mime: image.mimeType,
                  name: 'native-image',
                  size: image.bytes.byteLength,
                  sha256,
                  bytes: (async function* () {
                    yield image.bytes
                  })(),
                },
                signal,
              )
              return {
                type: 'image',
                attachmentId,
                mimeType: image.mimeType,
                sizeBytes: image.bytes.byteLength,
                sha256,
              }
            },
          })
          break
        }
        case 'kimi':
          if (!account) throw new Error('Kimi requires a selected account')
          adapter = createKimiAdapter({
            authority: {
              provider: key,
              account,
              harness: entry,
              credentialPolicy: 'configured-native',
              environment: { ...process.env, ...env },
            },
            host: options.resources.kimi,
            loadAttachment: options.loadAttachment,
            ...kimiStorage(store, activation),
            storeAttachment: async (input) => {
              if (input.scope.sessionId !== session.id)
                throw new Error('Kimi attachment owner mismatch')
              return {
                attachmentId: await storeNativeMedia(
                  store,
                  options.uploads,
                  activation,
                  {
                    identity: kimiAttachmentIdentity(input),
                    mime: input.mime,
                    name: input.name ?? 'native-attachment',
                    size: input.sizeBytes,
                    sha256: input.sha256,
                    bytes: input.bytes,
                  },
                  input.signal,
                ),
              }
            },
          })
          break
        case 'cursor':
          if (!account) throw new Error('Cursor requires a selected account')
          await mkdir(join(options.dataDir, 'cursor'), {
            recursive: true,
            mode: 0o700,
          })
          adapter = createCursorAdapter({
            selected: {
              provider: key,
              harness: entry,
              account,
              selectionEpoch: randomUUID(),
              credential: entry.env.CURSOR_API_KEY
                ? { type: 'api-key', apiKey: entry.env.CURSOR_API_KEY }
                : {
                    type: 'sdk-file',
                    path: join(account.homePath, 'auth.json'),
                  },
              accountEnv: {},
              settingSources: ['project', 'user', 'team', 'mdm', 'plugins'],
            },
            stateRoot: join(options.dataDir, 'cursor'),
            resources: options.resources.cursor,
            sink: cursorStorage(store, activation),
            loadAttachment: async (id, attachmentId, signal) => {
              const value = await options.loadAttachment(
                id,
                attachmentId,
                signal,
              )
              return {
                attachmentId,
                mime: value.mime,
                size: value.sizeBytes,
                read: async (maximum) => {
                  if (value.sizeBytes > maximum)
                    throw new Error('Cursor attachment exceeds limit')
                  return value.readBytes()
                },
              }
            },
          })
          break
      }
      startup.assertOpen()
      const handle = await (resume ? adapter.load! : adapter.spawn)(
        session,
        emit,
      )
      try {
        startup.assertOpen()
        store.assertActivation(activation)
        if (provider === 'pi' && !resume && account?.config) {
          if (account.config.provider && account.config.model)
            await handle.setModel!(
              modelKey(account.config.provider, account.config.model),
            )
          if (account.config.thinking)
            await handle.setConfigOption!('thinking', account.config.thinking)
          store.assertActivation(activation)
        }
        if (provider === 'cursor') {
          const prompt = handle.prompt.bind(handle)
          handle.prompt = (input, dispatch, identity) =>
            prompt(
              input,
              {
                ...dispatch,
                permissionMode: dispatch?.permissionMode ?? 'auto',
              },
              identity,
            )
        }
        startup.assertOpen()
        if (handle.binding) store.put('binding', handle.binding)
        return handle
      } catch (error) {
        try {
          await handle.kill()
        } catch (cleanup) {
          startup.retain(handle)
          throw new AggregateError(
            [error, cleanup],
            'Native startup persistence and cleanup failed',
          )
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
      loadSession: true,
      cancel: true,
      models: true,
      steer: provider !== 'opencode' && provider !== 'cursor',
      queue: provider !== 'claude' && provider !== 'codex',
      questions: provider !== 'cursor',
      permissions: provider !== 'pi' && provider !== 'cursor',
    },
    spawn: (session, emit) => open(session, emit, false),
    load: (session, emit) => open(session, emit, true),
  }
}

export function kimiAttachmentIdentity(
  input: Pick<
    Parameters<KimiAttachmentSink>[0],
    'scope' | 'importId' | 'agentId' | 'nativeAttachmentId' | 'sourceIdentity'
  >,
): string {
  const { binding } = input.scope
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.scope.sessionId,
        [
          binding.provider,
          binding.accountId,
          binding.cwd,
          binding.providerSessionId,
        ],
        input.importId ?? null,
        input.agentId,
        input.nativeAttachmentId,
        [
          input.sourceIdentity.domain,
          input.sourceIdentity.key,
          input.sourceIdentity.revision,
        ],
      ]),
    )
    .digest('hex')
}
