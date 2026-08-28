// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessConfig } from '@forge/protocol/config'
import type {
  HarnessAccountConfig,
  HarnessAccountSnapshot,
} from '@forge/protocol/accounts'
import { HarnessAccountCard } from './HarnessAccountCard'
import { TooltipProvider } from '@/components/ui/tooltip'

const harness: HarnessConfig = {
  name: 'Work Claude',
  command: 'claude',
  args: [],
  env: { CLAUDE_CONFIG_DIR: '/home/test/.forge/accounts/claude/work' },
  protocol: 'pty',
  enabled: true,
}

const snapshot = (
  patch: Partial<HarnessAccountSnapshot> = {},
): HarnessAccountSnapshot => ({
  accountId: 'work',
  harnessKind: 'claude',
  harnessKey: 'claude',
  enabled: true,
  installed: true,
  version: '1.0.0',
  status: 'ready',
  auth: { status: 'authenticated', email: 'person@example.com' },
  checkedAt: new Date().toISOString(),
  ...patch,
})

function renderCard(
  current = snapshot(),
  options: {
    expanded?: boolean
    label?: string
    config?: HarnessAccountConfig | null
    onUpdateAccount?: (patch: {
      label?: string
      disabled?: boolean
      config?: HarnessAccountConfig | null
    }) => Promise<boolean>
    onDelete?: () => void
    reorder?: {
      onMoveUp: (() => void) | undefined
      onMoveDown: (() => void) | undefined
    }
  } = {},
) {
  return render(
    <TooltipProvider>
      <HarnessAccountCard
        accountId="work"
        accountKind="claude"
        harness={harness}
        snapshot={current}
        isExpanded={options.expanded ?? false}
        onExpandedChange={vi.fn()}
        label={options.label ?? 'Work Claude'}
        config={options.config ?? null}
        onUpdateAccount={options.onUpdateAccount ?? vi.fn(async () => true)}
        {...options}
      />
    </TooltipProvider>,
  )
}

describe('HarnessAccountCard', () => {
  beforeEach(() => vi.setSystemTime(new Date('2026-08-27T12:00:00.000Z')))
  afterEach(() => cleanup())

  it('hides the limit line when the snapshot has no usage or limit', () => {
    renderCard(
      snapshot({
        auth: { status: 'unknown' },
        message: 'Checking authentication',
      }),
    )
    expect(screen.queryByText(/Usage|limit reached/)).toBeNull()
  })

  it('renders blocked and usage countdowns', () => {
    renderCard(
      snapshot({
        usage: [
          {
            window: 'five_hour',
            utilization: 82,
            resetsAt: '2026-08-27T15:00:00.000Z',
            source: 'test',
            observedAt: '2026-08-27T12:00:00.000Z',
          },
        ],
        limit: {
          kind: 'usage-limit',
          detectedAt: '2026-08-27T12:00:00.000Z',
          resetsAt: '2026-08-27T14:14:00.000Z',
          resetsAtEstimated: false,
          source: 'test',
          detail: null,
        },
      }),
    )
    expect(
      screen.getByText('Usage limit reached · resets in 2h 14m'),
    ).toBeTruthy()
    expect(screen.getByText('· Usage 82% · 5h window')).toBeTruthy()
  })

  it('renders usage without a block and redacts email until clicked', () => {
    renderCard(
      snapshot({
        usage: [
          {
            window: 'five_hour',
            utilization: 82,
            resetsAt: '2026-08-27T15:00:00.000Z',
            source: 'test',
            observedAt: '2026-08-27T12:00:00.000Z',
          },
        ],
      }),
    )
    expect(
      screen.getByText('Usage 82% · 5h window · resets in 3h'),
    ).toBeTruthy()
    const email = screen.getAllByRole('button', {
      name: 'Toggle work email visibility',
    })[0]!
    expect(email.className).toContain('blur-[2px]')
    expect(email.textContent).not.toContain('person@example.com')
    fireEvent.click(email)
    expect(email.textContent).toContain('person@example.com')
  })

  it('hides delete only when onDelete is omitted and keeps reorder buttons disabled', () => {
    renderCard(snapshot(), {
      reorder: { onMoveUp: undefined, onMoveDown: undefined },
    })
    expect(
      screen.queryByRole('button', { name: 'Delete account work' }),
    ).toBeNull()
    expect(
      screen.getByRole('button', {
        name: 'Move Work Claude up in rotation order',
      }),
    ).toHaveProperty('disabled', true)
    expect(
      screen.getByRole('button', {
        name: 'Move Work Claude down in rotation order',
      }),
    ).toHaveProperty('disabled', true)
  })

  it('shows delete when supplied and omits reorder when absent', () => {
    renderCard(snapshot(), { onDelete: vi.fn() })
    expect(
      screen.getByRole('button', { name: 'Delete account work' }),
    ).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: /Move Work Claude up/ }),
    ).toBeNull()
  })

  it('saves a changed label without saving the harness', async () => {
    const onUpdateAccount = vi.fn(async () => true)
    renderCard(snapshot({ displayName: undefined }), {
      expanded: true,
      onUpdateAccount,
    })
    fireEvent.change(screen.getByDisplayValue('Work Claude'), {
      target: { value: 'Personal Claude' },
    })
    await waitFor(() =>
      expect(onUpdateAccount).toHaveBeenCalledWith({
        label: 'Personal Claude',
      }),
    )
  })

  it('restores a label after a failed save and reports the error', async () => {
    const onUpdateAccount = vi.fn(async () => false)
    renderCard(snapshot({ displayName: undefined }), {
      expanded: true,
      onUpdateAccount,
    })
    fireEvent.change(screen.getByDisplayValue('Work Claude'), {
      target: { value: 'Broken' },
    })
    await waitFor(() =>
      expect(screen.getByText('Could not save label.')).toBeTruthy(),
    )
    expect(screen.getByDisplayValue('Work Claude')).toBeTruthy()
  })

  it('updates the account disabled state from the switch', async () => {
    const onUpdateAccount = vi.fn(async () => true)
    renderCard(snapshot(), { onUpdateAccount })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Work Claude' }))
    await waitFor(() =>
      expect(onUpdateAccount).toHaveBeenCalledWith({ disabled: true }),
    )
  })

  it('renders no fields for Claude and the OpenCode account fields', () => {
    renderCard(snapshot(), { expanded: true })
    expect(screen.queryByText('Provider')).toBeNull()
    cleanup()
    render(
      <TooltipProvider>
        <HarnessAccountCard
          accountId="open"
          accountKind="opencode"
          harness={{ ...harness, command: 'opencode' }}
          snapshot={snapshot({ accountId: 'open', harnessKind: 'opencode' })}
          label="OpenCode"
          config={null}
          isExpanded
          onExpandedChange={vi.fn()}
          onUpdateAccount={vi.fn(async () => true)}
        />
      </TooltipProvider>,
    )
    expect(screen.getByText('Provider')).toBeTruthy()
    expect(screen.getByText('Agent')).toBeTruthy()
    expect(screen.getByText('Variant')).toBeTruthy()
  })
})
