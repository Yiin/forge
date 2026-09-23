import { describe, expect, it } from 'vitest'
import type { HarnessConfig } from '@forge/protocol/config'
import {
  accountCountLabel,
  buildAgentRows,
  harnessBlurb,
  installHint,
  LAST_ENABLED_REASON,
  visibleHarnessKeys,
  withHarnessEnabled,
} from './agents-settings-logic'

const harness = (
  command: string,
  enabled = true,
  extra: Partial<HarnessConfig> = {},
): HarnessConfig => ({
  name: command,
  command,
  args: [],
  env: {},
  protocol: 'pty',
  enabled,
  ...extra,
})

describe('visibleHarnessKeys', () => {
  it('keeps config order and hides mock next to real agents', () => {
    expect(
      visibleHarnessKeys({
        codex: harness('codex'),
        mock: harness('mock'),
        claude: harness('claude'),
      }),
    ).toEqual(['codex', 'claude'])
  })

  it('shows mock when it is the only agent', () => {
    expect(visibleHarnessKeys({ mock: harness('mock') })).toEqual(['mock'])
  })
})

describe('harnessBlurb', () => {
  it('describes known agents by kind', () => {
    expect(harnessBlurb('claude', harness('claude'))).toBe(
      "Anthropic's coding agent, driven through the Claude Code CLI.",
    )
    expect(harnessBlurb('work', harness('cursor-agent'))).toBe(
      "Cursor's coding agent (cursor-agent CLI).",
    )
    expect(harnessBlurb('g', harness('gemini'))).toBe(
      "Google's Gemini CLI agent.",
    )
  })

  it('falls back to the protocol for custom agents', () => {
    expect(
      harnessBlurb('custom', harness('my-agent', true, { protocol: 'acp' })),
    ).toBe('Custom agent (ACP protocol).')
  })
})

it('words the install hint by enabled state', () => {
  expect(installHint('pi', false)).toBe('Install the pi CLI to enable')
  expect(installHint('/usr/local/bin/pi', false)).toBe(
    'Install the pi CLI to enable',
  )
  expect(installHint('pi', true)).toBe(
    'pi CLI not installed — turn it off or install it',
  )
})

it('labels account counts', () => {
  expect(accountCountLabel(0)).toBe('No accounts')
  expect(accountCountLabel(1)).toBe('1 account')
  expect(accountCountLabel(3)).toBe('3 accounts')
})

describe('buildAgentRows toggle rules', () => {
  const locked = (rows: ReturnType<typeof buildAgentRows>) =>
    Object.fromEntries(rows.map((row) => [row.key, row.lockedReason]))

  it('blocks turning on an agent whose CLI is missing', () => {
    const rows = buildAgentRows(
      { claude: harness('claude'), pi: harness('pi', false) },
      {
        claude: { installed: true, accountCount: 1 },
        pi: { installed: false, accountCount: 0 },
      },
    )
    expect(locked(rows)).toEqual({
      claude: LAST_ENABLED_REASON,
      pi: 'Install the pi CLI to enable',
    })
  })

  it('always allows turning off an enabled agent whose CLI is missing', () => {
    const rows = buildAgentRows(
      { claude: harness('claude'), codex: harness('codex') },
      {
        claude: { installed: true, accountCount: 0 },
        codex: { installed: false, accountCount: 0 },
      },
    )
    expect(locked(rows)).toEqual({
      claude: LAST_ENABLED_REASON,
      codex: null,
    })
    expect(rows[1].installHint).toBe(
      'codex CLI not installed — turn it off or install it',
    )
  })

  it('allows turning off any agent while another runnable one stays on', () => {
    const rows = buildAgentRows(
      { claude: harness('claude'), codex: harness('codex') },
      {
        claude: { installed: true, accountCount: 0 },
        codex: { installed: true, accountCount: 0 },
      },
    )
    expect(locked(rows)).toEqual({ claude: null, codex: null })
  })

  it('treats agents missing from health as installed', () => {
    const [row] = buildAgentRows({ claude: harness('claude', false) }, {})
    expect(row.installed).toBe(true)
    expect(row.lockedReason).toBeNull()
  })

  it('counts accounts only for account-capable agents', () => {
    const rows = buildAgentRows(
      { claude: harness('claude'), hermes: harness('hermes') },
      {
        claude: { installed: true, accountCount: 2 },
        hermes: { installed: true, accountCount: 0 },
      },
    )
    expect(rows.map((row) => row.accountCount)).toEqual([2, null])
  })
})

it('flips one entry and keeps the rest of the map', () => {
  const config = { claude: harness('claude'), codex: harness('codex') }
  const next = withHarnessEnabled(config, 'codex', false)
  expect(next.codex.enabled).toBe(false)
  expect(next.claude).toBe(config.claude)
  expect(config.codex.enabled).toBe(true)
})
