// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, HarnessAccountSnapshot } from '../../lib/accounts-api'
import { AccountsSettings } from './AccountsSettings'

const mocks = vi.hoisted(() => ({
  listHarnesses: vi.fn(),
  listHarnessHealth: vi.fn(),
  listAccounts: vi.fn(),
  listHarnessStatus: vi.fn(),
  getAccountsDir: vi.fn(),
  createAccount: vi.fn(),
  deleteAccount: vi.fn(),
  reorderAccounts: vi.fn(),
  loginStart: vi.fn(),
  loginCancel: vi.fn(),
  updateAccount: vi.fn(),
  refreshUsage: vi.fn(),
  clearCooldown: vi.fn(),
}))
vi.mock('../../lib/api', () => ({
  api: { listHarnesses: mocks.listHarnesses },
}))
vi.mock('../../lib/accounts-api', () => ({
  listHarnessHealth: mocks.listHarnessHealth,
  listAccounts: mocks.listAccounts,
  listHarnessStatus: mocks.listHarnessStatus,
  getAccountsDir: mocks.getAccountsDir,
  createAccount: mocks.createAccount,
  deleteAccount: mocks.deleteAccount,
  reorderAccounts: mocks.reorderAccounts,
  loginStart: mocks.loginStart,
  loginCancel: mocks.loginCancel,
  updateAccount: mocks.updateAccount,
  refreshUsage: mocks.refreshUsage,
  clearCooldown: mocks.clearCooldown,
  loginStatus: vi.fn(() => () => {}),
  loginRespond: vi.fn(),
  logout: vi.fn(),
  getAccountModels: vi.fn(async () => ({ models: [] })),
}))

const harness = (name: string, command: string) => ({
  name,
  command,
  args: [],
  env: {},
  protocol: 'acp' as const,
  enabled: true,
})

const account = (patch: Partial<Account> & { id: string }): Account => ({
  harness: 'claude',
  harnessKey: 'claude',
  kind: 'claude',
  label: patch.id,
  storageDir: `/tmp/accounts/claude/${patch.id}`,
  homePath: `/tmp/accounts/claude/${patch.id}`,
  enabled: true,
  authStatus: 'authenticated',
  email: null,
  cooldownUntil: null,
  cooldownReason: null,
  lastUsedAt: null,
  ...patch,
})

const snapshot = (
  id: string,
  patch: Partial<HarnessAccountSnapshot> = {},
): HarnessAccountSnapshot => ({
  accountId: id,
  harnessKind: 'claude',
  harnessKey: 'claude',
  enabled: true,
  installed: true,
  version: 'unknown',
  status: 'ready',
  auth: { status: 'authenticated' },
  checkedAt: '2026-09-23T00:00:00.000Z',
  ...patch,
})

const running = {
  status: 'running' as const,
  startedAt: null,
  finishedAt: null,
  message: null,
  output: '',
  verificationUrl: 'https://example.com/device',
  userCode: null,
}

function section(name: string) {
  return screen
    .getByRole('heading', { name, level: 2 })
    .closest('section') as HTMLElement
}

