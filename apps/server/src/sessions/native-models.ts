import { randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelEntry } from '@forge/protocol/models'
import type { HarnessAccount } from '@forge/protocol/accounts'
import type { HarnessConfig } from '@forge/protocol/config'
import { accountEnv, deriveAccountHarness } from '../accounts/store.js'
import { discoverClaude } from '../harnesses/claude/index.js'
import { discoverPi } from '../harnesses/pi/index.js'
import { discoverOpenCode } from '../harnesses/opencode.js'
import { resolveExecutable } from '../harnesses/executable.js'
import { discoverCodex } from '../harnesses/codex/catalog.js'
import { discoverKimi } from '../harnesses/kimi/discovery.js'
import { discoverCursor } from '../harnesses/cursor/index.js'
import {
  nativeProviders,
  type createNativeResources,
} from './native-factory.js'

export type NativeModelOptions = {
  key: string
  entry: HarnessConfig
  account: HarnessAccount
  dataDir: string
  resources: ReturnType<typeof createNativeResources>
  cwd: string
  signal: AbortSignal
}

/** Account discovery owns helper processes, never a persisted conversation. */
export async function discoverNativeModels(
  input: NativeModelOptions,
): Promise<ModelEntry[]> {
  const { key, dataDir, resources, signal } = input
  signal.throwIfAborted()
  const entry = structuredClone(input.entry)
  const account = {
    ...structuredClone(input.account),
    adapterKind: input.account.adapterKind ?? ('native' as const),
  }
  const provider = nativeProviders[key as keyof typeof nativeProviders]
  if (
    !provider ||
    !entry.enabled ||
    entry.adapterKind !== 'native' ||
    account.harnessKey !== key ||
    account.kind !== provider ||
    account.disabledAt !== null ||
    (account.adapterKind !== undefined && account.adapterKind !== 'native')
  )
    throw new Error('Native model account selection is invalid')
  const cwd = await realpath(input.cwd)
  signal.throwIfAborted()
  const env = { ...entry.env, ...accountEnv(provider, account.homePath) }
  switch (provider) {
    case 'claude': {
      const derived = deriveAccountHarness(entry, account)
      const catalog = await discoverClaude(
        {
          command: derived.command,
          args: derived.args,
          env: derived.env,
          accountId: account.id,
        },
        { cwd, signal },
      )
      return catalog.models.map((model) => ({
        id: model.value,
        displayName: model.displayName,
      }))
    }
    case 'pi': {
      const executable = await resolveExecutable({
        command: entry.command,
        env: { ...process.env, ...env },
      })
      if (!executable) throw new Error('Pi executable is unavailable')
      const catalog = await discoverPi(
        {
          providerId: key,
          executable,
          args: entry.args,
          env,
          launch: {
            credentials: 'native-configured-sources',
            providerId: key,
            account,
            harness: entry,
            canonicalCwd: cwd,
            accountHome: account.homePath,
            selectedEnvOverrides: accountEnv('pi', account.homePath),
          },
        },
        { cwd, signal },
      )
      return catalog.models.map((model) => ({
        id: model.catalogId,
        displayName: model.name ?? model.id,
      }))
    }
    case 'opencode': {
      if (entry.args.length)
        throw new Error('OpenCode native arguments are not supported')
      const models = await discoverOpenCode(
        {
          provider: key,
          accountId: account.id,
          server: {
            mode: 'owned',
            executable: entry.command,
            env,
            accountHome: account.homePath,
            nativeLaunch: {
              credentials: 'native-configured-sources',
              provider: key,
              canonicalCwd: cwd,
              account,
              harness: entry,
              selectedEnvOverrides: accountEnv('opencode', account.homePath),
              credentialEnvironment: (
                [
                  'OPENCODE_AUTH_CONTENT',
                  'CLOUDFLARE_ACCOUNT_ID',
                  'CLOUDFLARE_API_KEY',
                ] as const
              ).map((name) => ({
                name,
                value: entry.env[name],
                accountId: entry.env[name] === undefined ? null : account.id,
              })),
            },
          },
        },
        { cwd, signal },
      )
      return models.map((model) => ({
        id: model.id,
        displayName: model.displayName,
      }))
    }
    case 'codex': {
      const catalog = await discoverCodex(
        {
          provider: key,
          command: entry.command,
          args: entry.args,
          accountId: account.id,
          env: { ...env, CODEX_HOME: account.homePath },
          expectedCodexHome: account.homePath,
          nativeLaunch: {
            credentials: 'native-configured-sources',
            provider: key,
            canonicalCwd: cwd,
            account,
            harness: entry,
          },
        },
        { cwd, signal },
      )
      if (!catalog.complete.models)
        throw new Error('Native model catalog is incomplete')
      return catalog.visibleModels.map((model) => ({
        id: model.id,
        displayName: model.displayName,
        description: model.description,
        isDefault: model.isDefault,
      }))
    }
    case 'kimi': {
      const catalog = await discoverKimi({
        authority: {
          provider: key,
          account,
          harness: entry,
          credentialPolicy: 'configured-native',
          environment: { ...process.env, ...env },
        },
        host: resources.kimi,
        signal,
      })
      return catalog.models.map((model) => ({
        id: model.id,
        displayName: model.displayName ?? model.id,
        isDefault: model.id === catalog.defaultModel,
      }))
    }
    case 'cursor': {
      const stateRoot = join(dataDir, 'cursor')
      await mkdir(stateRoot, { recursive: true, mode: 0o700 })
      signal.throwIfAborted()
      const result = await discoverCursor(
        {
          selected: {
            provider: key,
            harness: entry,
            account,
            selectionEpoch: randomUUID(),
            credential: entry.env.CURSOR_API_KEY
              ? { type: 'api-key', apiKey: entry.env.CURSOR_API_KEY }
              : { type: 'sdk-file', path: join(account.homePath, 'auth.json') },
            accountEnv: {},
            settingSources: ['project', 'user', 'team', 'mdm', 'plugins'],
          },
          stateRoot,
          resources: resources.cursor,
        },
        cwd,
        signal,
      )
      if (result.catalog.status !== 'ready')
        throw new Error('Native model catalog is unavailable')
      return result.catalog.items.map((model) => ({
        id: model.id,
        displayName: model.displayName,
      }))
    }
    default:
      throw new Error('Native provider catalog discovery is not implemented')
  }
}
