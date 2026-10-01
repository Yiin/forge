import { useCallback, useEffect, useState } from 'react'
import type { ModelEntry } from '@forge/protocol/models'
import {
  accountsApi,
  type Account,
  type HarnessPickerEntry,
} from '../../lib/accounts-api'

/** Harnesses and accounts as the Providers page configures them. */
export type Providers = {
  harnesses: HarnessPickerEntry[]
  accounts: Account[]
}

export const emptyProviders: Providers = { harnesses: [], accounts: [] }

export function loadProviders(): Promise<Providers> {
  return Promise.all([
    accountsApi.listHarnesses(),
    accountsApi.listAccounts(),
  ]).then(([harnesses, accounts]) => ({ harnesses, accounts }))
}

/**
 * Model lists per account, fetched once per account on first request. A
 * failed fetch leaves the list empty, so the model picker offers only the
 * harness default and the saved value.
 */
export function useAccountModels() {
  const [models, setModels] = useState<Record<string, ModelEntry[]>>({})
  const [requested] = useState(() => new Set<string>())
  const request = useCallback(
    (accountId: string | undefined) => {
      if (!accountId || requested.has(accountId)) return
      requested.add(accountId)
      void accountsApi
        .getModels(accountId)
        .then((catalog) =>
          setModels((current) => ({
            ...current,
            [accountId]: catalog.models,
          })),
        )
        .catch(() => undefined)
    },
    [requested],
  )
  return { models, request }
}

/** Loads providers once on mount and exposes a retry. */
export function useProviders() {
  const [providers, setProviders] = useState(emptyProviders)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    setError(null)
    void loadProviders()
      .then(setProviders)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
  }, [attempt])
  return { providers, error, retry: () => setAttempt((n) => n + 1) }
}
