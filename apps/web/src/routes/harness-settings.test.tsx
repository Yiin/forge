// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HarnessSettings } from './settings/HarnessSettings'

const {
  listHarnesses,
  saveHarnesses,
  listHarnessStatus,
  listAccounts,
  getAccountsDir,
  createAccount,
  reorderAccounts,
  loginStart,
} = vi.hoisted(() => ({
  listHarnesses: vi.fn(),
  saveHarnesses: vi.fn(),
  listHarnessStatus: vi.fn(),
  listAccounts: vi.fn(),
  getAccountsDir: vi.fn(),
  createAccount: vi.fn(),
  reorderAccounts: vi.fn(),
  loginStart: vi.fn(),
}))
vi.mock('../lib/api', () => ({ api: { listHarnesses, saveHarnesses } }))
vi.mock('../lib/accounts-api', () => ({
  listHarnessStatus,
  listAccounts,
  getAccountsDir,
  createAccount,
  reorderAccounts,
  loginStart,
  loginStatus: vi.fn(() => () => {}),
  loginCancel: vi.fn(),
  loginRespond: vi.fn(),
  logout: vi.fn(),
  deleteAccount: vi.fn(),
  updateAccount: vi.fn(),
  clearCooldown: vi.fn(),
}))
const harness = (name: string) => ({
  name,
  command: 'claude',
  args: [],
  env: {},
  protocol: 'pty' as const,
  enabled: true,
})
const snapshot = (accountId: string, displayName: string) => ({
  accountId,
  harnessKind: 'claude',
  displayName,
  enabled: true,
  installed: true,
  version: 'unknown',
  status: 'warning' as const,
  auth: { status: 'unauthenticated' as const },
  checkedAt: '2026-08-27T12:00:00.000Z',
})
const account = (id: string, label: string) => ({
  id,
  harness: 'claude',
  label,
  storageDir: `/tmp/accounts/claude/${id}`,
  homePath: `/tmp/accounts/claude/${id}`,
  harnessKey: 'claude',
  kind: 'claude',
  enabled: true,
  authStatus: 'unauthenticated' as const,
  email: null,
  cooldownUntil: null,
  cooldownReason: null,
  lastUsedAt: null,
})

describe('HarnessSettings', () => {
  afterEach(cleanup)
  beforeEach(() => {
    vi.clearAllMocks()
    // The base "claude" config entry has no name of its own so each account
    // row falls back to its own snapshot label instead of a shared one.
    listHarnesses.mockResolvedValue({ claude: harness('') })
    saveHarnesses.mockImplementation(async (value) => value)
    listHarnessStatus.mockResolvedValue([
      snapshot('acct_1', 'Claude Account 1'),
      snapshot('acct_2', 'Claude Account 2'),
    ])
    listAccounts.mockResolvedValue([
      account('acct_1', 'Claude Account 1'),
      account('acct_2', 'Claude Account 2'),
    ])
    getAccountsDir.mockResolvedValue('/tmp/accounts')
    createAccount.mockResolvedValue({
      id: 'acct_3',
      harnessKey: 'claude',
      label: 'Claude Account 3',
      kind: 'claude',
      homePath: '/tmp/accounts/claude/acct_3',
      orderIndex: 2,
      disabledAt: null,
      createdAt: 1,
      lastUsedAt: null,
    })
    reorderAccounts.mockResolvedValue([])
    loginStart.mockResolvedValue({
      loginId: 'login-1',
      state: {
        status: 'running',
        startedAt: null,
        finishedAt: null,
        message: null,
        output: '',
        verificationUrl: null,
        userCode: null,
      },
    })
  })
  it('renders account rows in one harness group with end arrows disabled', async () => {
    render(<HarnessSettings />)
    await screen.findByText('Claude Account 1')
    expect(screen.getByText('Claude Account 2')).toBeTruthy()
    expect(
      (
        screen.getByRole('button', {
          name: 'Move Claude Account 1 up in rotation order',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    expect(
      (
        screen.getByRole('button', {
          name: 'Move Claude Account 2 down in rotation order',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
  })
  it('reorders accounts through the harness-accounts API', async () => {
    render(<HarnessSettings />)
    await screen.findByText('Claude Account 1')
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Move Claude Account 2 up in rotation order',
      }),
    )
    await waitFor(() =>
      expect(reorderAccounts).toHaveBeenCalledWith(['acct_2', 'acct_1']),
    )
  })
  it('shows add account for supported harnesses', async () => {
    render(<HarnessSettings />)
    await screen.findByText('Claude Account 1')
    expect(screen.getByRole('button', { name: /Add account/ })).toBeTruthy()
  })
  it('shows an empty state when a harness has no managed accounts', async () => {
    listHarnessStatus.mockResolvedValue([])
    listAccounts.mockResolvedValue([])
    render(<HarnessSettings />)
    expect(await screen.findByText('No accounts')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /Add account/ })).toHaveLength(
      2,
    )
  })
  it('adds an account via create + login, not a config write', async () => {
    render(<HarnessSettings />)
    await screen.findByText('Claude Account 1')
    fireEvent.click(screen.getByRole('button', { name: /Add account/ }))
    await waitFor(() =>
      expect(createAccount).toHaveBeenCalledWith({
        harnessKey: 'claude',
        label: 'Claude Account 3',
        kind: 'claude',
      }),
    )
    await waitFor(() =>
      expect(loginStart).toHaveBeenCalledWith({ accountId: 'acct_3' }),
    )
    expect(saveHarnesses).not.toHaveBeenCalled()
  })
  it('confirms account deletion and removes its home by default', async () => {
    const { deleteAccount } = await import('../lib/accounts-api')
    render(<HarnessSettings />)
    await screen.findByText('Claude Account 1')

    fireEvent.click(
      screen.getByRole('button', { name: 'Delete account acct_1' }),
    )
    expect(
      screen
        .getByRole('checkbox', {
          name: 'Also delete the managed credential home',
        })
        .getAttribute('aria-checked'),
    ).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))

    await waitFor(() => expect(deleteAccount).toHaveBeenCalledWith('acct_1', true))
  })
})
