/* eslint-disable no-control-regex -- Reject whitespace and control bytes in credential keys. */
import { realpath } from 'node:fs/promises'
import type { SdkCredentialStore, StoredSdkCredentials } from '@cursor/sdk'
import type { CursorSelectedRecords } from './contracts.js'
import { boundedRead } from './store.js'
import { invariant, plainCopy, type CursorLimits } from './limits.js'

/** Public v1 shape. The SDK pin declares this parser but does not export it. */
export function validateStoredCredentials(
  value: unknown,
  limits: CursorLimits,
): StoredSdkCredentials {
  const row = plainCopy(
    value,
    limits.credentialBytes,
    limits.credentialDepth,
  ) as Partial<StoredSdkCredentials> | null
  invariant(
    row && typeof row === 'object' && !Array.isArray(row) && row.version === 1,
    'cursor_credential_invalid',
  )
  invariant(
    typeof row.backendUrl === 'string' &&
      typeof row.apiKey === 'string' &&
      typeof row.createdAtMs === 'number' &&
      Number.isFinite(row.createdAtMs),
    'cursor_credential_invalid',
  )
  invariant(
    row.apiKeyExpiresAtMs === undefined ||
      (typeof row.apiKeyExpiresAtMs === 'number' &&
        Number.isFinite(row.apiKeyExpiresAtMs)),
    'cursor_credential_invalid',
  )
  invariant(
    row.email === undefined || typeof row.email === 'string',
    'cursor_credential_invalid',
  )
  return {
    version: 1,
    backendUrl: row.backendUrl,
    apiKey: row.apiKey,
    createdAtMs: row.createdAtMs,
    ...(row.apiKeyExpiresAtMs === undefined
      ? {}
      : { apiKeyExpiresAtMs: row.apiKeyExpiresAtMs }),
    ...(row.email === undefined ? {} : { email: row.email }),
  }
}
export async function readCursorCredentials(
  selected: CursorSelectedRecords,
  limits: CursorLimits,
  signal: AbortSignal,
): Promise<{
  apiKey: string
  store: SdkCredentialStore
  status: 'configured-unverified' | 'stored-unverified'
}> {
  signal.throwIfAborted()
  let credentials: StoredSdkCredentials | undefined
  let apiKey: string
  if (selected.credential.type === 'api-key')
    apiKey = selected.credential.apiKey
  else {
    const path = selected.credential.path
    invariant(
      (await realpath(path)) === path &&
        path.startsWith(`${selected.account.homePath}/`),
      'cursor_credential_path',
    )
    signal.throwIfAborted()
    const bytes = await boundedRead(path, limits.credentialBytes, true)
    signal.throwIfAborted()
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes))
    } catch {
      invariant(false, 'cursor_credential_invalid')
    }
    credentials = validateStoredCredentials(value, limits)
    invariant(
      credentials.backendUrl ===
        (selected.backendUrl ?? 'https://api2.cursor.sh'),
      'cursor_credential_backend',
    )
    invariant(
      credentials.apiKeyExpiresAtMs === undefined ||
        credentials.apiKeyExpiresAtMs > Date.now(),
      'cursor_credential_expired',
    )
    apiKey = credentials.apiKey
  }
  invariant(
    apiKey.length > 0 &&
      Buffer.byteLength(apiKey) <= limits.credentialKeyBytes &&
      !/[\x00-\x20\x7f]/.test(apiKey),
    'cursor_credential_invalid',
  )
  return {
    apiKey,
    status: credentials ? 'stored-unverified' : 'configured-unverified',
    store: {
      load: async () => credentials,
      save: async () => {
        throw new Error('cursor_credential_read_only')
      },
      clear: async () => {
        throw new Error('cursor_credential_read_only')
      },
    },
  }
}
