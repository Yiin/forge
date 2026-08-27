import {
  harnessAccountSnapshotSchema,
  type HarnessAccount,
  type HarnessAccountSnapshot,
} from '@forge/protocol/accounts'
import { harnessHealthResponseSchema } from '@forge/protocol/status'
import { formatAccountDisplayName } from './harness-accounts-logic.js'

export type { HarnessAccountSnapshot }

export type AccountLimit = {
  kind:
    | 'usage-limit'
    | 'spend-limit'
    | 'credits-depleted'
    | 'auth'
    | 'rate-limit'
    | 'unavailable'
  detectedAt: string
  resetsAt: string | null
  resetsAtEstimated: boolean
  source: string
  detail: string | null
}

export type LoginRunState = {
  status: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  startedAt: string | null
  finishedAt: string | null
  message: string | null
  output: string
  verificationUrl: string | null
  userCode: string | null
}

const emptyLoginState = (): LoginRunState => ({
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  message: null,
  output: '',
  verificationUrl: null,
  userCode: null,
})

export type Account = {
  id: string
  harness: string
  label: string
  storageDir: string
  harnessKey: string
  kind: string
  homePath: string
  enabled: boolean
  authStatus: 'authenticated' | 'unauthenticated' | 'unknown'
  email: string | null
  identity?: HarnessAccount['identity']
  cooldownUntil: number | null
  cooldownReason: string | null
  lastUsedAt: number | null
}

export { harnessAccountSnapshotSchema }

type FetchLike = typeof globalThis.fetch
export type AccountsApiOptions = {
  baseUrl?: string
  fetch?: FetchLike
  pollIntervalMs?: number
}
export type LoginStatusListener = (state: LoginRunState) => void

const defaultBase = () =>
  typeof window === 'undefined' ? 'http://localhost:3000' : ''

export class AccountsApi {
  private readonly baseUrl: string
  private readonly fetcher: FetchLike
  private readonly pollIntervalMs: number

  constructor(options: AccountsApiOptions = {}) {
    this.baseUrl = options.baseUrl ?? defaultBase()
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.pollIntervalMs = options.pollIntervalMs ?? 1000
  }

  async listHarnessStatus(): Promise<HarnessAccountSnapshot[]> {
    const health = harnessHealthResponseSchema.parse(
      await this.get<unknown>('/api/harnesses/health'),
    )
    const checkedAt = new Date().toISOString()
    return health.flatMap((entry) =>
      entry.accounts.map((account, index) =>
        harnessAccountSnapshotSchema.parse({
          accountId: account.id,
          harnessKind: account.kind,
          harnessKey: entry.key,
          displayName: formatAccountDisplayName({
            kindLabel: entry.name,
            ordinal: index + 1,
            label: account.label,
            identity: account.identity,
          }),
          enabled: entry.enabled,
          installed: entry.enabled,
          version: 'unknown',
          status: account.disabled
            ? 'disabled'
            : account.cooldown
              ? 'warning'
              : account.authenticated
                ? 'ready'
                : 'warning',
          auth: {
            status: account.authenticated ? 'authenticated' : 'unauthenticated',
            email: account.identity?.email,
            label: account.identity?.label,
            type: account.identity?.type,
          },
          checkedAt,
          limit: account.cooldown
            ? {
                kind: account.cooldown.kind,
                detectedAt: new Date(account.cooldown.detectedAt).toISOString(),
                resetsAt:
                  account.cooldown.resetsAt === null
                    ? null
                    : new Date(account.cooldown.resetsAt).toISOString(),
                resetsAtEstimated: account.cooldown.resetsAtEstimated,
                source: 'server',
                detail: account.cooldown.detail,
              }
            : null,
        }),
      ),
    )
  }

  refreshHarnessStatus() {
    return this.listHarnessStatus()
  }

  private async healthByAccountId() {
    const health = harnessHealthResponseSchema.parse(
      await this.get<unknown>('/api/harnesses/health'),
    )
    const index = new Map<
      string,
      {
        authenticated: boolean
        cooldown: AccountLimit | null
        identity: HarnessAccount['identity']
      }
    >()
    for (const entry of health)
      for (const account of entry.accounts)
        index.set(account.id, {
          authenticated: account.authenticated,
          cooldown: account.cooldown
            ? {
                kind: account.cooldown.kind as AccountLimit['kind'],
                detectedAt: new Date(account.cooldown.detectedAt).toISOString(),
                resetsAt:
                  account.cooldown.resetsAt === null
                    ? null
                    : new Date(account.cooldown.resetsAt).toISOString(),
                resetsAtEstimated: account.cooldown.resetsAtEstimated,
                source: 'server',
                detail: account.cooldown.detail,
              }
            : null,
          identity: account.identity,
        })
    return index
  }

  async listAccounts(): Promise<Account[]> {
    const [rows, health] = await Promise.all([
      this.get<HarnessAccount[]>('/api/harness-accounts'),
      this.healthByAccountId(),
    ])
    return rows.map((row) => {
      const info = health.get(row.id)
      const ordinal =
        rows
          .filter((item) => item.harnessKey === row.harnessKey)
          .findIndex((item) => item.id === row.id) + 1
      return {
        id: row.id,
        harness: row.harnessKey,
        harnessKey: row.harnessKey,
        kind: row.kind,
        homePath: row.homePath,
        label: formatAccountDisplayName({
          kindLabel: row.kind[0]!.toUpperCase() + row.kind.slice(1),
          ordinal,
          label: row.label,
          identity: info?.identity,
        }),
        storageDir: row.homePath,
        enabled: row.disabledAt === null,
        authStatus: info
          ? info.authenticated
            ? 'authenticated'
            : 'unauthenticated'
          : 'unknown',
        email: info?.identity?.email ?? null,
        identity: info?.identity ?? null,
        cooldownUntil: info?.cooldown?.resetsAt
          ? Date.parse(info.cooldown.resetsAt)
          : null,
        cooldownReason: info?.cooldown?.detail ?? null,
        lastUsedAt: row.lastUsedAt,
      }
    })
  }

