import {
  harnessAccountSnapshotSchema,
  type HarnessAccountSnapshot,
} from '@forge/protocol/accounts'

export type { HarnessAccountSnapshot }

export type HarnessUsageSample = {
  window: string
  utilization: number
  resetsAt: string | null
  source: string
  observedAt: string
}

export type AccountLimit = {
  kind:
    'usage-limit' | 'spend-limit' | 'credits-depleted' | 'auth' | 'unavailable'
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

export type Account = {
  id: string
  harness: string
  label: string
  storageDir: string
  enabled: boolean
  authStatus: 'authenticated' | 'unauthenticated' | 'unknown'
  email: string | null
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

  listHarnessStatus() {
    return this.get<unknown>('/api/harnesses/status').then((value) =>
      harnessAccountSnapshotSchema.array().parse(value),
    )
  }

  refreshHarnessStatus() {
    return this.listHarnessStatus()
  }

  allocateAccountHome(input: { harnessKind: string; accountId: string }) {
    return this.post<{ homePath: string }>('/api/accounts/allocate-home', input)
  }

  loginStart(input: { accountId: string }) {
    return this.post<{ loginId: string; state: LoginRunState }>(
      '/api/accounts/login',
      input,
    )
  }

  loginStatus(terminalId: string, listener: LoginStatusListener) {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const state = await this.get<LoginRunState>(
          `/api/accounts/login/${encodeURIComponent(terminalId)}`,
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

  loginRespond(input: { terminalId: string; data: string }) {
    return this.post<LoginRunState>(
      `/api/accounts/login/${encodeURIComponent(input.terminalId)}/input`,
      { data: input.data },
    )
  }

  loginCancel(input: { terminalId: string }) {
    return this.post<LoginRunState>(
      `/api/accounts/login/${encodeURIComponent(input.terminalId)}/cancel`,
      {},
    )
  }

  logout(input: { accountId: string; deleteAccountHome?: boolean }) {
    return this.post<Account>(
      `/api/accounts/${encodeURIComponent(input.accountId)}/logout`,
      { deleteStorage: input.deleteAccountHome },
    )
  }

  listAccounts() {
    return this.get<Account[]>('/api/accounts')
  }

  createAccount(input: { harness: string; label: string }) {
    return this.post<Account>('/api/accounts', input)
  }

  updateAccount(id: string, input: { label?: string; enabled?: boolean }) {
    return this.patch<Account>(`/api/accounts/${encodeURIComponent(id)}`, input)
  }

  deleteAccount(id: string, deleteStorage = false) {
    return this.request<{ ok: true }>(
      'DELETE',
      `/api/accounts/${encodeURIComponent(id)}${deleteStorage ? '?deleteStorage=1' : ''}`,
    )
  }

  reorderAccounts(input: { harness: string; ids: string[] }) {
    return this.post<Account[]>('/api/accounts/reorder', input)
  }

  clearCooldown(id: string) {
    return this.post<Account>(
      `/api/accounts/${encodeURIComponent(id)}/clear-cooldown`,
      {},
    )
  }

  getAccountsDir() {
    return this.get<{ accountsDir?: string }>('/api/config').then(
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
export const allocateAccountHome = (input: {
  harnessKind: string
  accountId: string
}) => accountsApi.allocateAccountHome(input)
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
export const createAccount = (input: { harness: string; label: string }) =>
  accountsApi.createAccount(input)
export const updateAccount = (
  id: string,
  input: { label?: string; enabled?: boolean },
) => accountsApi.updateAccount(id, input)
export const deleteAccount = (id: string, deleteStorage?: boolean) =>
  accountsApi.deleteAccount(id, deleteStorage)
export const reorderAccounts = (input: { harness: string; ids: string[] }) =>
  accountsApi.reorderAccounts(input)
export const clearCooldown = (id: string) => accountsApi.clearCooldown(id)
export const getAccountsDir = () => accountsApi.getAccountsDir()
