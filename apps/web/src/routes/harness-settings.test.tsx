// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HarnessSettings } from './settings-pages'

const {
  listHarnesses,
  saveHarnesses,
  listHarnessStatus,
  getAccountsDir,
  allocateAccountHome,
  loginStart,
} = vi.hoisted(() => ({
  listHarnesses: vi.fn(),
  saveHarnesses: vi.fn(),
  listHarnessStatus: vi.fn(),
  getAccountsDir: vi.fn(),
  allocateAccountHome: vi.fn(),
  loginStart: vi.fn(),
}))
vi.mock('../lib/api', () => ({ api: { listHarnesses, saveHarnesses } }))
vi.mock('../lib/accounts-api', () => ({
  listHarnessStatus,
  getAccountsDir,
  allocateAccountHome,
  loginStart,
  loginStatus: vi.fn(() => () => {}),
  loginCancel: vi.fn(),
  loginRespond: vi.fn(),
  logout: vi.fn(),
}))
const harness = (name: string) => ({
  name,
  command: 'claude',
  args: [],
  env: {},
  protocol: 'pty' as const,
  enabled: true,
})
const snapshot = (accountId: string) => ({
  accountId,
  harnessKind: 'claude',
  displayName: accountId,
  enabled: true,
  installed: true,
  version: '1',
  status: 'ready' as const,
  auth: { status: 'unauthenticated' as const },
  checkedAt: '2026-08-27T12:00:00.000Z',
  availability: 'available' as const,
})

describe('HarnessSettings', () => {
  afterEach(cleanup)
  beforeEach(() => {
    vi.clearAllMocks()
    listHarnesses.mockResolvedValue({
      claude: harness('Claude Account 1'),
      claude_account_2: harness('Claude Account 2'),
    })
    saveHarnesses.mockImplementation(async (value) => value)
    listHarnessStatus.mockResolvedValue([
      snapshot('claude'),
      snapshot('claude_account_2'),
    ])
    getAccountsDir.mockResolvedValue('/tmp/accounts')
    allocateAccountHome.mockResolvedValue({
      homePath: '/tmp/accounts/claude/claude_account_3',
    })
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
  it('optimistically reorders accounts and persists the new order', async () => {
    render(<HarnessSettings />)
    await screen.findByText('Claude Account 1')
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Move Claude Account 2 up in rotation order',
      }),
    )
    await waitFor(() => expect(saveHarnesses).toHaveBeenCalled())
  })
  it('shows add account for supported harnesses', async () => {
    render(<HarnessSettings />)
    await screen.findByText('Claude Account 1')
    expect(screen.getByRole('button', { name: /Add account/ })).toBeTruthy()
  })
})