  createAccount(input: { harnessKey: string; label: string; kind: string }) {
    return this.post<HarnessAccount>('/api/harness-accounts', input)
  }

  updateAccount(
    id: string,
    input: { label?: string; orderIndex?: number; disabled?: boolean },
  ) {
    return this.patch<HarnessAccount>(
      `/api/harness-accounts/${encodeURIComponent(id)}`,
      input,
    )
  }

  deleteAccount(id: string, removeHome = false) {
    return this.request<{ ok: true }>(
      'DELETE',
      `/api/harness-accounts/${encodeURIComponent(id)}${removeHome ? '?removeHome=1' : ''}`,
    )
  }

  reorderAccounts(ids: readonly string[]) {
    return Promise.all(
      ids.map((id, index) => this.updateAccount(id, { orderIndex: index })),
    )
  }

  clearCooldown(id: string) {
    return this.post<{ ok: true }>(
      `/api/harness-accounts/${encodeURIComponent(id)}/clear-cooldown`,
      {},
    )
  }

  async loginStart(input: {
    accountId: string
  }): Promise<{ loginId: string; state: LoginRunState }> {
    const { loginId } = await this.post<{ loginId: string }>(
      `/api/harness-accounts/${encodeURIComponent(input.accountId)}/login`,
      {},
    )
    return { loginId, state: emptyLoginState() }
  }

  loginStatus(terminalId: string, listener: LoginStatusListener) {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const state = await this.get<LoginRunState>(
          `/api/harness-accounts/logins/${encodeURIComponent(terminalId)}`,
        )
        if (stopped) return
        listener(state)
        if (state.status === 'running' || state.status === 'idle')
          timer = setTimeout(() => void poll(), this.pollIntervalMs)
      } catch {
        if (!stopped) timer = setTimeout(() => void poll(), this.pollIntervalMs)
      }
    }
    void poll()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }

  async loginRespond(input: {
    terminalId: string
    data: string
  }): Promise<LoginRunState> {
    await this.post<{ ok: true }>(
      `/api/harness-accounts/logins/${encodeURIComponent(input.terminalId)}/respond`,
      { data: input.data },
    )
    return this.get<LoginRunState>(
      `/api/harness-accounts/logins/${encodeURIComponent(input.terminalId)}`,
    )
  }

  async loginCancel(input: { terminalId: string }): Promise<LoginRunState> {
    await this.post<{ ok: true }>(
      `/api/harness-accounts/logins/${encodeURIComponent(input.terminalId)}/cancel`,
      {},
    )
    return this.get<LoginRunState>(
      `/api/harness-accounts/logins/${encodeURIComponent(input.terminalId)}`,
    )
  }

  logout(input: { accountId: string; deleteAccountHome?: boolean }) {
    return this.post<{ authenticated: boolean }>(
      `/api/harness-accounts/${encodeURIComponent(input.accountId)}/logout`,
      { deleteAccountHome: input.deleteAccountHome },
    )
  }

  getAccountsDir() {
    return this.get<{ accountsDir: string }>('/api/config').then(
      (config) => config.accountsDir,
    )
  }

  private get<T>(path: string) {
    return this.request<T>('GET', path)
  }

  private post<T>(path: string, body: unknown) {
    return this.request<T>('POST', path, body)
  }

  private patch<T>(path: string, body: unknown) {
    return this.request<T>('PATCH', path, body)
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method,
      headers:
        body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
      let detail = ''
      try {
        const payload = (await response.clone().json()) as {
          error?: string
          message?: string
        }
        detail = payload.error ?? payload.message ?? ''
      } catch {
        detail = await response.text().catch(() => '')
      }
      throw new Error(detail || `Forge API request failed (${response.status})`)
    }
    return (await response.json()) as T
  }
}

export const accountsApi = new AccountsApi()
export const listHarnessStatus = () => accountsApi.listHarnessStatus()
export const refreshHarnessStatus = () => accountsApi.refreshHarnessStatus()
export const loginStart = (input: { accountId: string }) =>
  accountsApi.loginStart(input)
export const loginStatus = (
  terminalId: string,
  listener: LoginStatusListener,
) => accountsApi.loginStatus(terminalId, listener)
export const loginRespond = (input: { terminalId: string; data: string }) =>
  accountsApi.loginRespond(input)
export const loginCancel = (input: { terminalId: string }) =>
  accountsApi.loginCancel(input)
export const logout = (input: {
  accountId: string
  deleteAccountHome?: boolean
}) => accountsApi.logout(input)
export const listAccounts = () => accountsApi.listAccounts()
export const createAccount = (input: {
  harnessKey: string
  label: string
  kind: string
}) => accountsApi.createAccount(input)
export const updateAccount = (
  id: string,
  input: { label?: string; orderIndex?: number; disabled?: boolean },
) => accountsApi.updateAccount(id, input)
export const deleteAccount = (id: string, removeHome?: boolean) =>
  accountsApi.deleteAccount(id, removeHome)
export const reorderAccounts = (ids: readonly string[]) =>
  accountsApi.reorderAccounts(ids)
export const clearCooldown = (id: string) => accountsApi.clearCooldown(id)
export const getAccountsDir = () => accountsApi.getAccountsDir()
