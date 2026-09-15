/* eslint-disable no-control-regex -- Reject control bytes at authority boundaries. */
import {
  realpathSync,
  statSync,
  lstatSync,
  readFileSync,
  openSync,
  readSync,
  closeSync,
  constants,
  accessSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HarnessSession } from '../types.js'
import type { CursorSelectedRecords } from './contracts.js'
import { boundedId, invariant, plainCopy, type CursorLimits } from './limits.js'

export type CursorLaunch = {
  selected: CursorSelectedRecords
  stateRoot: string
  accountRoot: string
  environment: Readonly<NodeJS.ProcessEnv>
  node: string
  args: string[]
  entry: string
  guardian: string
  artifactHash: string
}
const scrub = (key: string) =>
  /^(CURSOR_|NODE_|BUN_|LD_|DYLD_)/.test(key) ||
  /^(NODE_OPTIONS|NODE_PATH|BUN_OPTIONS|BUN_CONFIG_PRELOAD|FORGE_CURSOR_|SDK_)/.test(
    key,
  )
export function bootstrapEnvironment(
  captured: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
  }
  for (const key of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
    const value = captured[key]
    if (value !== undefined) {
      invariant(
        value.length <= 4096 && !/[\x00-\x1f]/.test(value),
        'cursor_bootstrap_environment',
      )
      environment[key] = value
    }
  }
  return environment
}
/** Call immediately before NativeProcess.start; its merge must preserve removals. */
export function nativeBootstrapOverrides(captured: NodeJS.ProcessEnv) {
  const result: NodeJS.ProcessEnv = {}
  for (const key of Object.keys(process.env)) result[key] = undefined
  return { ...result, ...bootstrapEnvironment(captured) }
}
export function managerUnsetKeys(
  keys: readonly string[],
  removed: readonly string[],
  limits: CursorLimits,
) {
  invariant(
    keys.length <= limits.envEntries,
    'cursor_manager_environment_limit',
  )
  const output = new Set([
    'NODE_OPTIONS',
    'NODE_PATH',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'LD_AUDIT',
    ...removed,
  ])
  for (const key of keys) {
    invariant(
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(key),
      'cursor_manager_environment',
    )
    // Manager values are independent authority. The service receives no inherited manager values before the pipe grant.
    output.add(key)
  }
  invariant(
    Buffer.byteLength([...output].join(' ')) <= limits.envBytes,
    'cursor_manager_environment_limit',
  )
  return [...output].sort()
}
export function validateEnvironment(
  environment: NodeJS.ProcessEnv,
  limits: CursorLimits,
) {
  const entries = Object.entries(environment)
  invariant(entries.length <= limits.envEntries, 'cursor_environment_limit')
  let total = 0
  for (const [key, value] of entries) {
    invariant(
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
        (value === undefined ||
          (typeof value === 'string' && !value.includes('\0'))),
      'cursor_environment_value',
    )
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(value ?? '')
    invariant(bytes <= limits.envValueBytes, 'cursor_environment_value')
    total += bytes
  }
  invariant(total <= limits.envBytes, 'cursor_environment_limit')
}
export function captureLaunch(
  selectedIn: CursorSelectedRecords,
  stateRootIn: string,
  limits: CursorLimits,
): CursorLaunch {
  const selected = plainCopy(
    selectedIn,
    limits.envBytes + limits.argBytes + limits.controlBytes,
  )
  const { harness, account } = selected
  boundedId(selected.provider)
  boundedId(selected.selectionEpoch)
  boundedId(account.id)
  invariant(
    harness.enabled &&
      harness.adapterKind === 'native' &&
      account.adapterKind === 'native' &&
      account.kind === 'cursor' &&
      account.harnessKey === selected.provider &&
      account.disabledAt === null,
    'cursor_selected_account',
  )
  invariant(
    Array.isArray(harness.args) &&
      harness.args.length <= 1 &&
      harness.args.length <= limits.args,
    'cursor_node_arguments',
  )
  for (const argument of harness.args)
    invariant(
      /^--max-old-space-size=(128|12[89]|1[3-9]\d|[2-9]\d\d|[1-3]\d{3}|40[0-8]\d|409[0-6])$/.test(
        argument,
      ),
      'cursor_node_arguments',
    )
  invariant(
    harness.args.every(
      (value) => Buffer.byteLength(value) <= limits.argValueBytes,
    ) &&
      harness.args.reduce((sum, value) => sum + Buffer.byteLength(value), 0) <=
        limits.argBytes,
    'cursor_node_arguments',
  )
  invariant(
    process.platform === 'linux' &&
      process.arch === 'x64' &&
      process.versions.node.split('.')[0] === '24',
    'cursor_runtime_unavailable',
  )
  const node = realpathSync(harness.command)
  invariant(
    isAbsolute(harness.command) &&
      node === realpathSync(process.execPath) &&
      statSync(node).isFile(),
    'cursor_node_authority',
  )
  accessSync(node, constants.X_OK)
  const accountRoot = realpathSync(
    resolve(
      process.env.FORGE_ACCOUNTS_DIR ?? join(homedir(), '.forge/accounts'),
    ),
  )
  const home = realpathSync(account.homePath)
  invariant(
    home === account.homePath && home.startsWith(`${accountRoot}/`),
    'cursor_account_home',
  )
  const stateRoot = realpathSync(stateRootIn)
  const modulePath = fileURLToPath(import.meta.url)
  const artifact = resolve(
    dirname(modulePath),
    modulePath.endsWith('/harnesses/cursor/launch.ts')
      ? '../../cursor-sidecar'
      : 'cursor-sidecar',
  )
  const manifestPath = join(artifact, 'manifest.json')
  invariant(
    lstatSync(manifestPath).isFile() &&
      statSync(manifestPath).size <= 2 * 1024 * 1024,
    'cursor_artifact_manifest',
  )
  const manifestBytes = readFileSync(manifestPath)
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  invariant(
    manifest.version === 1 &&
      manifest.sdkVersion === '1.0.28' &&
      Array.isArray(manifest.files) &&
      manifest.files.length <= 10000,
    'cursor_artifact_manifest',
  )
  for (const file of manifest.files) {
    invariant(
      typeof file.path === 'string' &&
        relative(artifact, resolve(artifact, file.path)) === file.path,
      'cursor_artifact_path',
    )
    const path = join(artifact, file.path)
    invariant(realpathSync(path) === path, 'cursor_artifact_symlink')
    const info = statSync(path)
    invariant(
      info.isFile() &&
        info.size === file.bytes &&
        (info.mode & 0o777) === file.mode,
      'cursor_artifact_invalid',
    )
    const digest = createHash('sha256'),
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW),
      chunk = Buffer.alloc(65536)
    try {
      let bytes = 0
      for (;;) {
        const read = readSync(descriptor, chunk, 0, chunk.length, null)
        if (!read) break
        bytes += read
        invariant(bytes <= info.size, 'cursor_artifact_changed')
        digest.update(chunk.subarray(0, read))
      }
      invariant(bytes === info.size, 'cursor_artifact_changed')
    } finally {
      closeSync(descriptor)
    }
    invariant(digest.digest('hex') === file.sha256, 'cursor_artifact_hash')
  }
  const entry = join(artifact, 'sidecar.mjs'),
    guardian = join(artifact, 'guardian.mjs')
  invariant(
    manifest.files.some(
      (file: { path: string }) => file.path === 'sidecar.mjs',
    ) &&
      manifest.files.some(
        (file: { path: string }) => file.path === 'guardian.mjs',
      ),
    'cursor_artifact_entries',
  )
  for (const name of ['@cursor/sdk', '@cursor/sdk-linux-x64'])
    invariant(
      manifest.packages.some(
        (pkg: { name: string; version: string }) =>
          pkg.name === name && pkg.version === '1.0.28',
      ),
      'cursor_sdk_version',
    )
  const environment: NodeJS.ProcessEnv = plainCopy(
    { ...process.env, ...harness.env, ...selected.accountEnv },
    limits.envBytes * 2,
  )
  const owned: NodeJS.ProcessEnv = {
    HOME: home,
    CURSOR_CONFIG_DIR: join(home, '.cursor'),
  }
  for (const overlay of [harness.env, selected.accountEnv])
    for (const [key, value] of Object.entries(overlay)) {
      if (key in owned)
        invariant(
          value === undefined || value === owned[key],
          'cursor_environment_conflict',
        )
      if (
        [
          'CURSOR_DATA_DIR',
          'FORGE_CURSOR_ENTRY',
          'FORGE_CURSOR_GUARDIAN',
        ].includes(key)
      )
        invariant(value === undefined, 'cursor_environment_conflict')
    }
  const final = { ...environment }
  for (const key of new Set([
    ...Object.keys(process.env),
    ...Object.keys(final),
  ]))
    if (scrub(key)) final[key] = undefined
  Object.assign(final, owned, { PATH: '/usr/bin:/bin' })
  if (selected.backendUrl) {
    const url = new URL(selected.backendUrl)
    invariant(
      url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
      'cursor_backend_invalid',
    )
    final.CURSOR_BACKEND_URL = selected.backendUrl
  }
  invariant(
    new Set(selected.settingSources).size === selected.settingSources.length &&
      selected.settingSources.every((source) =>
        ['project', 'user', 'team', 'mdm', 'plugins'].includes(source),
      ),
    'cursor_setting_sources',
  )
  if (selected.credential.type === 'api-key')
    boundedId(selected.credential.apiKey, limits.credentialKeyBytes)
  else
    invariant(
      selected.credential.type === 'sdk-file' &&
        resolve(selected.credential.path).startsWith(`${home}/`),
      'cursor_credential_path',
    )
  validateEnvironment(final, limits)
  return Object.freeze({
    selected,
    stateRoot,
    accountRoot,
    environment: Object.freeze(final),
    node,
    args: harness.args.length
      ? [...harness.args]
      : ['--max-old-space-size=512'],
    entry,
    guardian,
    artifactHash: createHash('sha256').update(manifestBytes).digest('hex'),
  })
}
export function captureSession(
  sessionIn: HarnessSession,
  launch: CursorLaunch,
): HarnessSession {
  const session = plainCopy(sessionIn, 16384)
  boundedId(session.id)
  invariant(
    session.provider === launch.selected.provider &&
      session.accountId === launch.selected.account.id &&
      session.cwd === realpathSync(session.cwd),
    'cursor_session_authority',
  )
  return session
}