describe('AccountsSettings', () => {
  afterEach(cleanup)
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listHarnesses.mockResolvedValue({
      claude: harness('Claude', 'claude'),
      codex: harness('Codex', 'codex'),
      shell: { ...harness('Shell', 'bash'), protocol: 'pty' },
    })
    mocks.listHarnessHealth.mockResolvedValue([
      {
        key: 'claude',
        name: 'Claude',
        command: 'claude',
        enabled: true,
        installed: true,
        accountCount: 3,
      },
      {
        key: 'codex',
        name: 'Codex',
        command: 'codex',
        enabled: true,
        installed: false,
        accountCount: 0,
      },
    ])
    mocks.listAccounts.mockResolvedValue([
      account({
        id: 'first',
        label: 'Claude Account 1',
        cooldownUntil: Date.now() + 3_600_000,
      }),
      account({ id: 'second', label: 'Claude Account 2' }),
      account({
        id: 'third',
        label: 'Claude Account 3',
        authStatus: 'unauthenticated',
      }),
    ])
    mocks.listHarnessStatus.mockResolvedValue([
      snapshot('first', {
        limit: {
          kind: 'usage-limit',
          detectedAt: '2026-09-23T00:00:00.000Z',
          resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
          resetsAtEstimated: false,
          source: 'server',
          detail: null,
        },
      }),
      snapshot('second', {
        tierLabel: 'Max',
        usage: [
          {
            windowId: 'five_hour',
            window: 'Session',
            utilization: 0.42,
            source: 'probe',
            observedAt: '2026-09-23T00:00:00.000Z',
            resetsAt: new Date(Date.now() + 7_200_000).toISOString(),
          },
          {
            windowId: 'seven_day',
            window: 'Week',
            utilization: 0.9,
            source: 'probe',
            observedAt: '2026-09-23T00:00:00.000Z',
            resetsAt: null,
          },
        ],
      }),
      snapshot('third', { auth: { status: 'unauthenticated' } }),
    ])
    mocks.getAccountsDir.mockResolvedValue('/tmp/accounts')
    mocks.createAccount.mockResolvedValue({ id: 'fresh' })
    mocks.deleteAccount.mockResolvedValue({ ok: true })
    mocks.reorderAccounts.mockResolvedValue([])
    mocks.loginStart.mockResolvedValue({ loginId: 'login-1', state: running })
    mocks.loginCancel.mockResolvedValue({ ...running, status: 'cancelled' })
  })

  it('groups accounts by harness and shows empty and missing-CLI states', async () => {
    render(<AccountsSettings />)
    await screen.findByText('Claude Account 2')
    const claude = section('Claude')
    expect(within(claude).getByText('Claude Account 1')).toBeTruthy()
    expect(within(claude).getByText('Claude Account 3')).toBeTruthy()
    const codex = section('Codex')
    expect(
      within(codex).getByText(
        'No Codex account yet. Add one to run Codex sessions.',
      ),
    ).toBeTruthy()
    expect(
      within(codex).getByText('The codex CLI is not installed on this server.'),
    ).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Shell' })).toBeNull()
    expect(screen.getByText('3')).toBeTruthy()
  })

  it('marks the first usable account active and switches by reordering', async () => {
    render(<AccountsSettings />)
    await screen.findByText('Claude Account 2')
    const row = (id: string) =>
      document.querySelector(`[data-account-id="${id}"]`) as HTMLElement
    expect(within(row('first')).queryByText('Active')).toBeNull()
    expect(within(row('first')).getByText('Usage limit reached')).toBeTruthy()
    expect(within(row('second')).getByText('Active')).toBeTruthy()
    expect(within(row('second')).getByText('Max')).toBeTruthy()
    // The active, the cooling, and the signed-out account cannot be switched to.
    expect(screen.queryByRole('button', { name: 'Switch' })).toBeNull()

    mocks.listHarnessStatus.mockResolvedValue([
      snapshot('first'),
      snapshot('second'),
    ])
    mocks.listAccounts.mockResolvedValue([
      account({ id: 'first', label: 'Claude Account 1', enabled: false }),
      account({ id: 'second', label: 'Claude Account 2' }),
      account({ id: 'fourth', label: 'Claude Account 4' }),
    ])
    cleanup()
    render(<AccountsSettings />)
    await screen.findByText('Claude Account 4')
    expect(within(row('second')).getByText('Active')).toBeTruthy()
    fireEvent.click(
      within(row('fourth')).getByRole('button', { name: 'Switch' }),
    )
    await waitFor(() =>
      expect(mocks.reorderAccounts).toHaveBeenCalledWith([
        'fourth',
        'first',
        'second',
      ]),
    )
  })

  it('shows Sign in on a signed-out row and usage meters on a signed-in one', async () => {
    render(<AccountsSettings />)
    await screen.findByText('Claude Account 2')
    const third = document.querySelector(
      '[data-account-id="third"]',
    ) as HTMLElement
    expect(within(third).getByText('Not signed in')).toBeTruthy()
    expect(within(third).getByRole('button', { name: 'Sign in' })).toBeTruthy()
    const meters = screen.getAllByRole('meter')
    expect(meters.map((meter) => meter.getAttribute('aria-label'))).toEqual([
      'Session usage',
      'Week usage',
    ])
    expect(meters[0]!.getAttribute('aria-valuenow')).toBe('42')
    expect(screen.getByText('Usage unavailable')).toBeTruthy()
  })

  it('deletes the empty account when a new sign-in is cancelled', async () => {
    render(<AccountsSettings />)
    await screen.findByText('Claude Account 2')
    fireEvent.click(
      within(section('Claude')).getByRole('button', { name: 'Add account' }),
    )
    await waitFor(() =>
      expect(mocks.createAccount).toHaveBeenCalledWith({
        harnessKey: 'claude',
        label: 'Claude Account 4',
        kind: 'claude',
      }),
    )
    expect(
      await screen.findByRole('heading', { name: 'Add Claude account' }),
    ).toBeTruthy()
    expect(mocks.loginStart).toHaveBeenCalledWith({ accountId: 'fresh' })
    expect(
      screen
        .getByRole('link', { name: /Open sign-in page/ })
        .getAttribute('href'),
    ).toBe('https://example.com/device')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(mocks.loginCancel).toHaveBeenCalledWith({ terminalId: 'login-1' }),
    )
    await waitFor(() =>
      expect(mocks.deleteAccount).toHaveBeenCalledWith('fresh', true),
    )
  })

  it('re-signing an existing account never deletes it on cancel', async () => {
    render(<AccountsSettings />)
    await screen.findByText('Claude Account 3')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(
      await screen.findByRole('heading', {
        name: 'Sign in to Claude Account 3',
      }),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(mocks.loginCancel).toHaveBeenCalled())
    expect(mocks.deleteAccount).not.toHaveBeenCalled()
  })

  it('confirms delete and removes the managed home by default', async () => {
    render(<AccountsSettings />)
    await screen.findByText('Claude Account 2')
    fireEvent.click(
      screen.getByRole('button', { name: 'More actions for Claude Account 2' }),
    )
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete…' }))
    const checkbox = await screen.findByRole('checkbox', {
      name: 'Delete managed credential home',
    })
    expect(checkbox.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    await waitFor(() =>
      expect(mocks.deleteAccount).toHaveBeenCalledWith('second', true),
    )
  })

  it('shows a retry strip when loading fails', async () => {
    mocks.listAccounts.mockRejectedValueOnce(new Error('offline'))
    render(<AccountsSettings />)
    expect(
      await screen.findByText('Could not load accounts: offline'),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Claude Account 2')).toBeTruthy()
  })
})
